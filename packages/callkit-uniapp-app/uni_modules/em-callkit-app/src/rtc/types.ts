export type AppMediaType = 'audio' | 'video'

export interface AgoraSessionJoinOptions {
  appId: string
  channelName: string
  token?: string
  uid: number
  publishAudio?: boolean
  publishVideo?: boolean
  autoSubscribeAudio?: boolean
  autoSubscribeVideo?: boolean
  permissionOptions?: {
    audio?: boolean
    video?: boolean
  }
  initialAudioMuted?: boolean
  initialVideoMuted?: boolean
}

export interface AgoraRtcEventMap {
  joinChannelSuccess: { channel: string; uid: number; elapsed: number }
  leaveChannel: { duration: number }
  userJoined: { uid: number; elapsed: number }
  userOffline: { uid: number; reason: number }
  connectionStateChanged: { state: number; reason: number }
  remoteVideoStateChanged: { uid: number; state: number; reason: number; elapsed: number }
  remoteAudioStateChanged: { uid: number; state: number; reason: number; elapsed: number }
  error: { code: number; message?: string }
}

/**
 * `agora-rtc/rtc-call-session.js` 中 RtcCallSession 的最小结构契约。
 *
 * 由宿主在 App 内传入真实实例，插件源码不需要复制进 CallKit。
 */
export interface AgoraRtcSession {
  on<K extends keyof AgoraRtcEventMap>(
    event: K,
    callback: (data: AgoraRtcEventMap[K], event: K) => void
  ): () => void
  cancelPendingOperations(): void
  join(options: AgoraSessionJoinOptions): Promise<AgoraRtcEventMap['joinChannelSuccess']>
  leave(): Promise<void>
  dispose(): Promise<void>
  enableLocalAudio(enabled: boolean): Promise<void>
  enableLocalVideo(enabled: boolean): Promise<void>
  startPreview(): Promise<void>
  /** 停止本地预览；插件未暴露时适配层会跳过调用 */
  stopPreview?(): Promise<void>
  muteLocalAudio(muted: boolean): Promise<void>
  muteLocalVideo(muted: boolean): Promise<void>
  switchCamera(): Promise<void>
  setSpeakerphoneEnabled(enabled: boolean): Promise<void>
}

export type AgoraSessionFactory = () => AgoraRtcSession

export interface AgoraUidUser {
  uid: number | string
  userId: string
}
