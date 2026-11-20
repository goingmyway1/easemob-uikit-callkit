import type { RtcEventMap } from './index'
import type { RtcError } from './index'

/** 默认 UI 受约束的运行时应主题；颜色为字符串，其余布局差异请用插槽或自建皮肤。 */
export interface AgoraCallTheme {
  /** 通话根容器背景 */
  backgroundColor ?: string
  /** 头部背景 */
  headerBackgroundColor ?: string
  /** 一对多视频卡片背景 */
  cardBackgroundColor ?: string
  /** 标题、控制按钮文字等主要文字颜色 */
  textColor ?: string
  /** 次要说明文字颜色（占位、控制按钮状态、通话时长） */
  mutedTextColor ?: string
  /** 状态文案颜色 */
  statusTextColor ?: string
  /** 错误文案颜色 */
  errorTextColor ?: string
  /** 无视频占位背景 */
  placeholderBackgroundColor ?: string
  /** 控制按钮默认背景 */
  controlBackgroundColor ?: string
  /** 控制按钮关闭态背景 */
  controlMutedColor ?: string
  /** 强调色：加入/重试按钮、占位头像 */
  accentColor ?: string
  /** 危险色：结束通话按钮 */
  dangerColor ?: string
  /** 呼叫页背景（音频无背景图时） */
  callingBackgroundColor ?: string
  /** 呼叫页遮罩色（盖在本地预览或背景图上） */
  callingScrimColor ?: string
  /** 呼叫页被叫姓名颜色 */
  callingNameColor ?: string
  /** 呼叫页 loading 点颜色 */
  callingLoadingColor ?: string
  /** 呼叫页头像占位背景 */
  callingAvatarBackgroundColor ?: string
}

/** 一对一与一对多默认 UI 的公共输入；通话中不应直接修改入房参数。 */
export interface AgoraCallProps {
  appId : string
  channelName : string
  token ?: string
  uid ?: number | string
  /** audio 不申请摄像头权限，也不发布或订阅视频。 */
  mediaType ?: 'audio' | 'video'
  /** false 时由宿主通过 ref 调用 join()。 */
  autoJoin ?: boolean
  title ?: string
  showHeader ?: boolean
  showControls ?: boolean
  initialAudioMuted ?: boolean
  initialVideoMuted ?: boolean
  /** 默认 960；一对一和一对多均需在 join() 前确定。 */
  videoEncoderWidth ?: number
  /** 默认 540；一对一和一对多均需在 join() 前确定。 */
  videoEncoderHeight ?: number
  /** 默认 24；支持 1、7、10、15、24、30、60 fps，双端使用标准码率。 */
  videoEncoderFrameRate ?: number
  /** 推流方向：adaptive 跟随采集（默认）/ portrait 强制竖屏 / landscape 强制横屏。 */
  videoOrientationMode ?: 'adaptive' | 'portrait' | 'landscape'
  theme ?: AgoraCallTheme
}

/** 一对一默认 UI 的呼叫页 props；只在入房后、远端加入前展示。 */
export interface AgoraCallOneToOneProps extends AgoraCallProps {
  /** 被叫显示名；仅用于展示，RTC 不提供昵称。 */
  remoteName ?: string
  /** 被叫头像 URL；为空或加载失败时显示内置用户图标。 */
  remoteAvatar ?: string
  /** 是否展示呼叫页，默认 true。 */
  showCalling ?: boolean
  /** 是否显示三点 loading，默认 true。 */
  showCallingLoading ?: boolean
  /** 姓名下方的可选文案，支持 {name} 占位。 */
  callingText ?: string
  /** 呼叫页背景图；音频建议传预模糊图，nvue 不依赖 CSS blur。 */
  callingBackground ?: string
  /** 呼叫页挂断按钮文案，默认“取消”。 */
  callingHangupText ?: string
  /** 主叫铃音；为空使用内置 outgoing.mp3。 */
  outgoingRingtone ?: string
  /** 被叫铃音；为空使用内置 incoming.mp3。 */
  incomingRingtone ?: string
  /** 铃音总开关，默认 true。 */
  ringtoneEnabled ?: boolean
  /** 铃音音量，0～1，默认 1。 */
  ringtoneVolume ?: number
  /** 是否循环播放，默认 true。 */
  ringtoneLoop ?: boolean
  /** iOS 是否遵循静音开关，默认 true。 */
  ringtoneObeyMuteSwitch ?: boolean
  /** 呼叫方向，默认 outgoing。 */
  callDirection ?: 'outgoing' | 'incoming'
  /** 入局振铃状态；由宿主信令控制，插件不自行推断来电。 */
  ringing ?: boolean
  /** 是否显示通话时长，默认 true。 */
  showDuration ?: boolean
  /** 时长位置：顶部居中或几何居中，默认 top。 */
  durationPlacement ?: 'top' | 'center'
  /** 计时起点，默认 remote-joined。 */
  durationStart ?: 'remote-joined' | 'local-joined'
  /** 是否自动隐藏视频 chrome，仅视频通话生效。 */
  chromeAutoHide ?: boolean
  /** 视频 chrome 自动隐藏延迟，默认 10000ms。 */
  chromeAutoHideDelay ?: number
  /** 是否保持屏幕常亮，默认音视频都开启。 */
  keepScreenOn ?: boolean
}

export interface AgoraCallGroupProps extends AgoraCallProps {
  /** 1～4，默认 3；默认皮肤一行展示三个网格卡片。 */
  columns ?: number
  /** 仅限制默认 UI 展示人数；0 不限制，不改变订阅行为。 */
  maxRemoteUsers ?: number
  /** 网格卡片宽高比（宽 / 高），默认 3:4。 */
  cardAspectRatio ?: number
  /** [callkit-patch] 已邀请但尚未入房的成员；仅渲染占位卡片，不绑定 RTC 视频。 */
  pendingParticipants ?: Array<{
    userId : string
    nickname ?: string
    avatarURL ?: string
    state ?: 'invited' | 'accepted' | 'joinedRtc' | 'left'
  }>
  /** [callkit-patch] RTC 数字 UID → 用户资料；用于替换网格中的裸 UID。 */
  remoteProfiles ?: Record<string, {
    uid ?: string
    userId ?: string
    nickname ?: string
    avatarURL ?: string
  }>
}

/** 默认 UI 的展示状态，由 RtcCallSession 状态派生。 */
export type AgoraCallUiState =
  | 'idle'
  | 'requesting-permission'
  | 'initializing'
  | 'joining'
  | 'joined'
  | 'leaving'
  | 'failed'
  | 'disposed'

/** 默认 UI 通过组件 ref 暴露的命令式方法。 */
export interface AgoraCallMethods {
  join() : Promise<RtcEventMap['joinChannelSuccess'] | undefined>
  /** resolve 值表示是否真正执行了离开流程。 */
  leave() : Promise<boolean>
  hangUp() : Promise<void>
  dispose() : Promise<void>
  setAudioMuted(muted : boolean) : Promise<void>
  setVideoMuted(muted : boolean) : Promise<void>
  switchCamera() : Promise<void>
  setSpeakerphoneEnabled(enabled : boolean) : Promise<void>
  suspendPreview() : Promise<void>
  resumePreview() : Promise<void>
}

/**
 * 皮肤扩展钩子：复制默认组件或自建皮肤时可按需实现。
 * 方法由 mixin 在对应时机调用，未实现时自动跳过。
 */
export interface AgoraCallHooks {
  onCallJoined?(data ?: RtcEventMap['joinChannelSuccess']) : void
  onCallLeft?(data ?: RtcEventMap['leaveChannel']) : void
  onRemoteUserJoined?(data : RtcEventMap['userJoined']) : void
  onRemoteUserOffline?(data : RtcEventMap['userOffline']) : void
  onRemoteVideoState?(data : RtcEventMap['remoteVideoStateChanged']) : void
  onRemoteAudioState?(data : RtcEventMap['remoteAudioStateChanged']) : void
  /** 本地（uid=0）或远端视频流尺寸变化，可用于主窗口按流比例排版。 */
  onVideoSizeChanged?(data : RtcEventMap['videoSizeChanged']) : void
  onConnectionStateChanged?(data : RtcEventMap['connectionStateChanged']) : void
  onConnectionFailure?(error : RtcError) : void
  onLocalVideoChanged?(muted : boolean) : void
  beforeLocalVideoDisabled?() : void
  onPreviewResumed?() : void
  beforeCallDispose?() : void
}

export type AgoraCallEventName =
  | 'ready' | 'joining' | 'joined' | 'left'
  | 'user-joined' | 'user-offline'
  /** [callkit-patch] 远端音视频状态事件，供 CallKit core 同步参与者 isMuted */
  | 'remote-audio-state-changed' | 'remote-video-state-changed'
  | 'audio-changed' | 'video-changed' | 'camera-changed' | 'speaker-changed'
  | 'connection-changed'
  | 'error' | 'hangup' | 'state-change' | 'remote-user-click' | 'window-switch'
  | 'chrome-visibility-change'

export type AgoraCallSlotName =
  | 'header' | 'status' | 'waiting' | 'empty' | 'loading' | 'error' | 'permission-denied'
  | 'local-overlay' | 'remote-overlay' | 'local-placeholder' | 'remote-placeholder'
  | 'controls' | 'control-extra' | 'footer'
  | 'audio-icon' | 'video-icon' | 'camera-icon' | 'speaker-icon' | 'hangup-icon'
  | 'calling' | 'calling-background' | 'calling-avatar' | 'calling-name' | 'calling-loading'
