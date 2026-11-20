/** 入房参数；不包含 appId，App ID 由 initialize(appId) 或 SessionJoinOptions 提供。 */
export interface JoinChannelOptions {
  /** 频道名，调用前会去除首尾空白。 */
  channelName : string
  /** 启用 App Certificate 时必填；必须与频道和 UID 匹配。 */
  token ?: string
  /** 0～2147483647 的整数；0 表示由 SDK 分配。 */
  uid : number
  /** 是否发布本地音频，默认 true。 */
  publishAudio ?: boolean
  /** 是否发布本地视频，默认 true。 */
  publishVideo ?: boolean
  /** 是否自动订阅远端音频，默认 true。 */
  autoSubscribeAudio ?: boolean
  /** 是否自动订阅远端视频，默认 true。 */
  autoSubscribeVideo ?: boolean
  /** 视频编码宽度，默认 960；方向由 Adaptive 模式跟随采集画面。 */
  videoEncoderWidth ?: number
  /** 视频编码高度，默认 540。 */
  videoEncoderHeight ?: number
  /** 视频编码帧率，默认 24；支持 1、7、10、15、24、30、60 fps。 */
  videoEncoderFrameRate ?: number
  /** 推流方向：adaptive 跟随采集（默认）/ portrait 强制竖屏 / landscape 强制横屏。 */
  videoOrientationMode ?: 'adaptive' | 'portrait' | 'landscape'
}

/** 按场景申请权限；纯语音应使用 { audio: true, video: false }。 */
export interface PermissionOptions {
  audio ?: boolean
  video ?: boolean
}

/** 事件名到 payload 的映射，用于 on/off 的泛型推导。 */
export interface RtcEventMap {
  engineInitialized : { appId : string }
  joinChannelSuccess : { channel : string; uid : number; elapsed : number }
  joinChannelTimeout : { timeout : number }
  leaveChannel : { duration : number }
  userJoined : { uid : number; elapsed : number }
  userOffline : { uid : number; reason : number }
  connectionStateChanged : { state : number; reason : number }
  remoteVideoStateChanged : { uid : number; state : number; reason : number; elapsed : number }
  remoteAudioStateChanged : { uid : number; state : number; reason : number; elapsed : number }
  /** uid=0 为本地预览；width/height 为原始尺寸，未按 rotation 归一。 */
  videoSizeChanged : { uid : number; width : number; height : number; rotation : number }
  error : { code : number; message ?: string }
}

export type RtcEventName = keyof RtcEventMap
export type RtcErrorCategory = 'parameter' | 'permission' | 'device' | 'auth' | 'network' | 'service' | 'state' | 'timeout' | 'cancelled' | 'native'

export const RTC_CONNECTION_STATE : Readonly<{ DISCONNECTED : 1; CONNECTING : 2; CONNECTED : 3; RECONNECTING : 4; FAILED : 5 }>
export const REMOTE_MEDIA_STATE : Readonly<{ STOPPED : 0; STARTING : 1; DECODING : 2; FROZEN : 3; FAILED : 4 }>
export type CallState = 'idle' | 'requestingPermission' | 'initializing' | 'ready' | 'joining' | 'joined' | 'leaving' | 'failed' | 'disposed'
export const CALL_STATE : Readonly<{
  IDLE : 'idle'; REQUESTING_PERMISSION : 'requestingPermission'; INITIALIZING : 'initializing'
  READY : 'ready'; JOINING : 'joining'; JOINED : 'joined'; LEAVING : 'leaving'
  FAILED : 'failed'; DISPOSED : 'disposed'
}>
export const RTC_ERROR_CATEGORY : Readonly<{
  PARAMETER : 'parameter'; PERMISSION : 'permission'; DEVICE : 'device'; AUTH : 'auth'
  NETWORK : 'network'; SERVICE : 'service'; STATE : 'state'; TIMEOUT : 'timeout'
  CANCELLED : 'cancelled'; NATIVE : 'native'
}>
export const RTC_EVENT : Readonly<{
  ENGINE_INITIALIZED : 'engineInitialized'; JOIN_CHANNEL_SUCCESS : 'joinChannelSuccess'
  JOIN_CHANNEL_TIMEOUT : 'joinChannelTimeout'; LEAVE_CHANNEL : 'leaveChannel'
  USER_JOINED : 'userJoined'; USER_OFFLINE : 'userOffline'
  CONNECTION_STATE_CHANGED : 'connectionStateChanged'
  REMOTE_VIDEO_STATE_CHANGED : 'remoteVideoStateChanged'
  REMOTE_AUDIO_STATE_CHANGED : 'remoteAudioStateChanged'
  VIDEO_SIZE_CHANGED : 'videoSizeChanged'; ERROR : 'error'
}>

export interface RtcErrorOptions {
  category ?: RtcErrorCategory
  code ?: number
  operation ?: string
  reason ?: number
  cause ?: unknown
  userMessage ?: string
}

/** 统一错误对象；category 用于业务恢复，code/reason 用于原生诊断。 */
export class RtcError extends Error {
  constructor(message : string, options ?: RtcErrorOptions)
  category : RtcErrorCategory
  code ?: number
  operation ?: string
  reason ?: number
  cause ?: unknown
  /** 可直接展示给终端用户的文案；message 面向开发者与日志。 */
  userMessage : string
}

/** 订阅事件并返回幂等退订函数；宿主销毁时必须退订。 */
export function on<K extends RtcEventName>(event : K, callback : (data : RtcEventMap[K], event : K) => void) : () => void
/** 移除指定回调；省略 callback 会清除该事件的全部订阅，跨页面使用时需谨慎。 */
export function off<K extends RtcEventName>(event : K, callback ?: (data : RtcEventMap[K], event : K) => void) : void
/** 申请权限并返回是否全部授权，不主动打开系统设置。 */
export function requestPermissions(options ?: PermissionOptions) : Promise<boolean>
/** 申请权限；拒绝时抛出 category='permission' 的 RtcError。 */
export function requestPermissionsOrThrow(options ?: PermissionOptions) : Promise<void>
export function openPermissionSettings() : Promise<unknown>
/**
 * 创建或复用 Engine；更换 App ID 前必须先 await destroy()。
 * owner 是 Engine 所有权令牌，通常由 RtcCallSession 内部传入。
 */
export function initialize(appId : string, owner ?: unknown) : Promise<void>
/** 当前调用方是否仍持有 Engine；省略 owner 时按旧语义返回 true。 */
export function isEngineOwner(owner ?: unknown) : boolean
/** 仅提交入房请求；resolve 不代表已经收到 joinChannelSuccess。 */
export function joinChannel(options : JoinChannelOptions, owner ?: unknown) : Promise<void>
/** 等待真实入房结果；失败、超时、离开和销毁均通过 reject 返回。 */
export function joinChannelAndWait(options : JoinChannelOptions, owner ?: unknown) : Promise<RtcEventMap['joinChannelSuccess']>
/** 离开频道并取消仍在等待的入房；Engine 保留。非 owner 调用为 no-op。 */
export function leaveChannel(owner ?: unknown) : Promise<void>
export function startPreview(owner ?: unknown) : Promise<void>
export function stopPreview(owner ?: unknown) : Promise<void>
export function enableLocalAudio(enabled : boolean, owner ?: unknown) : Promise<void>
export function enableLocalVideo(enabled : boolean, owner ?: unknown) : Promise<void>
export function muteLocalAudio(muted : boolean, owner ?: unknown) : Promise<void>
export function muteLocalVideo(muted : boolean, owner ?: unknown) : Promise<void>
export function switchCamera(owner ?: unknown) : Promise<void>
/** true 请求扬声器，false 请求听筒；外部耳机和系统策略可能覆盖该偏好。 */
export function setSpeakerphoneEnabled(enabled : boolean, owner ?: unknown) : Promise<void>
/** App 私有目录日志路径，固定文件名 easemob-rtc.log。 */
export const RTC_LOG_FILE_NAME : 'easemob-rtc.log'
/** 单文件最大 2 MiB；下一次写入将导致超限时，先清空旧日志再写入。 */
export const RTC_LOG_MAX_BYTES : number
export function getRtcLogFilePath() : string
/** 等待已排队的日志写入完成。 */
export function flushRtcLogs() : Promise<void>
export function setRtcLoggingEnabled(enabled : boolean) : void
export function clearRtcLogs() : Promise<void>
export const rtcLogger : {
  debug(message : string, data ?: unknown) : string
  info(message : string, data ?: unknown) : string
  warn(message : string, data ?: unknown) : string
  error(message : string, data ?: unknown) : string
}
/**
 * 销毁 Engine，不全局清理其他 Session 的 JS 监听器。
 * 传入 owner 时只允许持有者销毁，旧 Session 的延迟销毁不会误毁新 Session。
 */
export function destroy(owner ?: unknown) : Promise<void>
export function nativeErrorHint(code : number) : string
export function rtcErrorMessage(code : number) : string
export function connectionErrorMessage(reason : number) : string
export function categorizeNativeError(code : number, operation ?: string) : RtcErrorCategory
export function createConnectionError(data ?: { reason ?: number }) : RtcError
export function createNativeError(code : number, operation : string) : RtcError
