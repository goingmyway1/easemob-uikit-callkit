import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CallKitCore, CallKitEvent } from '@easemob-community/callkit-core-v5'
import { createCallUiBridge } from './callUiBridge'
import { attachCallStageHost, CALL_STAGE_ACTION } from './callStageHost'

// Load Node-only test APIs without adding Node types to the App runtime package.
const { readFileSync } = await vi.importActual<{ readFileSync(path: URL, encoding: 'utf8'): string }>('node:fs')
const { runInNewContext } = await vi.importActual<{
  runInNewContext(code: string, globals: Record<string, unknown>, options: { filename: string }): any
}>('node:vm')

// Execute the checked-in scripts with native imports stubbed, not source-pattern assertions.
function loadOptions(relative: string, globals: Record<string, unknown> = {}): any {
  const path = new URL(relative, import.meta.url)
  const file = readFileSync(path, 'utf8')
  const script = file.includes('<script>') ? file.split('<script>')[1].split('</script>')[0] : file
  const executable = script
    .replace(/^\s*import\s+[\s\S]*?\s+from\s+['"][^'"]+['"];?/gm, '')
    .replace(/export const /g, 'const ')
    .replace('export default', 'return')
  return runInNewContext(`(function () { ${executable}\n})()`, {
    AgoraCallOneToOne: {}, AgoraCallGroup: {}, AgoraCallIcon: {}, EmCallStage: {},
    console, setTimeout, clearTimeout, setInterval, clearInterval, ...globals
  }, { filename: path.pathname })
}

function instance(options: any, props: Record<string, unknown> = {}): any {
  const layers = [...(options.mixins || []), options]
  const vm: any = { $refs: {}, $emit: vi.fn(), $nextTick: (fn: () => unknown) => Promise.resolve().then(fn) }
  for (const layer of layers) {
    for (const [key, prop] of Object.entries<any>(layer.props || {})) {
      vm[key] = typeof prop.default === 'function' ? prop.default() : prop.default
    }
  }
  Object.assign(vm, props)
  for (const layer of layers) Object.assign(vm, layer.data?.call(vm))
  for (const layer of layers) {
    for (const [key, method] of Object.entries<any>(layer.methods || {})) vm[key] = method.bind(vm)
    for (const [key, getter] of Object.entries<any>(layer.computed || {})) {
      Object.defineProperty(vm, key, { configurable: true, get: () => getter.call(vm) })
    }
  }
  for (const layer of layers) layer.created?.call(vm)
  return vm
}

function deferred() {
  let resolve!: () => void
  let reject!: (error: unknown) => void
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

async function flush() {
  for (let i = 0; i < 16; i++) await Promise.resolve()
}

const stage = loadOptions('../../components/em-call-stage/em-call-stage.nvue')
const page = loadOptions('../../../../pages/call/call.nvue')
const video = loadOptions('../../components/em-call-video-view/em-call-video-view.nvue')
const defaultView = () => ({ visible: true, shouldJoin: true, appId: 'app', channelName: 'channel', uid: 1,
  mediaType: 'video', groupMode: false, audioMuted: false, videoMuted: false, audioCommandId: 0, videoCommandId: 0 })

function stageHarness() {
  const vm = instance(stage, { view: defaultView() })
  const target = { join: vi.fn(async () => {}), setAudioMuted: vi.fn(async (_muted: boolean) => {}), setVideoMuted: vi.fn(async (_muted: boolean) => {}) }
  vm.$refs.call = target
  vm.joinedUid = 1
  const command = (kind: 'audio' | 'video', id: number, muted: boolean) => {
    vm.view = { ...vm.view, [kind + 'CommandId']: id, [kind + 'Muted']: muted }
    stage.watch['view.' + kind + 'CommandId'].call(vm)
  }
  return { vm, target, command }
}

function mediaCore() {
  const state = { audioEnabled: true, videoEnabled: true }
  const raw = { getSingleCallState: () => ({ ...state }),
    toggleAudio: vi.fn(() => { state.audioEnabled = !state.audioEnabled }),
    toggleVideo: vi.fn(() => { state.videoEnabled = !state.videoEnabled }),
    reportRtcEvent: vi.fn(), getCurrentCallId: () => 'call', canAccept: () => false,
    hangup: vi.fn(async () => {}), answerCall: vi.fn(async () => {}) }
  return { state, raw, core: raw as unknown as CallKitCore }
}

afterEach(() => vi.unstubAllGlobals())

describe('executable nvue media queues', () => {
  it('runs audio/video concurrently and tags receipts even when native events lack IDs', async () => {
    const { vm, target, command } = stageHarness()
    const a = deferred()
    const v = deferred()
    target.setAudioMuted.mockImplementation(async (muted) => { await a.promise; vm.handleAudioChanged({ muted }) })
    target.setVideoMuted.mockImplementation(async (muted) => { await v.promise; vm.handleVideoChanged({ muted }) })
    command('audio', 1, true)
    command('video', 1, true)
    expect(target.setAudioMuted).toHaveBeenCalledWith(true)
    expect(target.setVideoMuted).toHaveBeenCalledWith(true)
    v.resolve()
    await flush()
    expect(vm.$emit.mock.calls).toEqual([['video-changed', { muted: true, commandId: 1 }]])
    expect(vm.audioQueue.running).toBe(true)
    a.resolve()
    await flush()
    expect(vm.$emit.mock.calls).toEqual([
      ['video-changed', { muted: true, commandId: 1 }], ['audio-changed', { muted: true, commandId: 1 }]
    ])
    vm.handleAudioChanged({ muted: false })
    expect(vm.$emit).toHaveBeenLastCalledWith('audio-changed', { muted: false })
  })

  it.each(['audio', 'video'] as const)('serializes %s, skips intermediate requests and consumes each ID once', async (kind) => {
    const { vm, target, command } = stageHarness()
    const pending = deferred()
    const method = kind === 'audio' ? target.setAudioMuted : target.setVideoMuted
    method.mockImplementationOnce(() => pending.promise)
    command(kind, 1, true)
    command(kind, 2, true)
    command(kind, 3, false)
    expect(method).toHaveBeenCalledTimes(1)
    pending.resolve()
    await flush()
    expect(method.mock.calls).toEqual([[true], [false]])
    expect(vm.$emit.mock.calls).toEqual([
      [kind + '-changed', { muted: true, commandId: 1 }], [kind + '-changed', { muted: false, commandId: 3 }]
    ])
    vm.applyMediaCommands()
    command(kind, 2, true)
    expect(method).toHaveBeenCalledTimes(2)
  })

  it.each(['audio', 'video'] as const)('reports %s failure with the executing ID, not the newest snapshot ID', async (kind) => {
    const { vm, target, command } = stageHarness()
    const pending = deferred()
    const method = kind === 'audio' ? target.setAudioMuted : target.setVideoMuted
    method.mockImplementationOnce(() => pending.promise)
    command(kind, 1, true)
    command(kind, 2, false)
    pending.reject(new Error('old failure'))
    await flush()
    expect(vm.$emit.mock.calls).toEqual([
      ['media-command-failed', { kind, commandId: 1, error: 'old failure' }],
      [kind + '-changed', { muted: false, commandId: 2 }]
    ])
    expect(vm.$emit.mock.calls.some((call: any[]) => call[0] === 'rtc-report')).toBe(false)
  })

  it('executes stage → page → host → bridge success/failure protocol without a feedback loop', async () => {
    const { core, state, raw } = mediaCore()
    const bridge = createCallUiBridge({ core })
    bridge.handleEvent({ type: 'shouldJoinRtc', payload: { callId: 'call', appId: 'app', channel: 'channel', uid: 1, callType: 1, role: 'caller' } } as CallKitEvent)
    const vm = instance(stage, { view: bridge.getView() })
    vm.joinedUid = 1
    const handlers = new Set<(action: any) => void>()
    vi.stubGlobal('uni', { $on: (_event: string, fn: any) => handlers.add(fn), $off: (_event: string, fn: any) => handlers.delete(fn),
      $emit: (event: string, action: any) => { if (event === CALL_STAGE_ACTION) handlers.forEach(fn => fn(action)) } })
    const pageVm = instance(page)
    // The page tags every action with the call it owns.
    pageVm.pageCallId = 'call'
    pageVm.view = { ...pageVm.view, visible: true, callId: 'call' }
    // Page scripts have their own global uni binding, as they do in the native context.
    const routedPage = loadOptions('../../../../pages/call/call.nvue', { uni: (globalThis as any).uni })
    Object.assign(pageVm, Object.fromEntries(Object.entries<any>(routedPage.methods).map(([key, fn]) => [key, fn.bind(pageVm)])))
    vm.$emit.mockImplementation((event: string, payload: any) => {
      if (event === 'audio-changed') pageVm.onAudioChanged(payload)
      if (event === 'video-changed') pageVm.onVideoChanged(payload)
      if (event === 'media-command-failed') pageVm.onMediaCommandFailed(payload)
    })
    const off = attachCallStageHost({ callUi: bridge, core })
    const unsubscribe = bridge.onChange((view) => { vm.view = view; vm.applyMediaCommands() })
    const old = deferred()
    const latest = deferred()
    const setAudioMuted = vi.fn(async (muted: boolean) => vm.handleAudioChanged({ muted }))
      .mockImplementationOnce(() => old.promise).mockImplementationOnce(() => latest.promise)
    const setVideoMuted = vi.fn(async (muted: boolean) => vm.handleVideoChanged({ muted }))
    vm.$refs.call = { setAudioMuted, setVideoMuted }
    await bridge.setAudioMuted(true)
    await bridge.setVideoMuted(true)
    await bridge.setAudioMuted(false)
    old.reject(new Error('obsolete'))
    await flush()
    expect(state).toEqual({ audioEnabled: true, videoEnabled: false })
    latest.reject(new Error('latest failure'))
    await flush()
    expect(state).toEqual({ audioEnabled: false, videoEnabled: false })
    expect(bridge.getView()).toMatchObject({ audioMuted: true, initialAudioMuted: true })
    expect(raw.toggleAudio).toHaveBeenCalledTimes(3)
    expect(setAudioMuted).toHaveBeenCalledTimes(2)
    expect(setVideoMuted).toHaveBeenCalledTimes(1)
    off()
    unsubscribe()
  })

  it('waits for join and applies only the current prejoin snapshot', async () => {
    const { vm, target, command } = stageHarness()
    vm.joinedUid = 0
    command('audio', 1, true)
    command('audio', 2, false)
    command('video', 1, true)
    expect(target.setAudioMuted).not.toHaveBeenCalled()
    vm.handleJoined({ uid: 1 })
    await flush()
    expect(target.setAudioMuted.mock.calls).toEqual([[false]])
    expect(target.setVideoMuted.mock.calls).toEqual([[true]])
  })

  it.each(['hidden', 'group', 'channel', 'newCall', 'notReady', 'left', 'ref', 'vue2', 'vue3'] as const)('invalidates old native work on %s and leaves rebuilt queues independent', async (action) => {
    const { vm, target, command } = stageHarness()
    const old = deferred()
    target.setAudioMuted.mockImplementationOnce(() => old.promise)
    command('audio', 1, true)
    command('audio', 2, false)
    if (action === 'hidden') { vm.view.visible = false; stage.watch['view.visible'].call(vm, false) }
    if (action === 'group') stage.watch['view.groupMode'].call(vm)
    if (action === 'channel') stage.watch['view.channelName'].call(vm)
    if (action === 'newCall') {
      const oldKey = vm.componentKey
      vm.view.callId = 'next-call'
      expect(vm.componentKey).not.toBe(oldKey)
      stage.watch['view.callId'].call(vm)
    }
    if (action === 'notReady') stage.watch.mediaReady.call(vm, false)
    if (action === 'left') vm.handleLeft()
    if (action === 'vue2') stage.beforeDestroy.call(vm)
    if (action === 'vue3') stage.beforeUnmount.call(vm)
    const rebuilt = { join: vi.fn(async () => {}), setAudioMuted: vi.fn(async () => {}) }
    vm.$refs.call = rebuilt
    if (action === 'ref') stage.updated.call(vm)
    vm.$emit.mockClear()
    vm.view.visible = true
    const current = deferred()
    rebuilt.setAudioMuted.mockImplementationOnce(() => current.promise)
    vm.joinedUid = 1
    command('audio', 3, true)
    old.reject(new Error('retired task'))
    await flush()
    expect(vm.$emit).not.toHaveBeenCalled()
    expect(target.setAudioMuted).toHaveBeenCalledTimes(1)
    if (action !== 'vue2' && action !== 'vue3') {
      expect(vm.audioQueue.running).toBe(true)
      command('audio', 4, false)
      expect(rebuilt.setAudioMuted).toHaveBeenCalledTimes(1)
      current.resolve()
      await flush()
      expect(rebuilt.setAudioMuted).toHaveBeenCalledTimes(2)
    } else {
      expect(rebuilt.setAudioMuted).not.toHaveBeenCalled()
      stage.beforeDestroy.call(vm)
      stage.beforeUnmount.call(vm)
    }
  })

  it('invalidates a scheduled join and a rejected old join on teardown/rebuild', async () => {
    const { vm, target } = stageHarness()
    const tick = vi.fn()
    vm.$nextTick = tick
    vm.joinCall()
    stage.beforeUnmount.call(vm)
    tick.mock.calls[0][0]()
    expect(target.join).not.toHaveBeenCalled()
    const second = stageHarness()
    const pending = deferred()
    second.target.join.mockImplementationOnce(() => pending.promise)
    second.vm.joinCall()
    await flush()
    second.vm.resetCallComponent()
    second.vm.joined = true
    pending.reject(new Error('old join'))
    await flush()
    expect(second.vm.joined).toBe(true)
    expect(second.vm.$emit).not.toHaveBeenCalled()
  })
})

function previewHarness(componentPath: string, uni: Record<string, unknown>) {
  const session = { engineReady: true, state: 'idle', onStateChange: vi.fn(), on: vi.fn(),
    stopPreview: vi.fn(async () => {}), startPreview: vi.fn(async () => {}), dispose: vi.fn(async () => {}),
    join: vi.fn(async (_options: any) => {}), muteLocalAudio: vi.fn(async (_muted: boolean) => {}), enableLocalVideo: vi.fn(async (_enabled: boolean) => {}) }
  const mixin = loadOptions('../../../../uni_modules/agora-rtc/mixins/call-component.js', {
    uni, RtcCallSession: class { constructor() { return session } },
    CALL_STATE: { IDLE: 'idle', READY: 'ready', JOINED: 'joined' }, RTC_EVENT: {}, RTC_CONNECTION_STATE: {},
    RTC_ERROR_CATEGORY: { CANCELLED: 'cancelled' }, rtcLogger: { error: vi.fn() }
  })
  const component = loadOptions(componentPath, { uni, callComponent: mixin })
  const vm = instance(component, { autoJoin: false, mediaType: 'video', appId: 'app', channelName: 'channel' })
  vm.onPreviewResumed = vi.fn()
  vm.beforeCallDispose = vi.fn()
  mixin.mounted.call(vm)
  return { vm, session, mixin, component }
}

const previewComponents = [
  '../../../../uni_modules/agora-rtc/components/agora-call-one-to-one/agora-call-one-to-one.nvue',
  '../../../../uni_modules/agora-rtc/components/agora-call-group/agora-call-group.nvue'
]

describe('shared component App preview lifecycle', () => {
  it.each(previewComponents)('pairs hide/show once through the shared mixin in %s', async (path) => {
    const uni = { onAppHide: vi.fn(), onAppShow: vi.fn(), offAppHide: vi.fn(), offAppShow: vi.fn() }
    const { vm, session, mixin, component } = previewHarness(path, uni)
    expect(component.mixins[0]).toBe(mixin)
    vm.registerAppPreviewEvents()
    expect(uni.onAppHide).toHaveBeenCalledTimes(1)
    expect(uni.onAppShow).toHaveBeenCalledTimes(1)
    const hide = uni.onAppHide.mock.calls[0][0]
    const show = uni.onAppShow.mock.calls[0][0]
    const pending = deferred()
    session.stopPreview.mockImplementationOnce(() => pending.promise)
    hide(); hide(); show(); show()
    await flush()
    expect(session.stopPreview).toHaveBeenCalledTimes(1)
    expect(session.startPreview).not.toHaveBeenCalled()
    pending.resolve()
    await vm.previewAppQueue
    expect(session.startPreview).toHaveBeenCalledTimes(1)
    expect(vm.onPreviewResumed).toHaveBeenCalledTimes(1)
    expect(vm.previewSuspended).toBe(false)
    mixin.beforeDestroy.call(vm)
    mixin.beforeUnmount.call(vm)
    await flush()
    expect(uni.offAppHide).toHaveBeenCalledTimes(1)
    expect(uni.offAppShow).toHaveBeenCalledTimes(1)
    expect(uni.offAppHide).toHaveBeenCalledWith(hide)
    expect(uni.offAppShow).toHaveBeenCalledWith(show)
    expect(session.dispose).toHaveBeenCalledTimes(1)
    hide(); show(); vm.registerAppPreviewEvents()
    await flush()
    expect(session.startPreview).toHaveBeenCalledTimes(1)
    expect(uni.onAppHide).toHaveBeenCalledTimes(1)
  })

  it('handles partial APIs, invalidates old handlers on unregister and re-registers once', async () => {
    const uni: any = { onAppHide: vi.fn(), offAppHide: vi.fn(), offAppShow: vi.fn() }
    const { vm, session } = previewHarness(previewComponents[1], uni)
    const oldHide = uni.onAppHide.mock.calls[0][0]
    uni.onAppShow = vi.fn()
    vm.registerAppPreviewEvents()
    expect(uni.onAppHide).toHaveBeenCalledTimes(1)
    expect(uni.onAppShow).toHaveBeenCalledTimes(1)
    vm.unregisterAppPreviewEvents()
    vm.unregisterAppPreviewEvents()
    vm.registerAppPreviewEvents()
    oldHide()
    await flush()
    expect(session.stopPreview).not.toHaveBeenCalled()
    expect(uni.onAppHide).toHaveBeenCalledTimes(2)
    expect(uni.onAppShow).toHaveBeenCalledTimes(2)
    await vm.dispose()
    expect(uni.offAppHide).toHaveBeenCalledTimes(2)
  })

  it.each(['audio', 'muted', 'notReady'] as const)('does not start or stop preview for %s', async (mode) => {
    const uni = { onAppHide: vi.fn(), onAppShow: vi.fn() }
    const { vm, session } = previewHarness(previewComponents[1], uni)
    if (mode === 'audio') vm.mediaType = 'audio'
    if (mode === 'muted') vm.videoMuted = true
    if (mode === 'notReady') session.engineReady = false
    uni.onAppHide.mock.calls[0][0]()
    uni.onAppShow.mock.calls[0][0]()
    await vm.previewAppQueue
    expect(session.stopPreview).not.toHaveBeenCalled()
    expect(session.startPreview).not.toHaveBeenCalled()
  })

  it('allows show to retry a failed resume and never rebinds after dispose', async () => {
    const uni = { onAppHide: vi.fn(), onAppShow: vi.fn(), offAppHide: vi.fn(), offAppShow: vi.fn() }
    const { vm, session } = previewHarness(previewComponents[0], uni)
    const hide = uni.onAppHide.mock.calls[0][0]
    const show = uni.onAppShow.mock.calls[0][0]
    hide()
    await vm.previewAppQueue
    session.startPreview.mockRejectedValueOnce(new Error('resume failed'))
    show()
    await vm.previewAppQueue
    expect(vm.previewSuspended).toBe(true)
    expect(vm.$emit).toHaveBeenCalledWith('error', expect.anything())
    const pending = deferred()
    session.startPreview.mockImplementationOnce(() => pending.promise)
    show()
    await flush()
    await vm.dispose()
    pending.resolve()
    await flush()
    expect(vm.previewSuspended).toBe(false)
    expect(vm.onPreviewResumed).not.toHaveBeenCalled()
  })

  it('copies prejoin props into UI and the actual session.join arguments', async () => {
    const { vm, session, mixin } = previewHarness(previewComponents[1], {})
    vm.initialAudioMuted = true
    vm.initialVideoMuted = true
    mixin.watch.initialAudioMuted.call(vm, true)
    mixin.watch.initialVideoMuted.call(vm, true)
    expect(vm.audioMuted).toBe(true)
    expect(vm.videoMuted).toBe(true)
    await vm.join()
    expect(session.join).toHaveBeenCalledWith(expect.objectContaining({ initialAudioMuted: true, initialVideoMuted: true }))
  })

  it.each(['audio', 'video'] as const)('does not emit an old %s result after component disposal', async (kind) => {
    const { vm, session } = previewHarness(previewComponents[1], {})
    const pending = deferred()
    if (kind === 'audio') session.muteLocalAudio.mockImplementationOnce(() => pending.promise)
    else session.enableLocalVideo.mockImplementationOnce(() => pending.promise)
    const task = kind === 'audio' ? vm.setAudioMuted(true) : vm.setVideoMuted(true)
    await vm.dispose()
    pending.resolve()
    await task
    expect(vm.$emit.mock.calls.some((call: any[]) => call[0] === kind + '-changed')).toBe(false)
  })
})

describe('page close protocol', () => {
  it('unload without back reports the owned call, and late snapshots cannot retag the page', () => {
    const emitted: Array<{ event: string; payload: any }> = []
    const uni = {
      $on: vi.fn(),
      $off: vi.fn(),
      $emit: (event: string, payload: any) => emitted.push({ event, payload }),
      getSystemInfoSync: () => ({ statusBarHeight: 0 })
    }
    const pageOptions = loadOptions('../../../../pages/call/call.nvue', {
      uni,
      plus: { navigator: { setStatusBarStyle: vi.fn() } }
    })
    const vm = instance(pageOptions)
    vm.pageCallId = 'call_1'
    vm.view = { ...vm.view, visible: true, callId: 'call_1' }

    pageOptions.onUnload.call(vm)

    expect(emitted).toContainEqual({
      event: CALL_STAGE_ACTION,
      payload: expect.objectContaining({ type: 'closed', callId: 'call_1' })
    })
    // 页面已关闭：后续快照（哪怕属于新通话）不得改写本页归属
    pageOptions.methods.handleView.call(vm, { ...vm.view, visible: true, callId: 'call_2' })
    expect(vm.pageCallId).toBe('call_1')
    expect(vm.view.callId).toBe('call_1')
  })
})

describe('iOS-compatible em-call-video-view bind results', () => {
  it.each([undefined, null, 0, '0', '-1', false])('does not report a native error for %s', (result) => {
    const vm = instance(video)
    vm.$refs.nativeVideo = { bindVideo: vi.fn(() => result) }
    expect(vm.bindVideo(1)).toBe(result)
    expect(vm.$emit).not.toHaveBeenCalled()
  })

  it.each([-1, -2, 17])('reports numeric nonzero bind result %s', (code) => {
    const vm = instance(video)
    vm.$refs.nativeVideo = { bindVideo: vi.fn(() => code) }
    expect(vm.bindVideo(1)).toBe(code)
    expect(vm.$emit).toHaveBeenCalledWith('bind-error', { uid: 1, code, operation: 'bindVideo' })
  })

  it('keeps invalid UID errors and forwards asynchronous native bind errors', () => {
    const vm = instance(video, { uid: -1 })
    vm.bindVideo(vm.normalizeUid())
    expect(vm.$emit).toHaveBeenCalledWith('bind-error', { uid: -1, code: -2, operation: 'bindVideo' })
    const event = { detail: { uid: 1, code: -7, operation: 'bindVideo' } }
    vm.onBindError(event)
    expect(vm.$emit).toHaveBeenLastCalledWith('bind-error', event)
  })
})
