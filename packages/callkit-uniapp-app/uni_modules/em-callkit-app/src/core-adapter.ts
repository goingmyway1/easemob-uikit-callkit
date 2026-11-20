import {
  CALL_TYPE,
  CallKitCore,
  type CallKitEvent,
  type RtcAdapter
} from '@easemob-community/callkit-core-v5'
import { createSDK5IMAdapter, type SDK5ChatClient, type SDK5IMAdapter } from './im/SDK5IMConnectionAdapter'
import { createAgoraAppRtcAdapter } from './rtc/AgoraAppRtcAdapter'
import type { AgoraSessionFactory, AgoraUidUser } from './rtc/types'
import { createCallUiBridge, type CallUiBridge, type RtcOwnership } from './ui/callUiBridge'

export interface CreateUniappAppCallKitOptions {
  /** 已登录的 easemob-websdk 5.x ChatClient */
  client: SDK5ChatClient
  /**
   * 宿主注入：() => new RtcCallSession()
   * `rtcOwnership: 'component'` 时可不传（RTC 由 agora-rtc 的 UI 组件自建）。
   */
  createRtcSession?: AgoraSessionFactory
  /**
   * RTC 所有权，默认 `'adapter'`，保持既有接入方行为不变。
   * 传 `'component'` 时不创建 AgoraAppRtcAdapter，改由 `callUi` 桥接层驱动 agora-rtc 默认 UI。
   */
  rtcOwnership?: RtcOwnership
  /** 当前用户资料 */
  userProfile?: {
    userId: string
    nickname?: string
    avatarURL?: string
  }
  /** 群聊已知参与者，提前建立数字 UID 与 userId 映射 */
  knownParticipants?: AgoraUidUser[]
  /** RTC Token 响应缺少 appId 时的兜底 */
  defaultRtcAppId?: string
  /** 通话事件回调 */
  onEvent?: (event: CallKitEvent) => void
  /** 可选 RTC 适配器，用于测试或自定义能力 */
  rtcAdapter?: RtcAdapter
  /** `rtcOwnership: 'component'` 时用于补全对方昵称头像 */
  resolveProfile?: (userId: string) => { nickname?: string; avatarURL?: string } | undefined
  logger?: (message: string, data?: unknown) => void
}

export interface UniappAppCallKit {
  core: CallKitCore
  imAdapter: SDK5IMAdapter
  /** `rtcOwnership: 'component'` 时为 undefined（RTC 由 UI 组件持有） */
  rtcAdapter?: RtcAdapter
  /** `rtcOwnership: 'component'` 时存在，用于驱动 agora-rtc 默认 UI */
  callUi?: CallUiBridge
  /** 账号切换：先更新 SDK5 ChatClient，再热更新 Core */
  updateClient: (client: SDK5ChatClient) => void
  /** 先释放 RTC，再销毁 Core 事件监听 */
  dispose: () => Promise<void>
}

function isVideoCallType(callType: CALL_TYPE | null): boolean {
  return callType === CALL_TYPE.VIDEO_1V1 || callType === CALL_TYPE.VIDEO_MULTI
}

/**
 * 创建 UniApp Android/iOS CallKit 实例。
 *
 * 两种 RTC 归属，二选一，不可同时使用：
 *
 * - `rtcOwnership: 'adapter'`（默认）：RTC 指令只由 CallKitCore 自动调用 rtcAdapter 触发；
 *   平台层不要手工处理 shouldJoinRtc/shouldPublishTracks/shouldLeaveRtc。
 * - `rtcOwnership: 'component'`：不创建 rtcAdapter，Core 只走信令；平台层用 `callUi`
 *   桥接层把 shouldJoinRtc 翻译成 agora-rtc 组件的 props 与命令。
 *   同时挂载 adapter 与组件会让两个 RtcCallSession 争同一个 Agora Engine，属未定义行为。
 */
export function createUniappAppCallKit(options: CreateUniappAppCallKitOptions): UniappAppCallKit {
  if (!options || !options.client) {
    throw new TypeError('[createUniappAppCallKit] client 必传')
  }

  const ownership: RtcOwnership = options.rtcOwnership ?? 'adapter'
  if (ownership !== 'adapter' && ownership !== 'component') {
    throw new TypeError(`[createUniappAppCallKit] rtcOwnership 只能是 'adapter' 或 'component'，收到: ${String(ownership)}`)
  }
  if (ownership === 'adapter' && typeof options.createRtcSession !== 'function' && !options.rtcAdapter) {
    throw new TypeError('[createUniappAppCallKit] createRtcSession 或 rtcAdapter 必传')
  }

  const imAdapter = createSDK5IMAdapter(options.client)
  let core!: CallKitCore
  let callUi: CallUiBridge | undefined
  let disposed = false

  const ownedRtcAdapter =
    ownership === 'component' || options.rtcAdapter
      ? null
      : createAgoraAppRtcAdapter({
          createSession: options.createRtcSession as AgoraSessionFactory,
          knownParticipants: options.knownParticipants,
          defaultAppId: options.defaultRtcAppId,
          resolveCallType: () => (isVideoCallType(core?.getCurrentCallType() ?? null) ? 'video' : 'audio'),
          resolveUserId: async (uid) => {
            const result = await imAdapter.connection.getUserIdByRTCUIds([uid])
            return result?.data?.[String(uid)]
          },
          logger: options.logger
        })

  const rtcAdapter = ownership === 'component' ? undefined : options.rtcAdapter || ownedRtcAdapter!

  core = new CallKitCore({
    imClient: imAdapter.connection,
    userProfile: options.userProfile,
    // 'component' 时显式不传，Core 内部 handleRtcEvent 有 if (!adapter) return 守卫
    ...(rtcAdapter ? { rtcAdapter } : {}),
    createMessage: (payload: any) => imAdapter.createMessage(payload),
    onEvent: (event) => {
      callUi?.handleEvent(event)
      options.onEvent?.(event)
    }
  })

  ownedRtcAdapter?.setReportHandler((report) => {
    core.reportRtcEvent(report)
  })

  if (ownership === 'component') {
    callUi = createCallUiBridge({
      core,
      defaultRtcAppId: options.defaultRtcAppId,
      localUserId: options.userProfile?.userId,
      resolveProfile: options.resolveProfile,
      resolveRtcUserId: async (uid) => {
        const known = options.knownParticipants?.find((participant) => String(participant.uid) === String(uid))
        if (known?.userId) return known.userId
        const result = await imAdapter.connection.getUserIdByRTCUIds([uid])
        return result?.data?.[String(uid)]
      },
      onError: (error, context) => {
        options.logger?.(`[createUniappAppCallKit] ${context} 失败`, error)
      },
      logger: options.logger
    })
  }

  return {
    core,
    imAdapter,
    rtcAdapter,
    callUi,
    updateClient(nextClient: SDK5ChatClient) {
      if (disposed) throw new Error('[createUniappAppCallKit] 实例已销毁')
      imAdapter.updateClient(nextClient)
      core.updateImClient(imAdapter.connection)
    },
    async dispose() {
      if (disposed) return
      disposed = true
      callUi?.dispose()
      if (ownedRtcAdapter) await ownedRtcAdapter.dispose()
      await core.destroy()
    }
  }
}
