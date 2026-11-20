import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CallKitCore } from '@easemob-community/callkit-core-v5'
import type { CallUiBridge, CallViewProps } from './callUiBridge'
import { CALL_STAGE_ACTION, CALL_STAGE_VIEW, attachCallStageHost } from './callStageHost'

type Handler = (payload: any) => void

const bus = new Map<string, Set<Handler>>()
const emitted: Array<{ event: string; payload: any }> = []

/** 模拟 uni-app 的事件总线（vue 与 nvue 之间就是靠它通信） */
;(globalThis as any).uni = {
  $on(event: string, handler: Handler) {
    if (!bus.has(event)) bus.set(event, new Set())
    bus.get(event)!.add(handler)
  },
  $off(event: string, handler?: Handler) {
    if (!handler) bus.delete(event)
    else bus.get(event)?.delete(handler)
  },
  $emit(event: string, payload?: unknown) {
    emitted.push({ event, payload })
    bus.get(event)?.forEach((handler) => handler(payload))
  }
}

function createEmptyView(): CallViewProps {
  return {
    visible: false,
    appId: '',
    channelName: '',
    token: '',
    uid: 0,
    mediaType: 'audio',
    callDirection: 'outgoing',
    ringing: false,
    shouldJoin: false,
    groupMode: false,
    groupId: '',
    groupName: '',
    remoteName: '',
    remoteAvatar: '',
    groupParticipants: [],
    groupRtcProfiles: {},
    groupWaiting: false,
    initialAudioMuted: false,
    initialVideoMuted: false,
    audioMuted: false,
    videoMuted: false,
    audioCommandId: 0,
    videoCommandId: 0
  }
}

function createHarness() {
  const view = createEmptyView()
  const listeners = new Set<(next: CallViewProps) => void>()
  const callUi = {
    getView: vi.fn(() => ({ ...view })),
    onChange: vi.fn((listener: (next: CallViewProps) => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    }),
    syncMediaToCore: vi.fn(),
    reportRtcEvent: vi.fn(async () => undefined)
  } as unknown as CallUiBridge

  const core = {
    getCurrentCallId: vi.fn(() => 'call_1'),
    canAccept: vi.fn(() => false),
    answerCall: vi.fn(async () => undefined),
    hangup: vi.fn(async () => undefined)
  } as unknown as CallKitCore

  /** 模拟宿主侧状态变化并把快照推给监听者 */
  const push = (next: Partial<CallViewProps>) => {
    Object.assign(view, next)
    listeners.forEach((listener) => listener({ ...view }))
  }

  return { callUi, core, push }
}

const viewEmits = () => emitted.filter((item) => item.event === CALL_STAGE_VIEW)

describe('attachCallStageHost', () => {
  beforeEach(() => {
    bus.clear()
    emitted.length = 0
  })

  it('页面 ready → 立刻回推一次快照', () => {
    const { callUi, core } = createHarness()
    attachCallStageHost({ callUi, core })

    bus.get(CALL_STAGE_ACTION)!.forEach((handler) => handler({ type: 'ready' }))

    expect(viewEmits()).toHaveLength(1)
    expect(viewEmits()[0].payload.visible).toBe(false)
  })

  it('callUi 变化 → 广播快照（跨上下文只能传可序列化数据）', () => {
    const { callUi, core, push } = createHarness()
    attachCallStageHost({ callUi, core })

    push({ visible: true, callDirection: 'incoming', ringing: true, remoteName: '张三' })

    const snapshot = viewEmits()
    const last = snapshot[snapshot.length - 1]
    expect(last.payload.visible).toBe(true)
    expect(last.payload.remoteName).toBe('张三')
  })

  it('accept → 转成 core.answerCall(accept)', async () => {
    const { callUi, core } = createHarness()
    attachCallStageHost({ callUi, core })

    bus.get(CALL_STAGE_ACTION)!.forEach((handler) => handler({ type: 'accept', callId: 'call_1' }))

    expect(core.answerCall).toHaveBeenCalledWith({ callId: 'call_1', result: 'accept' })
  })

  it('refuse → 转成 core.answerCall(refuse)', () => {
    const { callUi, core } = createHarness()
    attachCallStageHost({ callUi, core })

    bus.get(CALL_STAGE_ACTION)!.forEach((handler) => handler({ type: 'refuse', callId: 'call_1' }))

    expect(core.answerCall).toHaveBeenCalledWith({ callId: 'call_1', result: 'refuse' })
  })

  it('来电状态系统返回 → refuse，而不是只关闭页面', () => {
    const { callUi, core } = createHarness()
    ;(core.canAccept as any).mockReturnValue(true)
    attachCallStageHost({ callUi, core })

    bus.get(CALL_STAGE_ACTION)!.forEach((handler) => handler({ type: 'back', callId: 'call_1' }))

    expect(core.answerCall).toHaveBeenCalledWith({ callId: 'call_1', result: 'refuse' })
    expect(core.hangup).not.toHaveBeenCalled()
  })

  it('通话中系统返回 → hangup', () => {
    const { callUi, core } = createHarness()
    attachCallStageHost({ callUi, core })

    bus.get(CALL_STAGE_ACTION)!.forEach((handler) => handler({ type: 'back', callId: 'call_1' }))

    expect(core.hangup).toHaveBeenCalledTimes(1)
    expect(core.answerCall).not.toHaveBeenCalled()
  })

  it('没有进行中的通话时 accept 不调用 core', () => {
    const { callUi, core } = createHarness()
    ;(core.getCurrentCallId as any).mockReturnValue(null)
    attachCallStageHost({ callUi, core })

    bus.get(CALL_STAGE_ACTION)!.forEach((handler) => handler({ type: 'accept', callId: 'call_1' }))

    expect(core.answerCall).not.toHaveBeenCalled()
  })

  it('hangup / 静音回写', () => {
    const { callUi, core } = createHarness()
    attachCallStageHost({ callUi, core })

    bus.get(CALL_STAGE_ACTION)!.forEach((handler) => handler({ type: 'hangup', callId: 'call_1' }))
    bus.get(CALL_STAGE_ACTION)!.forEach((handler) => handler({ type: 'audio-muted', muted: true, callId: 'call_1' }))
    bus.get(CALL_STAGE_ACTION)!.forEach((handler) => handler({ type: 'video-muted', muted: false, callId: 'call_1' }))

    expect(core.hangup).toHaveBeenCalledTimes(1)
    expect(callUi.syncMediaToCore).toHaveBeenNthCalledWith(1, { audioMuted: true })
    expect(callUi.syncMediaToCore).toHaveBeenNthCalledWith(2, { videoMuted: false })
  })

  it('nvue RTC 生命周期、媒体和错误事件 → CallUiBridge', async () => {
    const { callUi, core } = createHarness()
    attachCallStageHost({ callUi, core })
    const reports = [
      { type: 'rtcJoined', payload: { uid: 1 } },
      { type: 'userJoined', payload: { uid: 9 } },
      { type: 'userAudioMuted', payload: { uid: 9 } },
      { type: 'userLeft', payload: { uid: 9 } },
      { type: 'rtcLeft', payload: { uid: 1 } },
      { type: 'error', payload: { error: 'native failed', errorCode: 17 } }
    ]

    reports.forEach((report) => {
      bus.get(CALL_STAGE_ACTION)!.forEach((handler) => handler({ type: 'rtc-event', report, callId: 'call_1' }))
    })
    await Promise.resolve()

    expect(callUi.reportRtcEvent).toHaveBeenCalledTimes(reports.length)
    reports.forEach((report, index) => {
      expect(callUi.reportRtcEvent).toHaveBeenNthCalledWith(index + 1, report)
    })
  })

  it('closed → 通知宿主复位导航标记', () => {
    const { callUi, core, push } = createHarness()
    const onClosed = vi.fn()
    attachCallStageHost({ callUi, core, onClosed })
    push({ visible: true, callId: 'call_1' })

    bus.get(CALL_STAGE_ACTION)!.forEach((handler) => handler({ type: 'closed', callId: 'call_1' }))

    expect(onClosed).toHaveBeenCalledTimes(1)
  })

  it('未携带 callId 或旧 callId 的动作一律不产生副作用', () => {
    const { callUi, core, push } = createHarness()
    const onClosed = vi.fn()
    attachCallStageHost({ callUi, core, onClosed })
    push({ visible: true, callId: 'call_1' })
    const emit = (action: Record<string, unknown>) =>
      bus.get(CALL_STAGE_ACTION)!.forEach((handler) => handler(action))

    // 无 callId：新协议下必须拒绝，避免旧页面误操作当前通话
    emit({ type: 'hangup' })
    emit({ type: 'accept' })
    emit({ type: 'audio-muted', muted: true })
    // 旧 callId：同样不得影响 call_1
    emit({ type: 'hangup', callId: 'call_old' })
    emit({ type: 'refuse', callId: 'call_old' })
    emit({ type: 'audio-muted', muted: true, callId: 'call_old' })
    emit({ type: 'closed', callId: 'call_old' })

    expect(core.hangup).not.toHaveBeenCalled()
    expect(core.answerCall).not.toHaveBeenCalled()
    expect(callUi.syncMediaToCore).not.toHaveBeenCalled()
    expect(onClosed).not.toHaveBeenCalled()
  })

  it('旧页面 closed 不得复位新通话的导航标记，也不得挂断新通话', () => {
    const { callUi, core, push } = createHarness()
    const onClosed = vi.fn()
    attachCallStageHost({ callUi, core, onClosed })
    push({ visible: true, callId: 'call_1' })
    push({ visible: true, callId: 'call_2' })
    ;(core.getCurrentCallId as any).mockReturnValue('call_2')

    bus.get(CALL_STAGE_ACTION)!.forEach((handler) => handler({ type: 'closed', callId: 'call_1' }))

    expect(onClosed).not.toHaveBeenCalled()
    expect(core.hangup).not.toHaveBeenCalled()
  })

  it('异常退场（页面仍可见）按当前角色拒接或挂断，重复 closed 幂等', () => {
    const { callUi, core, push } = createHarness()
    const onClosed = vi.fn()
    attachCallStageHost({ callUi, core, onClosed })
    push({ visible: true, callId: 'call_1' })
    ;(core.canAccept as any).mockReturnValue(true)
    const emit = () =>
      bus.get(CALL_STAGE_ACTION)!.forEach((handler) => handler({ type: 'closed', callId: 'call_1' }))

    emit()
    emit()

    expect(core.answerCall).toHaveBeenCalledTimes(1)
    expect(core.answerCall).toHaveBeenCalledWith({ callId: 'call_1', result: 'refuse' })
    expect(core.hangup).not.toHaveBeenCalled()
    expect(onClosed).toHaveBeenCalledTimes(1)
  })

  it('detach 后不再广播、也不再响应动作', () => {
    const { callUi, core, push } = createHarness()
    const detach = attachCallStageHost({ callUi, core })
    const countBefore = viewEmits().length

    detach()
    push({ visible: true })
    bus.get(CALL_STAGE_ACTION)!.forEach((handler) => handler({ type: 'hangup', callId: 'call_1' }))

    expect(viewEmits()).toHaveLength(countBefore)
    expect(core.hangup).not.toHaveBeenCalled()
  })

  it('detach 可重复调用', () => {
    const { callUi, core } = createHarness()
    const detach = attachCallStageHost({ callUi, core })

    expect(() => {
      detach()
      detach()
    }).not.toThrow()
  })
})
