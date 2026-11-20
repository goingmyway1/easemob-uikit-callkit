import {
  RtcCallSession
} from '../rtc-call-session.js'
import {
  CALL_STATE,
  RTC_CONNECTION_STATE,
  RTC_ERROR_CATEGORY,
  RTC_EVENT,
  RtcError,
  createConnectionError,
  createNativeError,
  rtcLogger
} from '../index.js'

/**
 * 默认通话 UI 的展示状态。
 *
 * 展示状态由 RtcCallSession 的状态事件派生，不再由组件自行维护第二套连接状态。
 * requestingPermission / initializing 让宿主可以区分“权限弹窗”和“正在入房”。
 */
export const CALL_UI_STATE = Object.freeze({
  IDLE: 'idle',
  REQUESTING_PERMISSION: 'requesting-permission',
  INITIALIZING: 'initializing',
  JOINING: 'joining',
  JOINED: 'joined',
  LEAVING: 'leaving',
  FAILED: 'failed',
  DISPOSED: 'disposed'
})

const SESSION_TO_UI_STATE = {
  [CALL_STATE.IDLE]: CALL_UI_STATE.IDLE,
  [CALL_STATE.REQUESTING_PERMISSION]: CALL_UI_STATE.REQUESTING_PERMISSION,
  [CALL_STATE.INITIALIZING]: CALL_UI_STATE.INITIALIZING,
  [CALL_STATE.READY]: CALL_UI_STATE.IDLE,
  [CALL_STATE.JOINING]: CALL_UI_STATE.JOINING,
  [CALL_STATE.JOINED]: CALL_UI_STATE.JOINED,
  [CALL_STATE.LEAVING]: CALL_UI_STATE.LEAVING,
  [CALL_STATE.FAILED]: CALL_UI_STATE.FAILED,
  [CALL_STATE.DISPOSED]: CALL_UI_STATE.DISPOSED
}

const UI_STATE_STATUS_TEXT = {
  [CALL_UI_STATE.IDLE]: '准备通话',
  [CALL_UI_STATE.REQUESTING_PERMISSION]: '正在申请音视频权限',
  [CALL_UI_STATE.INITIALIZING]: '正在初始化 RTC',
  [CALL_UI_STATE.JOINING]: '正在加入频道',
  [CALL_UI_STATE.JOINED]: '已加入频道',
  [CALL_UI_STATE.LEAVING]: '正在退出频道'
}

/**
 * 默认通话 UI 的共享行为层。
 *
 * mixin 只维护组件展示状态并代理 RtcCallSession；一对一/一对多组件只处理自己的
 * 远端用户展示与 agora-video-view 绑定。业务路由、Token 获取和权限设置弹窗仍由宿主负责。
 *
 * 皮肤扩展钩子（组件可选实现）：
 * - onCallJoined(data) / onCallLeft(data)
 * - onRemoteUserJoined(data) / onRemoteUserOffline(data)
 * - onRemoteVideoState(data) / onRemoteAudioState(data)
 * - onVideoSizeChanged(data)
 * - onConnectionStateChanged(data) / onConnectionFailure(error)
 * - onLocalVideoChanged(muted) / beforeLocalVideoDisabled()
 * - onPreviewResumed()
 * - beforeCallDispose()
 *
 * 对外 props/events/methods 的完整契约见 ui.d.ts 与插件 readme.md。
 */
export default {
  props: {
    appId: {
      type: String,
      default: ''
    },
    channelName: {
      type: String,
      default: ''
    },
    token: {
      type: String,
      default: ''
    },
    uid: {
      type: [Number, String],
      default: 0
    },
    mediaType: {
      type: String,
      default: 'video'
    },
    autoJoin: {
      type: Boolean,
      default: true
    },
    title: {
      type: String,
      default: ''
    },
    showHeader: {
      type: Boolean,
      default: true
    },
    showControls: {
      type: Boolean,
      default: true
    },
    initialAudioMuted: {
      type: Boolean,
      default: false
    },
    initialVideoMuted: {
      type: Boolean,
      default: false
    },
    videoEncoderWidth: {
      type: Number,
      default: 960
    },
    videoEncoderHeight: {
      type: Number,
      default: 540
    },
    videoEncoderFrameRate: {
      type: Number,
      default: 24
    },
    videoOrientationMode: {
      type: String,
      default: 'adaptive'
    },
    theme: {
      type: Object,
      default: () => ({})
    }
  },
  data() {
    return {
      session: null,
      callState: CALL_UI_STATE.IDLE,
      busy: false,
      disposed: false,
      localUid: 0,
      joinedUid: 0,
      audioMuted: this.initialAudioMuted,
      videoMuted: this.initialVideoMuted,
      speakerphoneEnabled: this.mediaType === 'video',
      previewSuspended: false,
      reconnecting: false,
      statusText: '准备通话',
      lastError: null,
      windowWidth: 375,
      windowHeight: 667,
      safeAreaTop: 0,
      safeAreaBottom: 0
    }
  },
  computed: {
    isVideo() {
      return this.mediaType === 'video'
    },
    joined() {
      return this.callState === CALL_UI_STATE.JOINED
    },
    joining() {
      return this.callState === CALL_UI_STATE.JOINING ||
        this.callState === CALL_UI_STATE.REQUESTING_PERMISSION ||
        this.callState === CALL_UI_STATE.INITIALIZING
    },
    canJoin() {
      return !this.busy && !this.joined && !this.joining &&
        this.callState !== CALL_UI_STATE.LEAVING &&
        this.callState !== CALL_UI_STATE.DISPOSED &&
        !this.disposed
    },
    isPermissionError() {
      return Boolean(this.lastError && this.lastError.category === RTC_ERROR_CATEGORY.PERMISSION)
    },
    rootStyle() {
      return {
        backgroundColor: this.theme.backgroundColor || '#0b0b0f'
      }
    },
    headerStyle() {
      return {
        backgroundColor: this.theme.headerBackgroundColor || 'transparent'
      }
    },
    textStyle() {
      return {
        color: this.theme.textColor || '#ffffff'
      }
    },
    mutedTextStyle() {
      return {
        color: this.theme.mutedTextColor || 'rgba(255, 255, 255, 0.72)'
      }
    },
    statusTextStyle() {
      return {
        color: this.theme.statusTextColor || 'rgba(255, 255, 255, 0.88)'
      }
    },
    errorTextStyle() {
      return {
        color: this.theme.errorTextColor || '#ff9aa6'
      }
    },
    placeholderStyle() {
      return {
        backgroundColor: this.theme.placeholderBackgroundColor || '#1b1e25'
      }
    },
    controlStyle() {
      return {
        backgroundColor: this.theme.controlBackgroundColor || '#ffffff'
      }
    },
    controlOffStyle() {
      return {
        backgroundColor: this.theme.controlMutedColor || 'rgba(255, 255, 255, 0.32)'
      }
    },
    accentStyle() {
      return {
        backgroundColor: this.theme.accentColor || '#4d7cfe'
      }
    },
    dangerStyle() {
      return {
        backgroundColor: this.theme.dangerColor || '#ff3b30'
      }
    }
  },
  created() {
    // 一个组件实例对应一个 Session；不要在多个组件之间共享可变 Session 状态。
    this.session = new RtcCallSession()
    this.disposed = false
    this.updateWindowMetrics()
    this.registerWindowResize()
    this.registerSessionEvents()
  },
  mounted() {
    // 错误已通过 error 事件上报，这里避免自动入房产生未处理的 Promise reject。
    if (this.autoJoin) this.join().catch(() => {})
  },
  // 同时声明 Vue 2 / Vue 3 的销毁钩子，两者互斥且内部幂等，避免任一运行时下漏掉 dispose。
  beforeDestroy() {
    this.teardown()
  },
  beforeUnmount() {
    this.teardown()
  },
  methods: {
    registerSessionEvents() {
      this.session.onStateChange((state, previous) => {
        this.handleSessionState(state, previous)
      })
      this.session.on(RTC_EVENT.ENGINE_INITIALIZED, () => {
        this.$emit('ready')
      })
      this.session.on(RTC_EVENT.JOIN_CHANNEL_SUCCESS, (data) => {
        const uid = Number(data.uid)
        this.localUid = uid
        this.joinedUid = uid
        this.statusText = '已加入频道'
        this.updateCallState(CALL_UI_STATE.JOINED, CALL_STATE.JOINED)
        this.$emit('joined', data)
        if (typeof this.onCallJoined === 'function') this.onCallJoined(data)
      })
      this.session.on(RTC_EVENT.LEAVE_CHANNEL, (data) => {
        this.localUid = 0
        if (typeof this.onCallLeft === 'function') this.onCallLeft(data)
        this.$emit('left', data)
      })
      this.session.on(RTC_EVENT.USER_JOINED, (data) => {
        if (typeof this.onRemoteUserJoined === 'function') this.onRemoteUserJoined(data)
        this.$emit('user-joined', data)
      })
      this.session.on(RTC_EVENT.USER_OFFLINE, (data) => {
        if (typeof this.onRemoteUserOffline === 'function') this.onRemoteUserOffline(data)
        this.$emit('user-offline', data)
      })
      this.session.on(RTC_EVENT.REMOTE_VIDEO_STATE_CHANGED, (data) => {
        if (typeof this.onRemoteVideoState === 'function') this.onRemoteVideoState(data)
        // [callkit-patch] 透出远端视频状态，宿主据此同步参与者 isMuted / videoOff
        this.$emit('remote-video-state-changed', data)
      })
      this.session.on(RTC_EVENT.REMOTE_AUDIO_STATE_CHANGED, (data) => {
        if (typeof this.onRemoteAudioState === 'function') this.onRemoteAudioState(data)
        // [callkit-patch] 同上，远端静音态需要回写 CallKit core
        this.$emit('remote-audio-state-changed', data)
      })
      this.session.on(RTC_EVENT.VIDEO_SIZE_CHANGED, (data) => {
        if (typeof this.onVideoSizeChanged === 'function') this.onVideoSizeChanged(data)
      })
      this.session.on(RTC_EVENT.CONNECTION_STATE_CHANGED, (data) => {
        this.handleConnectionStateChanged(data)
      })
      this.session.on(RTC_EVENT.JOIN_CHANNEL_TIMEOUT, (data) => {
        this.handleJoinTimeout(data)
      })
      this.session.on(RTC_EVENT.ERROR, (data) => {
        // 入房阶段的鉴权错误由 joinChannelAndWait 统一 reject，避免重复上报。
        if (this.joining) return
        this.reportError(createNativeError(Number(data.code), 'rtcEvent'))
      })
    },
    /** Session 状态是唯一真源，UI 只做映射与文案。 */
    handleSessionState(state, previous) {
      if (this.disposed) return
      const uiState = SESSION_TO_UI_STATE[state]
      if (!uiState) return
      if (uiState === CALL_UI_STATE.FAILED) {
        this.updateCallState(uiState, state)
        return
      }
      let text = UI_STATE_STATUS_TEXT[uiState]
      if (state === CALL_STATE.READY && previous === CALL_STATE.LEAVING) text = '已退出频道'
      if (text && !this.reconnecting) this.statusText = text
      this.updateCallState(uiState, state)
    },
    updateCallState(state, sessionState) {
      if (this.callState === state) return
      this.callState = state
      this.$emit('state-change', {
        state,
        sessionState: sessionState || null
      })
    },
    /** 销毁取消属于正常控制流，不产生误导性的 error 事件。 */
    reportError(error) {
      if (this.disposed || (error && error.category === RTC_ERROR_CATEGORY.CANCELLED)) return
      const normalized = error instanceof Error ? error : new Error(String(error))
      rtcLogger.error('UI ERROR', normalized)
      this.lastError = normalized
      this.statusText = normalized.userMessage || normalized.message || String(normalized)
      this.$emit('error', normalized)
    },
    updateWindowMetrics(info) {
      const system = info || (typeof uni !== 'undefined' && typeof uni.getSystemInfoSync === 'function' ?
        uni.getSystemInfoSync() :
        null)
      if (!system) return
      if (Number(system.windowWidth)) this.windowWidth = Number(system.windowWidth)
      if (Number(system.windowHeight)) this.windowHeight = Number(system.windowHeight)
      // onWindowResize 的 size 不含安全区，只有 getSystemInfoSync 的返回值才更新安全区。
      if (system.safeAreaInsets) {
        this.safeAreaTop = Number(system.safeAreaInsets.top) || 0
        this.safeAreaBottom = Number(system.safeAreaInsets.bottom) || 0
      }
    },
    registerWindowResize() {
      if (typeof uni === 'undefined' || typeof uni.onWindowResize !== 'function') return
      this.windowResizeHandler = (event) => {
        this.updateWindowMetrics(event && event.size ? event.size : null)
      }
      uni.onWindowResize(this.windowResizeHandler)
    },
    unregisterWindowResize() {
      if (this.windowResizeHandler && typeof uni.offWindowResize === 'function') {
        uni.offWindowResize(this.windowResizeHandler)
      }
      this.windowResizeHandler = null
    },
    /**
     * 自动/手动入房共用入口。busy 与 callState 防止重复点击创建并行入房。
     * 媒体与订阅选项由 mediaType 统一派生，避免语音场景误申请摄像头权限。
     */
    async join() {
      if (!this.canJoin) return
      const appId = String(this.appId || '').trim()
      const channelName = String(this.channelName || '').trim()
      if (!appId || !channelName) {
        const error = new RtcError('appId 和 channelName 不能为空', {
          category: RTC_ERROR_CATEGORY.PARAMETER
        })
        this.reportError(error)
        throw error
      }
      // 手动入房前读取最新初始静音配置，避免 created 时的 UI 快照与原生状态不一致。
      this.audioMuted = Boolean(this.initialAudioMuted)
      this.videoMuted = this.isVideo && Boolean(this.initialVideoMuted)
      this.busy = true
      this.lastError = null
      this.reconnecting = false
      this.statusText = '正在加入频道'
      this.$emit('joining')
      try {
        const result = await this.session.join({
          appId,
          channelName,
          token: this.token,
          uid: Number(this.uid || 0),
          publishAudio: true,
          publishVideo: this.isVideo,
          autoSubscribeAudio: true,
          autoSubscribeVideo: this.isVideo,
          videoEncoderWidth: this.videoEncoderWidth,
          videoEncoderHeight: this.videoEncoderHeight,
          videoEncoderFrameRate: this.videoEncoderFrameRate,
          videoOrientationMode: this.videoOrientationMode,
          // Session 在原生 join 前应用初始静音，避免短暂发布。
          initialAudioMuted: this.initialAudioMuted,
          initialVideoMuted: this.isVideo && this.initialVideoMuted,
          permissionOptions: {
            audio: true,
            video: this.isVideo
          }
        })
        return result
      } catch (error) {
        if (error && error.category === RTC_ERROR_CATEGORY.CANCELLED) {
          if (!this.disposed) this.updateCallState(CALL_UI_STATE.IDLE, this.session.state)
        } else {
          this.updateCallState(CALL_UI_STATE.FAILED, this.session.state)
          this.reportError(error)
        }
        throw error
      } finally {
        this.busy = false
      }
    },
    /**
     * 离开频道并返回是否真正执行了离开流程。
     *
     * 权限申请/初始化阶段点结束时，先作废当前流程再尝试离开，避免“点了结束但稍后仍入房”。
     * 离开失败时恢复到可重试状态，不会永久停在 leaving。
     */
    async leave() {
      if (this.disposed || !this.session) return false
      if (this.callState === CALL_UI_STATE.IDLE || this.callState === CALL_UI_STATE.LEAVING) return false
      this.busy = true
      this.previewSuspended = false
      try {
        this.session.cancelPendingOperations()
        if (this.session.engineReady) await this.session.leave()
        if (!this.disposed) {
          this.reconnecting = false
          this.updateCallState(CALL_UI_STATE.IDLE, this.session.state)
        }
        return true
      } catch (error) {
        this.reportError(error)
        if (!this.disposed) {
          this.updateCallState(this.session.joined ? CALL_UI_STATE.JOINED : CALL_UI_STATE.IDLE, this.session.state)
        }
        throw error
      } finally {
        this.busy = false
      }
    },
    /** 只有确认结束（或本来就不在通话中）才发 hangup，避免宿主被误导。 */
    async hangUp() {
      if (this.disposed) return
      const hangupUid = Number(this.joinedUid || this.localUid || 0)
      await this.leave()
      if (this.disposed) return
      this.$emit('hangup', {
        uid: hangupUid
      })
    },
    async dispose() {
      if (this.disposed) return
      this.disposed = true
      this.previewSuspended = false
      this.reconnecting = false
      this.unregisterWindowResize()
      if (typeof this.beforeCallDispose === 'function') this.beforeCallDispose()
      if (this.session) await this.session.dispose()
      // 组件正在销毁，不再向上 emit，直接落最终展示状态。
      this.callState = CALL_UI_STATE.DISPOSED
    },
    teardown() {
      if (this.disposed) return
      this.dispose().catch(() => {})
    },
    async setAudioMuted(muted) {
      if (!this.session || !this.session.engineReady || this.disposed) return
      await this.session.muteLocalAudio(Boolean(muted))
      if (this.disposed) return
      this.audioMuted = Boolean(muted)
      this.$emit('audio-changed', {
        muted: this.audioMuted
      })
    },
    /**
     * 关闭视频前先解绑旧 Canvas，再关闭采集并切换占位；恢复时重新创建/绑定视图，
     * 避免原生 SurfaceView/UIView 保留最后一帧。
     */
    async setVideoMuted(muted) {
      if (!this.isVideo || !this.session || !this.session.engineReady || this.disposed) return
      const nextMuted = Boolean(muted)
      if (nextMuted && typeof this.beforeLocalVideoDisabled === 'function') {
        this.beforeLocalVideoDisabled()
      }
      try {
        await this.session.enableLocalVideo(!nextMuted)
        if (this.disposed) return
        if (!nextMuted) {
          try {
            await this.session.startPreview()
            if (this.disposed) return
          } catch (error) {
            if (this.disposed) return
            // 预览失败时关闭刚恢复的采集，避免 UI 显示关闭而摄像头仍工作。
            await this.session.enableLocalVideo(false).catch(() => {})
            if (this.disposed) return
            throw error
          }
        }
      } catch (error) {
        // 关闭失败时恢复此前解绑的 Canvas；开启失败则保持原有关闭占位。
        if (!this.disposed && nextMuted && typeof this.onLocalVideoChanged === 'function') {
          this.onLocalVideoChanged(this.videoMuted)
        }
        throw error
      }
      this.videoMuted = nextMuted
      this.$emit('video-changed', {
        muted: nextMuted
      })
      if (typeof this.onLocalVideoChanged === 'function') this.onLocalVideoChanged(nextMuted)
    },
    async switchCamera() {
      if (!this.isVideo || this.videoMuted || !this.joined) return
      await this.session.switchCamera()
      if (this.disposed) return
      this.$emit('camera-changed')
    },
    /** 原生路由设置成功后才更新 UI；外部耳机连接时系统可能覆盖该偏好。 */
    async setSpeakerphoneEnabled(enabled) {
      if (!this.session || !this.session.engineReady || this.disposed) return
      const nextEnabled = Boolean(enabled)
      await this.session.setSpeakerphoneEnabled(nextEnabled)
      if (this.disposed) return
      this.speakerphoneEnabled = nextEnabled
      this.$emit('speaker-changed', { enabled: nextEnabled })
    },
    async suspendPreview() {
      if (!this.isVideo || this.videoMuted || this.disposed || !this.session || !this.session.engineReady) return
      this.previewSuspended = true
      try {
        await this.session.stopPreview()
      } catch (error) {
        this.previewSuspended = false
        throw error
      }
    },
    /**
     * 恢复预览后重新绑定原生视图：Android 退后台会销毁 Surface，仅 startPreview
     * 不一定能把画面接回旧 Canvas。
     */
    async resumePreview() {
      if (!this.previewSuspended || this.disposed || !this.session || !this.session.engineReady) return
      if (this.videoMuted) {
        this.previewSuspended = false
        return
      }
      // 只有原生恢复成功后才清除标志，失败时允许 onShow 或业务方再次重试。
      await this.session.startPreview()
      this.previewSuspended = false
      if (typeof this.onPreviewResumed === 'function') this.onPreviewResumed()
    },
    handleConnectionStateChanged(data) {
      const state = Number(data.state)
      const reason = Number(data.reason)
      if (state === RTC_CONNECTION_STATE.RECONNECTING) {
        this.reconnecting = true
        this.statusText = '网络不稳定，正在重连…'
      } else if (state === RTC_CONNECTION_STATE.CONNECTED) {
        if (this.reconnecting) {
          this.reconnecting = false
          this.statusText = '连接已恢复'
        }
      } else if (state === RTC_CONNECTION_STATE.DISCONNECTED || state === RTC_CONNECTION_STATE.FAILED) {
        this.reconnecting = false
      }
      if (state === RTC_CONNECTION_STATE.FAILED) this.handleConnectionFailure(data)
      this.$emit('connection-changed', {
        state,
        reason
      })
      if (typeof this.onConnectionStateChanged === 'function') this.onConnectionStateChanged(data)
    },
    /** 入房中的失败由 joinChannelAndWait 统一 reject，避免同一错误上报两次。 */
    handleConnectionFailure(data) {
      if (this.joining) return
      // Session 统一进入 failed，并保留频道清理信息供下一次 join 重试。
      const error = this.session.handleConnectionFailure(data)
      this.reportError(error)
      if (typeof this.onConnectionFailure === 'function') this.onConnectionFailure(error)
    },
    /** 原生布局后的延迟绑定失败也进入统一错误分类和 UI 错误状态。 */
    reportVideoBindError(data) {
      const payload = data && data.detail ? data.detail : data
      const code = Number(payload && payload.code)
      const operation = payload && payload.operation === 'unbindVideo' ? 'unbindVideo' : 'bindVideo'
      this.reportError(createNativeError(Number.isFinite(code) ? code : -1, operation))
    },
    /** 原生视图方法不走 Engine Facade，在 UI 边界补充可检索调用日志。 */
    logVideoViewApi(operation, ref, uid, result) {
      const details = { ref, uid, result }
      // iOS nvue 方法调用可能已执行但不回传返回值；真实错误由 bind-error 事件报告。
      if (result === null || result === undefined) rtcLogger.debug(`API ${operation} SUBMITTED`, details)
      else if (Number(result) === 0) rtcLogger.debug(`API ${operation} SUCCESS`, details)
      else rtcLogger.error(`API ${operation} ERROR`, details)
    },
    handleJoinTimeout(data) {
      if (this.joining) return
      const error = new RtcError('加入频道超时，请检查网络或 Token', {
        category: RTC_ERROR_CATEGORY.TIMEOUT,
        operation: 'joinChannel',
        code: data && data.timeout,
        userMessage: '加入频道超时，请检查网络或 Token 后重试'
      })
      this.updateCallState(CALL_UI_STATE.FAILED, CALL_STATE.FAILED)
      this.reportError(error)
    }
  }
}
