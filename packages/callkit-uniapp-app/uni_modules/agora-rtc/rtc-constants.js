/** RTC 连接状态，与 Agora RTC 4.x 原生枚举保持一致。 */
export const RTC_CONNECTION_STATE = Object.freeze({
  DISCONNECTED: 1,
  CONNECTING: 2,
  CONNECTED: 3,
  RECONNECTING: 4,
  FAILED: 5
})

/** 远端音频/视频状态。 */
export const REMOTE_MEDIA_STATE = Object.freeze({
  STOPPED: 0,
  STARTING: 1,
  DECODING: 2,
  FROZEN: 3,
  FAILED: 4
})

/** 公共通话控制器状态。 */
export const CALL_STATE = Object.freeze({
  IDLE: 'idle',
  REQUESTING_PERMISSION: 'requestingPermission',
  INITIALIZING: 'initializing',
  READY: 'ready',
  JOINING: 'joining',
  JOINED: 'joined',
  LEAVING: 'leaving',
  FAILED: 'failed',
  DISPOSED: 'disposed'
})

/** 稳定的业务错误类别；原生数字 code/reason 仍保留在 RtcError 中用于诊断。 */
export const RTC_ERROR_CATEGORY = Object.freeze({
  PARAMETER: 'parameter',
  PERMISSION: 'permission',
  DEVICE: 'device',
  AUTH: 'auth',
  NETWORK: 'network',
  SERVICE: 'service',
  STATE: 'state',
  TIMEOUT: 'timeout',
  CANCELLED: 'cancelled',
  NATIVE: 'native'
})

/** 公共事件名常量，业务代码与默认 UI 不应重复书写事件字符串。 */
export const RTC_EVENT = Object.freeze({
  ENGINE_INITIALIZED: 'engineInitialized',
  JOIN_CHANNEL_SUCCESS: 'joinChannelSuccess',
  JOIN_CHANNEL_TIMEOUT: 'joinChannelTimeout',
  LEAVE_CHANNEL: 'leaveChannel',
  USER_JOINED: 'userJoined',
  USER_OFFLINE: 'userOffline',
  CONNECTION_STATE_CHANGED: 'connectionStateChanged',
  REMOTE_VIDEO_STATE_CHANGED: 'remoteVideoStateChanged',
  REMOTE_AUDIO_STATE_CHANGED: 'remoteAudioStateChanged',
  VIDEO_SIZE_CHANGED: 'videoSizeChanged',
  ERROR: 'error'
})
