import type { CallKitCore, RtcReport } from '@easemob-community/callkit-core-v5'
import type { CallUiBridge, CallViewProps } from './callUiBridge'

/**
 * 通话页（nvue）与宿主（vue）之间的通信协议。
 *
 * 为什么不能直接把 `callkit` 传给页面：
 * uni-app App 端 `.vue` 页面跑在 WebView 的 JS 里，`.nvue` 页面跑在原生渲染引擎独立的
 * JS 上下文里，**两者的模块单例不共享**（官方原文：「vue 和 nvue 之间不公用」）。
 * 所以在 index.vue 里创建的 callkit，到 call.nvue 里 `getCallKit()` 一定是 null。
 * globalData / vuex 也只能过 JSON 可序列化的数据，函数与类实例过不去。
 *
 * 因此约定：
 * - 宿主 → 页面：`uni.$emit(CALL_STAGE_VIEW, viewSnapshot)`，view 是纯 JSON
 * - 页面 → 宿主：`uni.$emit(CALL_STAGE_ACTION, { type, ... })`，宿主查表执行
 */
export const CALL_STAGE_VIEW = 'em-callkit:view'
export const CALL_STAGE_ACTION = 'em-callkit:action'

export type CallStageAction =
  /** Requests only the current snapshot; ready never mutates a call. */
  | { type: 'ready' }
  // Optional for source compatibility only. Untagged actions are rejected at runtime.
  | ({ callId?: string } & (
    | { type: 'accept' }
    | { type: 'refuse' }
    | { type: 'hangup' }
    | { type: 'back' }
    | { type: 'rtc-event'; report: RtcReport }
    | { type: 'audio-muted'; muted: boolean; commandId?: number }
    | { type: 'video-muted'; muted: boolean; commandId?: number }
    | { type: 'media-command-failed'; kind: 'audio' | 'video'; commandId: number; error?: string }
    | { type: 'error'; error: string }
    /** Also terminates a matching active call on unexpected page unload. */
    | { type: 'closed' }
  ))

export interface CallStageHostOptions {
  callUi: CallUiBridge
  core: CallKitCore
  /** nvue 页面退场回调（复位“是否已在通话页”的标记） */
  onClosed?: () => void
  logger?: (message: string, data?: unknown) => void
}

/**
 * 在 vue 侧挂载通信中继。登录成功后调用一次，`logout` 时释放。
 * 返回 detach 函数，可重复调用（幂等）。
 */
export function attachCallStageHost(options: CallStageHostOptions): () => void {
  const { callUi, core } = options
  const log = (message: string, data?: unknown) => options.logger?.(`[CallStageHost] ${message}`, data)
  let disposed = false

  let navigationCallId = callUi.getView().callId
  let endingCallId: string | undefined

  const emitView = (view: CallViewProps = callUi.getView()) => {
    if (disposed) return
    if (view.visible && view.callId) navigationCallId = view.callId
    // Send a snapshot, never a mutable bridge reference.
    uni.$emit(CALL_STAGE_VIEW, { ...view })
  }

  const offChange = callUi.onChange((view) => emitView(view))

  const answer = (callId: string, result: 'accept' | 'refuse') => core.answerCall({ callId, result })
  const end = (callId: string, refuse: boolean) => {
    if (endingCallId === callId) return
    endingCallId = callId
    Promise.resolve(refuse ? answer(callId, 'refuse') : core.hangup({ callId })).catch((error) => {
      if (endingCallId === callId) endingCallId = undefined
      log('End call failed', error)
    })
  }

  const handler = (action: CallStageAction) => {
    if (disposed || !action || typeof action.type !== 'string') return
    if (action.type === 'ready') {
      emitView()
      return
    }
    const callId = action.callId
    if (typeof callId !== 'string' || !callId) return
    const activeCallId = core.getCurrentCallId()
    if (action.type === 'closed') {
      // Navigation belongs to the last visible call, even after Core has ended it.
      // Never reset the shared navigation flag for a newer active/visible call.
      if (callId === navigationCallId && (!activeCallId || activeCallId === callId)) {
        navigationCallId = undefined
        options.onClosed?.()
      }
      const view = callUi.getView()
      // A hidden snapshot is a normal finish, not an unexpected unload.
      if (callId === activeCallId && view.visible && view.callId === callId) end(callId, core.canAccept())
      return
    }
    if (callId !== activeCallId) return
    switch (action.type) {
      case 'accept':
        if (endingCallId !== callId) {
          Promise.resolve(answer(callId, 'accept')).catch((error) => log('Accept failed', error))
        }
        break
      case 'refuse':
        end(callId, true)
        break
      case 'hangup':
        end(callId, false)
        break
      case 'back':
        end(callId, core.canAccept())
        break
      case 'rtc-event':
        void callUi.reportRtcEvent(action.report).catch((error) => log('RTC 事件上报失败', error))
        break
      case 'audio-muted':
        callUi.syncMediaToCore({
          audioMuted: Boolean(action.muted),
          ...(typeof action.commandId === 'number' ? { audioCommandId: action.commandId } : {})
        })
        break
      case 'video-muted':
        callUi.syncMediaToCore({
          videoMuted: Boolean(action.muted),
          ...(typeof action.commandId === 'number' ? { videoCommandId: action.commandId } : {})
        })
        break
      case 'media-command-failed':
        callUi.handleMediaCommandError?.(action.kind, action.commandId, action.error || '原生媒体命令失败')
        break
      case 'error':
        log('Stage error', action.error)
        break
      default:
        log('未知动作', action)
        break
    }
  }

  uni.$on(CALL_STAGE_ACTION, handler)

  return () => {
    if (disposed) return
    disposed = true
    offChange()
    uni.$off(CALL_STAGE_ACTION, handler)
  }
}
