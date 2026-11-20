import { describe, expect, it, vi } from 'vitest'
import { CALL_TYPE } from '@easemob-community/callkit-core-v5'
import type { CallKitCore, CallKitEvent } from '@easemob-community/callkit-core-v5'
import { createCallUiBridge, type CallViewComponent } from './callUiBridge'

function createFakeCore(overrides?: Partial<{ audioEnabled: boolean; videoEnabled: boolean }>) {
  const state = {
    audioEnabled: overrides?.audioEnabled ?? true,
    videoEnabled: overrides?.videoEnabled ?? true
  }
  const core = {
    getSingleCallState: vi.fn(() => ({ ...state })),
    toggleAudio: vi.fn(() => {
      state.audioEnabled = !state.audioEnabled
    }),
    toggleVideo: vi.fn(() => {
      state.videoEnabled = !state.videoEnabled
    }),
    reportRtcEvent: vi.fn()
  }
  return { core: core as unknown as CallKitCore, raw: core, state }
}

function createFakeComponent() {
  const component: CallViewComponent = {
    join: vi.fn(async () => ({ channel: 'ch' })),
    setAudioMuted: vi.fn(async () => {}),
    setVideoMuted: vi.fn(async () => {}),
    switchCamera: vi.fn(async () => {})
  }
  return component
}

function deferred<T = void>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

const incomingCallEvent = (overrides?: Record<string, unknown>): CallKitEvent =>
  ({
    type: 'incomingCall',
    payload: {
      callId: 'call_1',
      callType: CALL_TYPE.VIDEO_1V1,
      callerUserId: 'user_a',
      callerDevId: 'dev_a',
      channel: 'ch_in',
      calleeUserId: 'user_local',
      token: 'token_in',
      appId: 'app_in',
      uid: 456,
      callerInfo: { nickname: '张三', avatarURL: 'https://a/1.png' },
      ...overrides
    }
  }) as unknown as CallKitEvent

const shouldJoinRtcEvent = (role: 'caller' | 'callee'): CallKitEvent =>
  ({
    type: 'shouldJoinRtc',
    payload: {
      callId: 'call_1',
      channel: 'ch_in',
      callType: CALL_TYPE.VIDEO_1V1,
      callerUserId: 'user_a',
      token: 'token_in',
      uid: 456,
      appId: 'app_in',
      role
    }
  }) as unknown as CallKitEvent

const invitedEvent = (isCaller = true): CallKitEvent =>
  ({
    type: 'singleCallInvited',
    payload: {
      callId: 'call_1',
      channel: 'ch_out',
      callType: CALL_TYPE.AUDIO_1V1,
      callerUserId: 'user_local',
      calleeUserId: 'user_b',
      isCaller
    }
  }) as unknown as CallKitEvent

describe('createCallUiBridge', () => {
  it('incomingCall → 直接得到可渲染的组件 props', () => {
    const { core } = createFakeCore()
    const bridge = createCallUiBridge({ core })

    bridge.handleEvent(incomingCallEvent())

    const view = bridge.getView()
    expect(view.visible).toBe(true)
    expect(view.appId).toBe('app_in')
    expect(view.channelName).toBe('ch_in')
    expect(view.token).toBe('token_in')
    expect(view.uid).toBe(456)
    expect(view.mediaType).toBe('video')
    expect(view.callDirection).toBe('incoming')
    expect(view.ringing).toBe(true)
    expect(view.groupMode).toBe(false)
    expect(view.remoteName).toBe('张三')
    expect(view.remoteAvatar).toBe('https://a/1.png')
  })

  it('incomingCall 缺 appId 时用 defaultRtcAppId 兜底', () => {
    const { core } = createFakeCore()
    const bridge = createCallUiBridge({ core, defaultRtcAppId: 'app_default' })

    bridge.handleEvent(incomingCallEvent({ appId: undefined }))

    expect(bridge.getView().appId).toBe('app_default')
  })

  it('群聊来电 → groupMode 为 true，remoteName 取自 resolveProfile', () => {
    const { core } = createFakeCore()
    const bridge = createCallUiBridge({
      core,
      resolveProfile: (userId) => (userId === 'user_a' ? { nickname: '群主' } : undefined)
    })

    bridge.handleEvent(
      incomingCallEvent({ callType: CALL_TYPE.AUDIO_MULTI, callerInfo: undefined })
    )

    const view = bridge.getView()
    expect(view.groupMode).toBe(true)
    expect(view.mediaType).toBe('audio')
    expect(view.remoteName).toBe('群主')
  })

  it('群聊来电带 groupId / groupName → 界面可显示群名', () => {
    const { core } = createFakeCore()
    const bridge = createCallUiBridge({ core })

    bridge.handleEvent(
      incomingCallEvent({
        callType: CALL_TYPE.VIDEO_MULTI,
        groupId: 'group_001',
        groupName: '项目组'
      })
    )

    const view = bridge.getView()
    expect(view.groupMode).toBe(true)
    expect(view.mediaType).toBe('video')
    expect(view.groupId).toBe('group_001')
    expect(view.groupName).toBe('项目组')
  })

  it('群聊主叫 singleCallInvited → groupMode 为 true，且不残留上个群的 groupName', () => {
    const { core } = createFakeCore()
    const bridge = createCallUiBridge({ core })

    // 先来一通群聊来电，把 groupName 写进去
    bridge.handleEvent(incomingCallEvent({ groupId: 'group_a', groupName: 'A 组' }))
    expect(bridge.getView().groupName).toBe('A 组')

    bridge.handleEvent({
      type: 'singleCallInvited',
      payload: {
        callId: 'call_g2',
        channel: 'ch_g2',
        callType: CALL_TYPE.VIDEO_MULTI,
        callerUserId: 'user_local',
        calleeUserId: 'group_b',
        isCaller: true
      }
    } as unknown as CallKitEvent)

    const view = bridge.getView()
    expect(view.groupMode).toBe(true)
    expect(view.callDirection).toBe('outgoing')
    expect(view.groupId).toBe('')
    expect(view.groupName).toBe('')
  })

  it('群聊主叫 callInit → 生成未入房占位，入房后退出等待态，成员离开后移除占位', () => {
    const { core } = createFakeCore()
    const bridge = createCallUiBridge({
      core,
      localUserId: 'user_local',
      resolveProfile: (userId) => ({
        nickname: userId === 'user_b' ? '李四' : '王五',
        avatarURL: `https://a/${userId}.png`
      })
    })

    bridge.handleEvent({
      type: 'groupCallInit',
      payload: {
        callId: 'call_group',
        groupId: 'group_001',
        groupName: '项目组',
        channel: 'ch_group',
        callType: 'video',
        callerUserId: 'user_local',
        invitedMembers: ['user_b', 'user_c']
      }
    } as unknown as CallKitEvent)
    bridge.handleEvent({
      type: 'singleCallInvited',
      payload: {
        callId: 'call_group',
        channel: 'ch_group',
        callType: CALL_TYPE.VIDEO_MULTI,
        callerUserId: 'user_local',
        calleeUserId: 'group_001',
        isCaller: true
      }
    } as unknown as CallKitEvent)

    expect(bridge.getView()).toMatchObject({
      visible: true,
      groupMode: true,
      groupId: 'group_001',
      groupName: '项目组',
      groupWaiting: true
    })
    expect(bridge.getView().groupParticipants).toEqual([
      { userId: 'user_b', nickname: '李四', avatarURL: 'https://a/user_b.png', state: 'invited' },
      { userId: 'user_c', nickname: '王五', avatarURL: 'https://a/user_c.png', state: 'invited' }
    ])

    bridge.handleEvent({
      type: 'participantStateChanged',
      payload: { callId: 'call_group', userId: 'user_b', state: 'accepted', groupId: 'group_001' }
    } as unknown as CallKitEvent)
    expect(bridge.getView().groupWaiting).toBe(true)
    expect(bridge.getView().groupParticipants[0].state).toBe('accepted')

    bridge.handleEvent({
      type: 'participantStateChanged',
      payload: { callId: 'call_group', userId: 'user_b', state: 'joinedRtc', groupId: 'group_001' }
    } as unknown as CallKitEvent)
    expect(bridge.getView().groupWaiting).toBe(false)

    bridge.handleEvent({
      type: 'participantLeft',
      payload: {
        callId: 'call_group',
        userId: 'user_c',
        reason: 'timeout',
        channel: 'ch_group',
        callType: CALL_TYPE.VIDEO_MULTI,
        callerUserId: 'user_local',
        calleeUserId: 'group_001'
      }
    } as unknown as CallKitEvent)
    expect(bridge.getView().groupParticipants.map((participant) => participant.userId)).toEqual(['user_b'])
  })

  it('群聊被叫接听后保留其他未入房成员的占位', () => {
    const { core } = createFakeCore()
    const bridge = createCallUiBridge({
      core,
      localUserId: 'user_local',
      resolveProfile: (userId) => ({ nickname: userId })
    })

    bridge.handleEvent({
      type: 'groupCallInit',
      payload: {
        callId: 'call_group_in',
        groupId: 'group_001',
        groupName: '项目组',
        channel: 'ch_group_in',
        callType: 'video',
        callerUserId: 'user_a',
        invitedMembers: ['user_local', 'user_a', 'user_b', 'user_c']
      }
    } as unknown as CallKitEvent)
    bridge.handleEvent(
      incomingCallEvent({
        callId: 'call_group_in',
        callType: CALL_TYPE.VIDEO_MULTI,
        callerUserId: 'user_a',
        calleeUserId: 'user_local',
        groupId: 'group_001',
        groupName: '项目组'
      })
    )

    expect(bridge.getView()).toMatchObject({
      callDirection: 'incoming',
      groupWaiting: false
    })
    expect(bridge.getView().groupParticipants.map((participant) => participant.userId)).toEqual([
      'user_b',
      'user_c'
    ])

    bridge.handleEvent({
      type: 'shouldJoinRtc',
      payload: {
        callId: 'call_group_in',
        channel: 'ch_group_in',
        callType: CALL_TYPE.VIDEO_MULTI,
        callerUserId: 'user_a',
        token: 'token_in',
        uid: 456,
        appId: 'app_in',
        role: 'callee'
      }
    } as unknown as CallKitEvent)

    expect(bridge.getView().callDirection).toBe('incoming')
    expect(bridge.getView().groupParticipants.map((participant) => participant.userId)).toEqual([
      'user_b',
      'user_c'
    ])
  })

  it('群聊 RTC UID 无服务端映射时，按已接听占位反推 userId', async () => {
    const { core } = createFakeCore()
    const bridge = createCallUiBridge({
      core,
      localUserId: 'user_local',
      resolveProfile: (userId) => ({ nickname: userId, avatarURL: `https://a/${userId}.png` })
    })
    bridge.handleEvent({
      type: 'groupCallInit',
      payload: {
        callId: 'call_group',
        groupId: 'group_001',
        groupName: '项目组',
        channel: 'ch_group',
        callType: 'audio',
        callerUserId: 'user_local',
        invitedMembers: ['user_b', 'user_c']
      }
    } as unknown as CallKitEvent)
    bridge.handleEvent({
      type: 'participantJoined',
      payload: {
        callId: 'call_group',
        userId: 'user_b',
        channel: 'ch_group',
        callType: CALL_TYPE.AUDIO_MULTI,
        callerUserId: 'user_local',
        calleeUserId: 'group_001'
      }
    } as unknown as CallKitEvent)

    await bridge.reportRtcEvent({ type: 'userJoined', payload: { uid: 9 } })

    expect(bridge.getView().groupRtcProfiles['9']).toEqual({
      uid: '9',
      userId: 'user_b',
      nickname: 'user_b',
      avatarURL: 'https://a/user_b.png'
    })
  })

  it('群聊 RTC UID 解析成功后输出资料映射，供网格替换裸 UID', async () => {
    const { core } = createFakeCore()
    const bridge = createCallUiBridge({
      core,
      localUserId: 'user_local',
      resolveRtcUserId: async () => 'user_b',
      resolveProfile: (userId) => ({
        nickname: userId === 'user_b' ? '李四' : userId,
        avatarURL: `https://a/${userId}.png`
      })
    })
    bridge.handleEvent({
      type: 'groupCallInit',
      payload: {
        callId: 'call_group',
        groupId: 'group_001',
        groupName: '项目组',
        channel: 'ch_group',
        callType: 'audio',
        callerUserId: 'user_local',
        invitedMembers: ['user_b']
      }
    } as unknown as CallKitEvent)

    await bridge.reportRtcEvent({ type: 'userJoined', payload: { uid: 9 } })

    expect(bridge.getView().groupRtcProfiles['9']).toEqual({
      uid: '9',
      userId: 'user_b',
      nickname: '李四',
      avatarURL: 'https://a/user_b.png'
    })
  })

  it('被叫接听后 shouldJoinRtc → 停止振铃并 join', async () => {
    const { core } = createFakeCore()
    const bridge = createCallUiBridge({ core })
    const component = createFakeComponent()

    bridge.handleEvent(incomingCallEvent())
    bridge.attach(component)
    expect(component.join).not.toHaveBeenCalled()

    bridge.handleEvent(shouldJoinRtcEvent('callee'))
    await Promise.resolve()

    expect(bridge.getView().ringing).toBe(false)
    expect(component.join).toHaveBeenCalledTimes(1)
  })

  it('主叫 shouldJoinRtc 早于组件挂载 → attach 后补一次 join', async () => {
    const { core } = createFakeCore()
    const bridge = createCallUiBridge({ core })
    const component = createFakeComponent()

    bridge.handleEvent(shouldJoinRtcEvent('caller'))

    const view = bridge.getView()
    expect(view.visible).toBe(true)
    expect(view.callDirection).toBe('outgoing')
    expect(view.ringing).toBe(false)
    expect(component.join).not.toHaveBeenCalled()

    bridge.attach(component)
    await Promise.resolve()

    expect(component.join).toHaveBeenCalledTimes(1)
  })

  it('callEnded → 隐藏通话页', () => {
    const { core } = createFakeCore()
    const bridge = createCallUiBridge({ core })

    bridge.handleEvent(incomingCallEvent())
    bridge.handleEvent({ type: 'callEnded', payload: { callId: 'call_1' } } as unknown as CallKitEvent)

    expect(bridge.getView().visible).toBe(false)
  })

  it('主叫 singleCallInvited → 立即显示呼出中界面，不等人接听', () => {
    const { core } = createFakeCore()
    const bridge = createCallUiBridge({
      core,
      resolveProfile: (userId) => (userId === 'user_b' ? { nickname: '李四' } : undefined)
    })

    bridge.handleEvent(invitedEvent(true))

    const view = bridge.getView()
    expect(view.visible).toBe(true)
    expect(view.callDirection).toBe('outgoing')
    expect(view.ringing).toBe(true)
    expect(view.channelName).toBe('ch_out')
    expect(view.remoteName).toBe('李四')
    // 此刻还没拿到 RTC 参数，不能入房，也不能渲染 agora 组件
    expect(view.uid).toBe(0)
    expect(view.appId).toBe('')
    expect(view.shouldJoin).toBe(false)
  })

  it('主叫未获取到被叫昵称时，remoteName 兜底为被叫用户 ID', () => {
    const { core } = createFakeCore()
    const bridge = createCallUiBridge({ core })

    bridge.handleEvent(invitedEvent(true))

    expect(bridge.getView().remoteName).toBe('user_b')
    expect(bridge.getView().remoteAvatar).toBe('')
  })

  it('被叫收到的 singleCallInvited 不改状态（避免被叫也进“呼出中”）', () => {
    const { core } = createFakeCore()
    const bridge = createCallUiBridge({ core })

    bridge.handleEvent(invitedEvent(false))

    expect(bridge.getView().visible).toBe(false)
  })

  it('shouldJoinRtc 置 shouldJoin，通话结束后复位', () => {
    const { core } = createFakeCore()
    const bridge = createCallUiBridge({ core })

    bridge.handleEvent(shouldJoinRtcEvent('caller'))
    expect(bridge.getView().shouldJoin).toBe(true)

    bridge.handleEvent({ type: 'singleCallEnded', payload: {} } as unknown as CallKitEvent)
    expect(bridge.getView().shouldJoin).toBe(false)
    expect(bridge.getView().visible).toBe(false)
  })

  it('localAudioChanged(false) → 组件静音', async () => {
    const { core } = createFakeCore()
    const bridge = createCallUiBridge({ core })
    const component = createFakeComponent()
    bridge.attach(component)

    bridge.handleEvent({ type: 'localAudioChanged', payload: { enabled: false } } as unknown as CallKitEvent)
    await Promise.resolve()

    expect(component.setAudioMuted).toHaveBeenCalledWith(true)
  })

  it('组件静音失败 → 回滚状态机', async () => {
    const { core, raw, state } = createFakeCore()
    const bridge = createCallUiBridge({ core })
    const component = createFakeComponent()
    ;(component.setAudioMuted as any).mockRejectedValueOnce(new Error('native failed'))
    // Core emits localAudioChanged after changing its own state.
    state.audioEnabled = false
    bridge.attach(component)

    bridge.handleEvent({ type: 'localAudioChanged', payload: { enabled: false } } as unknown as CallKitEvent)
    await Promise.resolve()
    await Promise.resolve()

    expect(raw.toggleAudio).toHaveBeenCalledTimes(1)
  })

  it('syncMediaToCore 只在状态不一致时切换', () => {
    const { core, raw } = createFakeCore()
    const bridge = createCallUiBridge({ core })

    // 状态机 audioEnabled=true，组件上报已静音 → 需要切换
    bridge.syncMediaToCore({ audioMuted: true })
    expect(raw.toggleAudio).toHaveBeenCalledTimes(1)

    // 再报一次，此时 audioEnabled=false，与 muted=true 一致 → 不再切换
    bridge.syncMediaToCore({ audioMuted: true })
    expect(raw.toggleAudio).toHaveBeenCalledTimes(1)
  })

  it('component RTC 事件串行解析 UID，后续事件复用映射且不乱序', async () => {
    const { core, raw } = createFakeCore()
    let resolveUser!: (userId: string) => void
    const resolveRtcUserId = vi.fn(() => new Promise<string>((resolve) => {
      resolveUser = resolve
    }))
    const bridge = createCallUiBridge({ core, resolveRtcUserId })

    const joined = bridge.reportRtcEvent({ type: 'userJoined', payload: { uid: 9 } })
    const left = bridge.reportRtcEvent({ type: 'userLeft', payload: { uid: 9 } })
    await Promise.resolve()
    expect(raw.reportRtcEvent).not.toHaveBeenCalled()

    resolveUser('user_9')
    await Promise.all([joined, left])
    await bridge.reportRtcEvent({ type: 'userAudioMuted', payload: { uid: 9 } })

    expect(resolveRtcUserId).toHaveBeenCalledTimes(1)
    expect(raw.reportRtcEvent.mock.calls.map((call) => call[0])).toEqual([
      { type: 'userJoined', payload: { uid: 9, userId: 'user_9' } },
      { type: 'userLeft', payload: { uid: 9, userId: 'user_9' } },
      { type: 'userAudioMuted', payload: { uid: 9, userId: 'user_9' } }
    ])
  })

  it('component RTC 错误原样进入 Core，让宿主收到 rtcReport', async () => {
    const { core, raw } = createFakeCore()
    const bridge = createCallUiBridge({ core })

    await bridge.reportRtcEvent({
      type: 'error',
      payload: { error: 'native failed', errorCode: 17 }
    })

    expect(raw.reportRtcEvent).toHaveBeenCalledWith({
      type: 'error',
      payload: { error: 'native failed', errorCode: 17 }
    })
  })

  it('无 attach 时编程式媒体控制仍更新跨上下文快照命令', async () => {
    const { core } = createFakeCore()
    const onError = vi.fn()
    const bridge = createCallUiBridge({ core, onError })

    await bridge.setAudioMuted(true)
    await bridge.setVideoMuted(true)
    bridge.handleEvent({ type: 'localAudioChanged', payload: { enabled: true } } as unknown as CallKitEvent)

    expect(bridge.getView()).toMatchObject({
      audioMuted: false,
      videoMuted: true,
      audioCommandId: 2,
      videoCommandId: 1,
      initialAudioMuted: false,
      initialVideoMuted: true
    })
    expect(onError).not.toHaveBeenCalled()
  })

  it('UI 原生操作回写 Core 时不生成新的媒体命令', () => {
    const { core, raw, state } = createFakeCore()
    const bridge = createCallUiBridge({ core })
    raw.toggleAudio.mockImplementation(() => {
      state.audioEnabled = !state.audioEnabled
      bridge.handleEvent({
        type: 'localAudioChanged',
        payload: { enabled: state.audioEnabled }
      } as unknown as CallKitEvent)
    })

    bridge.syncMediaToCore({ audioMuted: true })
    const commandId = bridge.getView().audioCommandId
    bridge.syncMediaToCore({ audioMuted: true })

    expect(raw.toggleAudio).toHaveBeenCalledTimes(1)
    expect(bridge.getView().audioMuted).toBe(true)
    expect(commandId).toBe(0)
    expect(bridge.getView().audioCommandId).toBe(0)
  })

  it('runs audio and video independently and suppresses synchronous Core echoes', async () => {
    const { core, raw, state } = createFakeCore()
    const bridge = createCallUiBridge({ core })
    for (const kind of ['audio', 'video'] as const) {
      const key = kind === 'audio' ? 'audioEnabled' : 'videoEnabled'
      const toggle = kind === 'audio' ? raw.toggleAudio : raw.toggleVideo
      toggle.mockImplementation(() => {
        state[key] = !state[key]
        bridge.handleEvent({ type: kind === 'audio' ? 'localAudioChanged' : 'localVideoChanged', payload: { enabled: state[key] } } as CallKitEvent)
      })
    }
    const component = createFakeComponent()
    const audio = deferred()
    const video = deferred()
    vi.mocked(component.setAudioMuted).mockImplementation(() => audio.promise)
    vi.mocked(component.setVideoMuted).mockImplementation(() => video.promise)
    bridge.attach(component)
    const a = bridge.setAudioMuted(true)
    const v = bridge.setVideoMuted(true)
    expect(component.setAudioMuted).toHaveBeenCalledTimes(1)
    expect(component.setVideoMuted).toHaveBeenCalledTimes(1)
    expect(bridge.getView()).toMatchObject({ audioCommandId: 1, videoCommandId: 1, audioMuted: true, videoMuted: true })
    bridge.syncMediaToCore({ audioMuted: false, videoMuted: false })
    expect(state).toEqual({ audioEnabled: false, videoEnabled: false })
    video.resolve()
    await v
    expect(component.setAudioMuted).toHaveBeenCalledTimes(1)
    audio.resolve()
    await a
    expect(raw.toggleAudio).toHaveBeenCalledTimes(1)
    expect(raw.toggleVideo).toHaveBeenCalledTimes(1)
  })

  it.each(['audio', 'video'] as const)('serializes %s and coalesces pending commands to the latest target', async (kind) => {
    const { core } = createFakeCore()
    const bridge = createCallUiBridge({ core })
    const component = createFakeComponent()
    const first = deferred()
    const last = deferred()
    const method = kind === 'audio' ? component.setAudioMuted : component.setVideoMuted
    vi.mocked(method).mockImplementationOnce(() => first.promise).mockImplementationOnce(() => last.promise)
    bridge.attach(component)
    const set = kind === 'audio' ? bridge.setAudioMuted : bridge.setVideoMuted
    const a = set(true)
    const skipped = set(true)
    const b = set(false)
    await skipped
    expect(method).toHaveBeenCalledTimes(1)
    first.resolve()
    await a
    expect(vi.mocked(method).mock.calls).toEqual([[true], [false]])
    last.resolve()
    await b
    expect(bridge.getView()[kind + 'Muted' as 'audioMuted' | 'videoMuted']).toBe(false)
  })

  it.each(['audio', 'video'] as const)('ignores old %s failures and rolls back only the latest failure', async (kind) => {
    const { core, state } = createFakeCore()
    const onError = vi.fn()
    const bridge = createCallUiBridge({ core, onError })
    const component = createFakeComponent()
    const first = deferred()
    const last = deferred()
    const method = kind === 'audio' ? component.setAudioMuted : component.setVideoMuted
    vi.mocked(method).mockImplementationOnce(() => first.promise).mockImplementationOnce(() => last.promise)
    bridge.attach(component)
    const set = kind === 'audio' ? bridge.setAudioMuted : bridge.setVideoMuted
    const a = set(true)
    const b = set(false)
    const latestId = bridge.getView()[kind === 'audio' ? 'audioCommandId' : 'videoCommandId']!
    first.reject(new Error('obsolete'))
    await a
    expect(state[kind === 'audio' ? 'audioEnabled' : 'videoEnabled']).toBe(true)
    expect(onError).not.toHaveBeenCalled()
    last.reject(new Error('latest'))
    await b
    expect(state[kind === 'audio' ? 'audioEnabled' : 'videoEnabled']).toBe(false)
    expect(bridge.getView()[kind === 'audio' ? 'initialAudioMuted' : 'initialVideoMuted']).toBe(true)
    expect(onError).toHaveBeenCalledTimes(1)
    bridge.handleMediaCommandError!(kind, latestId, new Error('duplicate'))
    bridge.syncMediaToCore(kind === 'audio' ? { audioMuted: false, audioCommandId: latestId } : { videoMuted: false, videoCommandId: latestId })
    expect(state[kind === 'audio' ? 'audioEnabled' : 'videoEnabled']).toBe(false)
    expect(onError).toHaveBeenCalledTimes(1)
  })

  it('rejects old cross-context receipts and does not turn success into another native command', async () => {
    const { core, raw, state } = createFakeCore()
    const bridge = createCallUiBridge({ core })
    await bridge.setAudioMuted(true)
    const old = bridge.getView().audioCommandId!
    await bridge.setAudioMuted(false)
    const latest = bridge.getView().audioCommandId!
    bridge.syncMediaToCore({ audioMuted: true, audioCommandId: old })
    bridge.handleMediaCommandError!('audio', old, 'obsolete')
    expect(state.audioEnabled).toBe(true)
    bridge.syncMediaToCore({ audioMuted: false, audioCommandId: latest })
    expect(bridge.getView().audioCommandId).toBe(latest)
    expect(raw.toggleAudio).toHaveBeenCalledTimes(2)
    bridge.syncMediaToCore({ audioMuted: true })
    bridge.handleMediaCommandError!('audio', latest, 'superseded by UI')
    expect(state.audioEnabled).toBe(false)
    expect(bridge.getView().audioCommandId).toBe(latest)
  })

  it('keeps Core, outgoing prejoin props and native join inputs consistent', async () => {
    const { core, state } = createFakeCore()
    const bridge = createCallUiBridge({ core })
    await bridge.setAudioMuted(true)
    await bridge.setVideoMuted(true)
    bridge.handleEvent(invitedEvent())
    expect(bridge.getView()).toMatchObject({ audioMuted: true, videoMuted: true, initialAudioMuted: true, initialVideoMuted: true })
    bridge.handleEvent(shouldJoinRtcEvent('caller'))
    const component = createFakeComponent()
    vi.mocked(component.join).mockImplementation(async () => {
      expect(bridge.getView()).toMatchObject({ initialAudioMuted: !state.audioEnabled, initialVideoMuted: !state.videoEnabled })
    })
    bridge.attach(component)
    await Promise.resolve()
    await Promise.resolve()
    expect(component.setAudioMuted).toHaveBeenCalledWith(true)
    expect(component.setVideoMuted).toHaveBeenCalledWith(true)
  })

  it.each(['reset', 'end', 'replace', 'detach', 'newCall', 'dispose'] as const)('invalidates old media tasks on %s without draining a new queue', async (action) => {
    const { core, state } = createFakeCore()
    const onError = vi.fn()
    const bridge = createCallUiBridge({ core, onError })
    bridge.handleEvent(incomingCallEvent())
    const oldComponent = createFakeComponent()
    const old = deferred()
    vi.mocked(oldComponent.setAudioMuted).mockImplementation(() => old.promise)
    bridge.attach(oldComponent)
    const a = bridge.setAudioMuted(true)
    const skipped = bridge.setAudioMuted(false)
    const oldId = bridge.getView().audioCommandId!
    const newComponent = createFakeComponent()
    const current = deferred()
    vi.mocked(newComponent.setAudioMuted).mockImplementation(() => current.promise)
    if (action === 'reset') bridge.reset()
    if (action === 'end') bridge.handleEvent({ type: 'callEnded', payload: { callId: 'call_1' } } as CallKitEvent)
    if (action === 'detach') bridge.attach(null)
    if (action === 'newCall') bridge.handleEvent(incomingCallEvent({ callId: 'call_2' }))
    if (action === 'dispose') bridge.dispose()
    if (action !== 'dispose') bridge.attach(newComponent)
    const b = bridge.setAudioMuted(true)
    old.reject(new Error('retired native task'))
    await Promise.all([a, skipped])
    expect(oldComponent.setAudioMuted).toHaveBeenCalledTimes(1)
    expect(onError).not.toHaveBeenCalled()
    bridge.syncMediaToCore({ audioMuted: false, audioCommandId: oldId })
    if (action !== 'dispose') {
      expect(state.audioEnabled).toBe(false)
      const c = bridge.setAudioMuted(false)
      expect(newComponent.setAudioMuted).toHaveBeenCalledTimes(1)
      current.resolve()
      await Promise.all([b, c])
      expect(newComponent.setAudioMuted).toHaveBeenCalledTimes(2)
    } else {
      await b
      expect(newComponent.setAudioMuted).not.toHaveBeenCalled()
    }
  })

  it.each(['reset', 'dispose'] as const)('drops UID resolution and queued reports after %s', async (action) => {
    const { core, raw } = createFakeCore()
    const pending = deferred<string>()
    const bridge = createCallUiBridge({ core, resolveRtcUserId: () => pending.promise })
    const old = bridge.reportRtcEvent({ type: 'userJoined', payload: { uid: 9 } })
    const queued = bridge.reportRtcEvent({ type: 'userLeft', payload: { uid: 9 } })
    await Promise.resolve()
    bridge[action]()
    pending.resolve('retired')
    await Promise.all([old, queued])
    expect(raw.reportRtcEvent).not.toHaveBeenCalled()
    if (action === 'reset') {
      await bridge.reportRtcEvent({ type: 'rtcJoined', payload: { uid: 1, userId: 'new' } })
      expect(raw.reportRtcEvent).toHaveBeenCalledTimes(1)
    }
  })

  it('onChange 推送快照，解除订阅后不再收到', () => {
    const { core } = createFakeCore()
    const bridge = createCallUiBridge({ core })
    const listener = vi.fn()

    const off = bridge.onChange(listener)
    bridge.handleEvent(incomingCallEvent())
    expect(listener).toHaveBeenCalledTimes(1)
    expect(listener.mock.calls[0][0].visible).toBe(true)

    off()
    bridge.handleEvent({ type: 'callEnded', payload: {} } as unknown as CallKitEvent)
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('dispose 后不再处理事件', () => {
    const { core } = createFakeCore()
    const bridge = createCallUiBridge({ core })

    bridge.dispose()
    bridge.handleEvent(incomingCallEvent())

    expect(bridge.getView().visible).toBe(false)
  })
})
