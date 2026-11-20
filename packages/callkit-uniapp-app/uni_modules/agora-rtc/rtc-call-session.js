import * as rtc from './index.js'
import {
  CALL_STATE,
  RTC_ERROR_CATEGORY,
  RTC_EVENT
} from './rtc-constants.js'
import {
  RtcError,
  createConnectionError
} from './rtc-errors.js'
import { rtcLogger } from './rtc-logger.js'

/**
 * 无头单频道通话控制器。
 *
 * 负责权限、Engine 初始化、真实入房等待、离开、设备操作和资源释放；不依赖 Vue、
 * 组件 refs、Toast 或路由。每个宿主创建一个实例，并在宿主销毁时调用 dispose()。
 *
 * generation 是异步操作的代际标识：dispose() / cancelPendingOperations() 后递增，
 * 使旧流程在每个 await 后失效，防止页面已退出仍继续初始化、开启预览或更新状态。
 *
 * owner 是 Engine 所有权令牌：dispose() 只销毁自己持有的 Engine，避免旧页面的
 * 延迟销毁破坏新页面刚创建的通话。
 */
export class RtcCallSession {
  constructor() {
    this.owner = {}
    this.appId = ''
    this.state = CALL_STATE.IDLE
    this.error = null
    this.initialized = false
    // 连接失败后 Session 会进入 failed，但原生频道可能仍需显式 leave 清理。
    this.channelActive = false
    this.disposed = false
    this.generation = 0
    this.leavePromise = null
    this.unsubscribers = new Set()
    this.subscriptionMeta = new Map()
    this.stateListeners = new Set()
  }

  get engineReady() {
    return this.initialized && !this.disposed
  }

  get joining() {
    return this.state === CALL_STATE.JOINING
  }

  get joined() {
    return this.state === CALL_STATE.JOINED
  }

  /**
   * 状态变化订阅。UI 应从这里派生展示状态，而不是自行维护第二套状态机。
   * 返回退订函数；dispose() 会清理全部状态订阅。
   */
  onStateChange(callback) {
    if (typeof callback !== 'function') throw new TypeError('callback must be a function')
    this.stateListeners.add(callback)
    let active = true
    return () => {
      if (!active) return
      active = false
      this.stateListeners.delete(callback)
    }
  }

  setState(state) {
    if (this.state === state) return
    const previous = this.state
    this.state = state
    rtc.rtcLogger.info('SESSION STATE', { previous, state })
    this.stateListeners.forEach((listener) => {
      try {
        listener(state, previous)
      } catch (error) {
        console.error('[agora-rtc] state listener failed', error)
      }
    })
  }

  /** 统一将销毁/代际变化转换为 cancelled，避免被 UI 误报为网络错误。 */
  assertActive(generation = this.generation) {
    if (this.disposed || generation !== this.generation) {
      throw new RtcError('通话操作已取消', {
        category: RTC_ERROR_CATEGORY.CANCELLED
      })
    }
  }

  startLeaveCleanup() {
    if (this.leavePromise) return this.leavePromise
    const promise = rtc.leaveChannel(this.owner)
    this.leavePromise = promise
    // cancelPendingOperations() 是同步 API；保留拒绝供 leave() 等待，同时避免无处理拒绝。
    promise.catch(() => {})
    const clear = () => {
      if (this.leavePromise === promise) this.leavePromise = null
    }
    promise.then(clear, clear)
    return promise
  }

  /**
   * 作废当前异步流程，但不释放 Engine。
   *
   * 用于宿主在权限/初始化/入房等待阶段点“结束通话”：递增 generation 后，
   * 旧流程会在下一个 await 处收到 cancelled，不会再入房；Engine 保留以便重试。
   */
  cancelPendingOperations() {
    if (this.disposed) return
    const shouldLeave = this.state === CALL_STATE.JOINING
    this.generation += 1
    // 设备 await 或原生入房等待期间取消，也要清理已提交/可能迟到的连接。
    if (shouldLeave) this.startLeaveCleanup()
    if (
      this.state === CALL_STATE.REQUESTING_PERMISSION ||
      this.state === CALL_STATE.INITIALIZING ||
      this.state === CALL_STATE.JOINING
    ) {
      this.setState(this.initialized ? CALL_STATE.READY : CALL_STATE.IDLE)
    }
  }

  /**
   * 订阅 Facade 事件并记录退订函数。
   * dispose() 只清理本 Session 的订阅，不影响随后创建的其他 Session。
   */
  on(event, callback) {
    const unsubscribe = rtc.on(event, callback)
    let active = true
    const tracked = () => {
      if (!active) return
      active = false
      unsubscribe()
      this.unsubscribers.delete(tracked)
      this.subscriptionMeta.delete(tracked)
    }
    this.unsubscribers.add(tracked)
    this.subscriptionMeta.set(tracked, {
      event,
      callback
    })
    return tracked
  }

  /** 移除指定订阅；省略 callback 时移除本 Session 在该事件上的全部订阅。 */
  off(event, callback) {
    const targets = []
    this.subscriptionMeta.forEach((meta, tracked) => {
      if (meta.event !== event) return
      if (callback && meta.callback !== callback) return
      targets.push(tracked)
    })
    // Session 只能移除自己的订阅；未匹配时绝不能退化为全局 rtc.off()。
    targets.forEach((tracked) => tracked())
  }

  /**
   * 按场景申请权限并初始化 Engine。
   * 语音场景必须传 { audio: true, video: false }，避免申请无关摄像头权限。
   * 已初始化的实例不允许静默切换 App ID，也不允许在 Engine 被新 Session 接管后继续使用。
   */
  async initialize(appId, permissionOptions = {
    audio: true,
    video: true
  }) {
    const normalizedAppId = String(appId || '').trim()
    if (!normalizedAppId) {
      throw new RtcError('App ID 不能为空', {
        category: RTC_ERROR_CATEGORY.PARAMETER,
        operation: 'initialize'
      })
    }
    if (this.initialized) {
      if (this.appId && this.appId !== normalizedAppId) {
        throw new RtcError('App ID 已变更，请先 dispose() 后创建新的 Session', {
          category: RTC_ERROR_CATEGORY.STATE,
          operation: 'initialize'
        })
      }
      if (!rtc.isEngineOwner(this.owner)) {
        throw new RtcError('RTC Engine 已被其他通话接管，请结束当前通话后重试', {
          category: RTC_ERROR_CATEGORY.STATE,
          operation: 'initialize'
        })
      }
      return
    }
    const generation = this.generation
    this.assertActive(generation)
    try {
      this.setState(CALL_STATE.REQUESTING_PERMISSION)
      await rtc.requestPermissionsOrThrow(permissionOptions)
      this.assertActive(generation)
      this.setState(CALL_STATE.INITIALIZING)
      await rtc.initialize(normalizedAppId, this.owner)
      // 原生初始化已经成功后先记录事实，避免取消流程遗漏 Engine 清理。
      this.initialized = true
      this.appId = normalizedAppId
      try {
        this.assertActive(generation)
      } catch (error) {
        this.initialized = false
        this.appId = ''
        // dispose() 已排队销毁时无需重复销毁；普通 cancel 则释放本次新建 Engine。
        if (!this.disposed) await rtc.destroy(this.owner)
        throw error
      }
      this.error = null
      this.setState(CALL_STATE.READY)
    } catch (error) {
      if (!this.disposed && generation === this.generation) {
        this.error = error
        this.setState(CALL_STATE.FAILED)
      }
      throw error
    }
  }

  /**
   * 完成一次完整入房，resolve 时表示已经收到 joinChannelSuccess。
   * 音频始终启用；只有发布或订阅视频时才初始化本地视频与预览。
   * 初始化失败可重试；已 dispose 的实例不可复用，应创建新 Session。
   */
  async join(options) {
    const generation = this.generation
    this.assertActive(generation)
    if (![CALL_STATE.IDLE, CALL_STATE.READY, CALL_STATE.FAILED].includes(this.state)) {
      throw new RtcError('当前状态不允许重复入房，请先离开当前频道', {
        category: RTC_ERROR_CATEGORY.STATE,
        operation: 'joinChannel'
      })
    }
    await this.initialize(options.appId, options.permissionOptions)
    this.assertActive(generation)
    this.assertEngineOwner('joinChannel')
    try {
      // 断线失败后的重试先清理旧频道，避免在 JOINED 原生状态上重复 join。
      if (this.channelActive) {
        await rtc.leaveChannel(this.owner)
        this.assertActive(generation)
        this.assertEngineOwner('joinChannel')
        this.channelActive = false
      }
      this.setState(CALL_STATE.JOINING)
      const publishVideo = options.publishVideo !== false
      const initialAudioMuted = Boolean(options.initialAudioMuted)
      const initialVideoMuted = Boolean(options.initialVideoMuted)
      await rtc.enableLocalAudio(true, this.owner)
      this.assertActive(generation)
      // 初始静音必须在原生 join 前生效，避免入房后短暂发布音视频。
      await rtc.muteLocalAudio(initialAudioMuted, this.owner)
      this.assertActive(generation)
      this.assertEngineOwner('joinChannel')
      if (publishVideo || options.autoSubscribeVideo !== false) {
        await rtc.enableLocalVideo(!initialVideoMuted, this.owner)
        this.assertActive(generation)
        if (!initialVideoMuted) {
          await rtc.startPreview(this.owner)
          this.assertActive(generation)
        }
        await rtc.muteLocalVideo(initialVideoMuted, this.owner)
        this.assertActive(generation)
      }
      this.assertEngineOwner('joinChannel')
      const result = await rtc.joinChannelAndWait(options, this.owner)
      this.assertActive(generation)
      this.assertEngineOwner('joinChannel')
      this.channelActive = true
      this.setState(CALL_STATE.JOINED)
      // 部分设备在入房前设置路由会返回 NOT_READY(-3)，因此默认路由在入房成功后设置。
      // 路由可能被耳机或系统策略拒绝，不能让已经成功的通话因此进入 failed。
      try {
        await rtc.setSpeakerphoneEnabled(publishVideo, this.owner)
        this.assertActive(generation)
        this.assertEngineOwner('setEnableSpeakerphone')
      } catch (routeError) {
        if (routeError && routeError.category === RTC_ERROR_CATEGORY.CANCELLED) throw routeError
        this.assertActive(generation)
        this.assertEngineOwner('setEnableSpeakerphone')
        rtcLogger.warn('DEFAULT AUDIO ROUTE ERROR', {
          enabled: publishVideo,
          error: routeError
        })
      }
      return result
    } catch (error) {
      // 用户主动离开/取消时，leave() 已经写了目标状态，这里不能再用 failed 覆盖。
      if (
        !this.disposed &&
        generation === this.generation &&
        this.state !== CALL_STATE.LEAVING &&
        this.state !== CALL_STATE.READY
      ) {
        this.error = error
        this.setState(CALL_STATE.FAILED)
      }
      throw error
    }
  }

  /** 离开当前频道；Engine 保留，可在同一实例中重新 join()。 */
  async leave() {
    this.assertActive()
    const previous = this.state
    // 先作废旧 join，再复用 cancelPendingOperations() 已发起的同一次原生清理。
    this.generation += 1
    const generation = this.generation
    this.setState(CALL_STATE.LEAVING)
    try {
      await this.startLeaveCleanup()
      this.assertActive(generation)
      this.channelActive = false
      this.setState(CALL_STATE.READY)
    } catch (error) {
      if (!this.disposed && generation === this.generation) {
        this.error = error
        this.setState(previous === CALL_STATE.JOINED || previous === CALL_STATE.JOINING ?
          CALL_STATE.JOINED :
          CALL_STATE.READY)
      }
      throw error
    }
  }

  /** 将原生连接失败纳入 Session 状态机；保留 channelActive 供重试前清理。 */
  handleConnectionFailure(data) {
    const error = createConnectionError(data)
    if (!this.disposed && this.state !== CALL_STATE.LEAVING) {
      this.error = error
      this.setState(CALL_STATE.FAILED)
    }
    return error
  }

  /**
   * 永久释放实例，可重复调用。
   * 先标记 disposed、递增 generation 并退订，再异步销毁 Engine，阻止旧异步流程回写状态。
   * 只有仍持有 Engine 所有权的 Session 才会真正销毁原生资源。
   */
  async dispose() {
    if (this.disposed) return
    this.disposed = true
    this.initialized = false
    this.channelActive = false
    this.generation += 1
    this.setState(CALL_STATE.DISPOSED)
    this.unsubscribers.forEach((unsubscribe) => unsubscribe())
    this.unsubscribers.clear()
    this.subscriptionMeta.clear()
    this.stateListeners.clear()
    await rtc.destroy(this.owner)
  }

  assertEngineOwner(operation) {
    if (!rtc.isEngineOwner(this.owner)) {
      throw new RtcError('RTC Engine 已被其他通话接管，请结束当前通话后重试', {
        category: RTC_ERROR_CATEGORY.STATE,
        operation
      })
    }
  }

  assertDeviceReady(operation) {
    this.assertActive()
    if (!this.initialized) {
      throw new RtcError('RTC Engine 尚未初始化', {
        category: RTC_ERROR_CATEGORY.STATE,
        operation
      })
    }
    this.assertEngineOwner(operation)
  }

  // 所有设备操作都携带 owner；旧 Session 不能控制新通话的 Engine。
  async startPreview() {
    this.assertDeviceReady('startPreview')
    return rtc.startPreview(this.owner)
  }
  async stopPreview() {
    this.assertDeviceReady('stopPreview')
    return rtc.stopPreview(this.owner)
  }
  async enableLocalAudio(enabled) {
    this.assertDeviceReady('enableLocalAudio')
    return rtc.enableLocalAudio(enabled, this.owner)
  }
  async enableLocalVideo(enabled) {
    this.assertDeviceReady('enableLocalVideo')
    return rtc.enableLocalVideo(enabled, this.owner)
  }
  async muteLocalAudio(muted) {
    this.assertDeviceReady('muteLocalAudioStream')
    return rtc.muteLocalAudio(muted, this.owner)
  }
  async muteLocalVideo(muted) {
    this.assertDeviceReady('muteLocalVideoStream')
    return rtc.muteLocalVideo(muted, this.owner)
  }
  async switchCamera() {
    this.assertDeviceReady('switchCamera')
    return rtc.switchCamera(this.owner)
  }
  async setSpeakerphoneEnabled(enabled) {
    this.assertDeviceReady('setEnableSpeakerphone')
    return rtc.setSpeakerphoneEnabled(enabled, this.owner)
  }
}

export {
  CALL_STATE,
  RTC_ERROR_CATEGORY,
  RTC_EVENT
}
export {
  RTC_CONNECTION_STATE,
  REMOTE_MEDIA_STATE
}
from './rtc-constants.js'
