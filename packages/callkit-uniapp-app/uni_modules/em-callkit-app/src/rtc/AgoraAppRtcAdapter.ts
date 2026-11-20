import type { JoinRtcParams, RtcAdapter, RtcReport } from '@easemob-community/callkit-core-v5'
import type {
  AgoraRtcSession,
  AgoraSessionFactory,
  AgoraUidUser,
  AppMediaType
} from './types'

export interface AgoraAppRtcAdapterOptions {
  /** 宿主提供：() => new RtcCallSession() */
  createSession: AgoraSessionFactory
  /** 从 CallKit 当前通话类型解析，默认 audio，避免语音通话误开摄像头 */
  resolveCallType?: () => 'audio' | 'video'
  /** 通过 SDK5 getUserIdsWithRTCUids 获取数字 UID 对应 userId */
  resolveUserId?: (uid: number) => Promise<string | undefined> | string | undefined
  /** 群聊入房前已知的 UID 映射 */
  knownParticipants?: AgoraUidUser[]
  /** Core 未提供 appId 时的兜底；通常应使用服务端返回的 RTC App ID */
  defaultAppId?: string
  /** 延迟绑定 Core.reportRtcEvent */
  onReport?: (report: RtcReport) => void
  logger?: (message: string, data?: unknown) => void
}

const REMOTE_MEDIA_DECODING = 2
const REMOTE_MEDIA_STOPPED = 0
const REMOTE_MEDIA_FAILED = 4
const CONNECTION_FAILED = 5
const RTC_UID_MAX = 2147483647

function toRtcUid(value: number | string): number {
  const uid = typeof value === 'number' ? value : Number(value)
  if (!Number.isInteger(uid) || uid < 0 || uid > RTC_UID_MAX) {
    throw new TypeError(`[AgoraAppRtcAdapter] 非法 RTC UID: ${String(value)}`)
  }
  return uid
}

function cancelledError(operation: string): Error {
  const error = new Error(`[AgoraAppRtcAdapter] ${operation} 已取消：通话代际已变化`)
  error.name = 'CallKitRtcCancelledError'
  return error
}

function unsupportedError(operation: string): Error {
  return new Error(
    `[AgoraAppRtcAdapter] ${operation} 不支持：当前 agora-rtc 插件没有暴露该能力；` +
      '需要先扩展 UTS 原生桥接，不能静默忽略'
  )
}

/**
 * CallKit RtcAdapter 的 UniApp App 实现。
 *
 * 只负责 RTC 生命周期和事件转换，不维护通话业务状态机。
 * 所有命令串行执行，并用 generation 隔离旧通话的异步结果。
 */
export class AgoraAppRtcAdapter implements RtcAdapter {
  private readonly createSession: AgoraSessionFactory
  private readonly resolveCallType: () => 'audio' | 'video'
  private readonly resolveUserId?: (uid: number) => Promise<string | undefined> | string | undefined
  private readonly defaultAppId?: string
  private readonly logger?: (message: string, data?: unknown) => void
  private readonly uidToUserId = new Map<number, string>()
  private session: AgoraRtcSession | null = null
  private unsubscribers: Array<() => void> = []
  private reportHandler?: (report: RtcReport) => void
  private operationQueue: Promise<void> = Promise.resolve()
  private generation = 0
  private disposed = false
  private joined = false
  private joinedUid?: number

  constructor(options: AgoraAppRtcAdapterOptions) {
    if (!options || typeof options.createSession !== 'function') {
      throw new TypeError('[AgoraAppRtcAdapter] createSession 必传')
    }
    this.createSession = options.createSession
    this.resolveCallType = options.resolveCallType || (() => 'audio')
    this.resolveUserId = options.resolveUserId
    this.defaultAppId = options.defaultAppId?.trim() || undefined
    this.reportHandler = options.onReport
    this.logger = options.logger
    ;(options.knownParticipants || []).forEach((participant) => this.mapUser(participant.uid, participant.userId))
  }

  /** Core 创建后回填，避免 adapter 与 core 构造循环依赖 */
  setReportHandler(handler: (report: RtcReport) => void): void {
    this.reportHandler = handler
  }

  updateKnownParticipants(participants: AgoraUidUser[]): void {
    ;(participants || []).forEach((participant) => this.mapUser(participant.uid, participant.userId))
  }

  async joinChannel(params: JoinRtcParams): Promise<void> {
    this.assertNotDisposed()
    const uid = toRtcUid(params.uid)
    const channel = String(params.channel || '').trim()
    if (!channel) throw new TypeError('[AgoraAppRtcAdapter] joinChannel 缺少 channel')

    const appId = String(params.appId || this.defaultAppId || '').trim()
    if (!appId) {
      throw new TypeError(
        '[AgoraAppRtcAdapter] 缺少 RTC App ID，请确保 getRTCTokenInfo 返回 appId 或配置 defaultAppId'
      )
    }

    const callType = this.resolveCallType()
    const isVideo = callType === 'video'
    const generation = ++this.generation

    // 立即作废旧会话的异步流程，真正的 dispose 进入队列串行执行。
    const previous = this.session
    previous?.cancelPendingOperations()
    this.detachSessionEvents()
    this.session = null
    this.joined = false
    this.joinedUid = undefined

    await this.enqueue(async () => {
      // Captured resources must be released even if this replacement was already cancelled.
      if (previous) {
        try {
          await previous.dispose()
        } catch (error) {
          this.log('old session dispose failed', error)
        }
      }
      this.assertGeneration(generation, 'joinChannel')

      const session = this.createSession()
      this.session = session
      this.attachSessionEvents(session, generation)

      try {
        const result = await session.join({
          appId,
          channelName: channel,
          token: params.token || undefined,
          uid,
          publishAudio: true,
          publishVideo: isVideo,
          autoSubscribeAudio: true,
          autoSubscribeVideo: isVideo,
          permissionOptions: { audio: true, video: isVideo },
          initialAudioMuted: false,
          initialVideoMuted: !isVideo
        })

        if (generation !== this.generation || this.session !== session) {
          throw cancelledError('joinChannel')
        }

        this.joined = true
        this.joinedUid = result?.uid ?? uid
        this.reportJoined(this.joinedUid, generation)
      } catch (error) {
        if (this.session === session) {
          this.detachSessionEvents()
          this.session = null
          this.joined = false
        }
        // join reject 后原生引擎仍可能持有麦克风/摄像头；取消与普通失败都必须释放。
        try {
          await session.dispose()
        } catch (disposeError) {
          this.log('join failed; session dispose failed', disposeError)
        }
        throw error
      }
    })
  }

  async leaveChannel(): Promise<void> {
    this.assertNotDisposed()
    const generation = ++this.generation
    const session = this.session
    const wasJoined = this.joined
    const uid = this.joinedUid

    session?.cancelPendingOperations()
    this.detachSessionEvents()
    this.session = null
    this.joined = false
    this.joinedUid = undefined

    await this.enqueue(async () => {
      // 资源释放与代际无关：只要拿到了旧 session 就必须 leave + dispose。
      // 挂断后立刻重呼时 join 已让 generation 自增，若这里提前 return，
      // 旧 session 既不 leave 也不 dispose，原生摄像头/麦克风句柄会一直不释放。
      if (!session) return

      try {
        await session.leave()
      } catch (error) {
        this.log('session leave failed; disposing anyway', error)
      } finally {
        await session.dispose().catch((error) => this.log('session dispose failed', error))
      }

      // 只有「上报 rtcLeft」需要代际判断：旧代际的离开事件不该通知新通话
      if (wasJoined && generation === this.generation) {
        this.report({ type: 'rtcLeft', payload: { uid } })
      }
    })
  }

  publishLocalTracks(types: AppMediaType[]): Promise<void> {
    this.assertNotDisposed()
    const generation = this.generation
    return this.enqueue(async () => {
      this.assertGeneration(generation, 'publishLocalTracks')
      const session = this.requireJoinedSession('publishLocalTracks')
      for (const type of types) {
        if (type === 'audio') {
          await session.enableLocalAudio(true)
          await session.muteLocalAudio(false)
        } else {
          await session.enableLocalVideo(true)
          await session.startPreview()
          await session.muteLocalVideo(false)
        }
      }
    })
  }

  unpublishLocalTracks(types: AppMediaType[]): Promise<void> {
    this.assertNotDisposed()
    const generation = this.generation
    return this.enqueue(async () => {
      this.assertGeneration(generation, 'unpublishLocalTracks')
      const session = this.requireJoinedSession('unpublishLocalTracks')
      for (const type of types) {
        if (type === 'audio') {
          await session.muteLocalAudio(true)
        } else {
          await session.muteLocalVideo(true)
        }
      }
    })
  }

  async subscribeRemoteUser(_userId: string, _mediaType: AppMediaType): Promise<void> {
    throw unsupportedError('subscribeRemoteUser')
  }

  async unsubscribeRemoteUser(_userId: string, _mediaType: AppMediaType): Promise<void> {
    throw unsupportedError('unsubscribeRemoteUser')
  }

  setAudioEnabled(enabled: boolean): Promise<void> {
    this.assertNotDisposed()
    const generation = this.generation
    return this.enqueue(async () => {
      this.assertGeneration(generation, 'setAudioEnabled')
      const session = this.requireJoinedSession('setAudioEnabled')
      await session.muteLocalAudio(!enabled)
    })
  }

  setVideoEnabled(enabled: boolean): Promise<void> {
    this.assertNotDisposed()
    const generation = this.generation
    return this.enqueue(async () => {
      this.assertGeneration(generation, 'setVideoEnabled')
      const session = this.requireJoinedSession('setVideoEnabled')

      if (enabled) {
        await session.enableLocalVideo(true)
        await session.startPreview()
        await session.muteLocalVideo(false)
      } else {
        // 关闭摄像头必须同时停预览 + mute：只调 enableLocalVideo(false) 会留下采集/指示灯，
        // 且与 unpublishLocalTracks 的 mute 语义不一致，真机行为难以预测
        await session.muteLocalVideo(true)
        if (typeof session.stopPreview === 'function') {
          await session.stopPreview()
        }
        await session.enableLocalVideo(false)
      }
    })
  }

  /**
   * 前后置摄像头切换。
   * App 端 agora 插件只暴露无参的 switchCamera()，没有设备选择能力；
   * 传入 deviceId 会被忽略，这里显式留痕，避免调用方误以为已切到指定设备。
   */
  switchCamera(deviceId?: string): Promise<void> {
    this.assertNotDisposed()
    if (deviceId) this.log('switchCamera 忽略 deviceId：App 端仅支持前后置切换', { deviceId })
    const generation = this.generation
    return this.enqueue(async () => {
      this.assertGeneration(generation, 'switchCamera')
      await this.requireJoinedSession('switchCamera').switchCamera()
    })
  }

  async switchMicrophone(_deviceId: string): Promise<void> {
    throw unsupportedError('switchMicrophone')
  }

  switchAudioOutput(device: 'speaker' | 'earpiece'): Promise<void> {
    this.assertNotDisposed()
    const generation = this.generation
    return this.enqueue(async () => {
      this.assertGeneration(generation, 'switchAudioOutput')
      await this.requireJoinedSession('switchAudioOutput').setSpeakerphoneEnabled(device === 'speaker')
    })
  }

  get isJoined(): boolean {
    return this.joined && !this.disposed
  }

  /** 永久释放；Core.destroy() 之后由宿主调用 */
  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    const generation = ++this.generation
    const session = this.session
    session?.cancelPendingOperations()
    this.detachSessionEvents()
    this.session = null
    this.joined = false
    this.joinedUid = undefined

    await this.enqueue(async () => {
      if (generation !== this.generation) return
      if (session) await session.dispose().catch((error) => this.log('dispose failed', error))
    })
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.operationQueue.then(task, task)
    this.operationQueue = run.then(
      () => undefined,
      () => undefined
    )
    return run
  }

  private assertNotDisposed(): void {
    if (this.disposed) throw new Error('[AgoraAppRtcAdapter] 适配器已销毁')
  }

  private assertGeneration(generation: number, operation: string): void {
    if (this.disposed || generation !== this.generation) {
      throw cancelledError(operation)
    }
  }

  private requireJoinedSession(operation: string): AgoraRtcSession {
    if (!this.joined || !this.session) {
      throw new Error(`[AgoraAppRtcAdapter] ${operation} 前必须先成功加入频道`)
    }
    return this.session
  }

  private attachSessionEvents(session: AgoraRtcSession, generation: number): void {
    const guard =
      (handler: (...args: any[]) => void) =>
      (data?: unknown) => {
        if (this.disposed || generation !== this.generation || session !== this.session) return
        handler(data)
      }

    this.unsubscribers = [
      session.on(
        'joinChannelSuccess',
        guard((data: { uid?: number }) => {
          if (typeof data?.uid === 'number') this.joinedUid = data.uid
          this.reportJoined(this.joinedUid, generation)
        })
      ),
      session.on(
        'userJoined',
        guard((data: { uid: number }) => {
          void this.reportRemoteUser('userJoined', data.uid, generation)
        })
      ),
      session.on(
        'userOffline',
        guard((data: { uid: number }) => {
          void this.reportRemoteUser('userLeft', data.uid, generation)
        })
      ),
      session.on(
        'remoteAudioStateChanged',
        guard((data: { uid: number; state: number }) => {
          if (data.state === REMOTE_MEDIA_DECODING) {
            void this.reportRemoteUser('userAudioUnmuted', data.uid, generation)
          } else if (data.state === REMOTE_MEDIA_STOPPED || data.state === REMOTE_MEDIA_FAILED) {
            void this.reportRemoteUser('userAudioMuted', data.uid, generation)
          }
        })
      ),
      session.on(
        'remoteVideoStateChanged',
        guard((data: { uid: number; state: number }) => {
          if (data.state === REMOTE_MEDIA_DECODING) {
            void this.reportRemoteUser('userVideoUnmuted', data.uid, generation)
          } else if (data.state === REMOTE_MEDIA_STOPPED || data.state === REMOTE_MEDIA_FAILED) {
            void this.reportRemoteUser('userVideoMuted', data.uid, generation)
          }
        })
      ),
      session.on(
        'connectionStateChanged',
        guard((data: { state: number; reason: number }) => {
          if (data.state !== CONNECTION_FAILED) return
          this.report({
            type: 'error',
            payload: {
              error: 'RTC 连接失败',
              errorCode: data.reason
            }
          })
        })
      ),
      session.on(
        'error',
        guard((data: { code: number; message?: string }) => {
          this.report({
            type: 'error',
            payload: {
              error: data.message || 'RTC 原生错误',
              errorCode: data.code
            }
          })
        })
      )
    ]
  }

  private detachSessionEvents(): void {
    this.unsubscribers.forEach((unsubscribe) => {
      try {
        unsubscribe()
      } catch (error) {
        this.log('unsubscribe failed', error)
      }
    })
    this.unsubscribers = []
  }

  private async reportRemoteUser(
    type: 'userJoined' | 'userLeft' | 'userAudioMuted' | 'userAudioUnmuted' | 'userVideoMuted' | 'userVideoUnmuted',
    uid: number,
    generation: number
  ): Promise<void> {
    if (generation !== this.generation) return
    let userId = this.uidToUserId.get(uid)
    if (!userId && this.resolveUserId) {
      try {
        userId = await this.resolveUserId(uid)
        if (userId) this.uidToUserId.set(uid, userId)
      } catch (error) {
        this.log('resolve RTC UID failed', { uid, error })
      }
    }
    if (generation !== this.generation || this.disposed) return
    if (type === 'userLeft') this.uidToUserId.delete(uid)
    this.report({
      type,
      payload: { uid, userId }
    })
  }

  private reportJoined(uid: number | undefined, generation: number): void {
    if (generation !== this.generation || !this.joined) return
    this.report({
      type: 'rtcJoined',
      payload: { uid, userId: uid === undefined ? undefined : this.uidToUserId.get(uid) }
    })
  }

  private mapUser(uid: number | string, userId: string): void {
    try {
      if (userId) this.uidToUserId.set(toRtcUid(uid), userId)
    } catch (error) {
      this.log('ignore invalid known participant', { uid, userId, error })
    }
  }

  private report(report: RtcReport): void {
    try {
      this.reportHandler?.(report)
    } catch (error) {
      this.log('report handler failed', error)
    }
  }

  private log(message: string, data?: unknown): void {
    this.logger?.('[AgoraAppRtcAdapter] ' + message, data)
  }
}

export function createAgoraAppRtcAdapter(options: AgoraAppRtcAdapterOptions): AgoraAppRtcAdapter {
  return new AgoraAppRtcAdapter(options)
}
