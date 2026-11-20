import type { CallState, JoinChannelOptions, PermissionOptions, RtcEventMap, RtcError } from './index'
import { CALL_STATE, RTC_ERROR_CATEGORY, RTC_EVENT } from './index'

/** Session 完整入房参数，在底层入房参数上增加 App ID 与权限配置。 */
export interface SessionJoinOptions extends JoinChannelOptions {
  appId : string
  /** 纯语音必须关闭 video，并同步关闭 publishVideo/autoSubscribeVideo。 */
  permissionOptions ?: PermissionOptions
  /** 在原生入房前静音本地音频推流，避免入房后短暂发布。 */
  initialAudioMuted ?: boolean
  /** 在原生入房前关闭本地视频采集并静音视频推流。 */
  initialVideoMuted ?: boolean
}

/**
 * 无头单频道控制器，不依赖 Vue、路由或原生视图。
 * 每个宿主使用独立实例，销毁时调用 dispose()；底层 Engine 仍为单例，
 * 只有当前持有 Engine 所有权的 Session 才会真正销毁原生资源。
 */
export class RtcCallSession {
  state : CallState
  error : Error | null
  disposed : boolean
  appId : string
  readonly engineReady : boolean
  readonly joining : boolean
  readonly joined : boolean
  /** 订阅状态变化；UI 应从这里派生展示状态。返回退订函数。 */
  onStateChange(callback : (state : CallState, previous : CallState) => void) : () => void
  on<K extends keyof RtcEventMap>(event : K, callback : (data : RtcEventMap[K], event : K) => void) : () => void
  off<K extends keyof RtcEventMap>(event : K, callback ?: (data : RtcEventMap[K], event : K) => void) : void
  /** 处理通话中的连接失败；重试 join 时会先清理仍活跃的频道。 */
  handleConnectionFailure(data : { reason ?: number }) : RtcError
  /** 作废当前权限/初始化/入房流程但不销毁 Engine；用于“入房中结束通话”。 */
  cancelPendingOperations() : void
  /** 只申请权限并初始化 Engine，不提交入房。已初始化后切换 App ID 会抛错。 */
  initialize(appId : string, permissionOptions ?: PermissionOptions) : Promise<void>
  /** 完整入房；resolve 时已收到 joinChannelSuccess。 */
  join(options : SessionJoinOptions) : Promise<RtcEventMap['joinChannelSuccess']>
  /** 离开频道但保留 Engine，可在本实例中再次 join。失败时状态回退为可重试。 */
  leave() : Promise<void>
  /** 永久释放并退订，可重复调用；销毁后本实例不可复用。 */
  dispose() : Promise<void>
  startPreview() : Promise<void>
  stopPreview() : Promise<void>
  enableLocalAudio(enabled : boolean) : Promise<void>
  enableLocalVideo(enabled : boolean) : Promise<void>
  muteLocalAudio(muted : boolean) : Promise<void>
  muteLocalVideo(muted : boolean) : Promise<void>
  switchCamera() : Promise<void>
  setSpeakerphoneEnabled(enabled : boolean) : Promise<void>
}

export { CALL_STATE, RTC_ERROR_CATEGORY, RTC_EVENT }
export { RTC_CONNECTION_STATE, REMOTE_MEDIA_STATE } from './index'
