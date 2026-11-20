import { beforeEach, describe, expect, it, vi } from 'vitest'
import { CALL_TYPE } from '@easemob-community/callkit-core-v5'

const mocks = vi.hoisted(() => ({
  init: vi.fn(),
  login: vi.fn(),
  logout: vi.fn(),
  createCallkit: vi.fn()
}))

vi.mock('easemob-websdk', () => ({ ChatClient: { init: mocks.init } }))
vi.mock('easemob-websdk/managers/chat', () => ({ ChatManager: {} }))
vi.mock('easemob-websdk/managers/user-info', () => ({ UserInfoManager: {} }))
vi.mock('easemob-websdk/managers/group', () => ({ GroupManager: {} }))
vi.mock('../core-adapter', () => ({ createUniappAppCallKit: mocks.createCallkit }))

const { createCallKitHost } = await import('./createCallKitHost')

type Listener = (view: any) => void

const bus = new Map<string, Set<(payload: any) => void>>()
const navigateTo = vi.fn()

;(globalThis as any).uni = {
  $on(event: string, handler: (payload: any) => void) {
    if (!bus.has(event)) bus.set(event, new Set())
    bus.get(event)!.add(handler)
  },
  $off(event: string, handler?: (payload: any) => void) {
    if (!handler) bus.delete(event)
    else bus.get(event)?.delete(handler)
  },
  $emit(event: string, payload?: unknown) {
    bus.get(event)?.forEach((handler) => handler(payload))
  },
  navigateTo
}

function createFakeCallUi() {
  const listeners = new Set<Listener>()
  const callUi = {
    getView: vi.fn(() => ({ visible: false })),
    onChange: vi.fn((listener: Listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    }),
    syncMediaToCore: vi.fn(),
    emit(view: unknown) {
      listeners.forEach((listener) => listener(view))
    }
  }
  return callUi
}

function createFakeCallkit(callUi: ReturnType<typeof createFakeCallUi>) {
  return {
    callUi,
    core: {
      inviteCall: vi.fn(async () => undefined),
      inviteGroupCall: vi.fn(async () => undefined),
      answerCall: vi.fn(async () => undefined),
      hangup: vi.fn(async () => undefined),
      getCurrentCallId: vi.fn(() => 'call_1'),
      getSingleCallState: vi.fn(() => ({ audioEnabled: true, videoEnabled: true }))
    },
    imAdapter: {
      fetchUserInfoById: vi.fn(async (ids: string[]) =>
        ids.map((id) => ({ userId: id, nickname: `昵称_${id}`, avatarURL: '' }))
      )
    },
    dispose: vi.fn(async () => undefined)
  }
}

function createFakeClient(getMembers?: () => unknown) {
  return {
    login: mocks.login,
    logout: mocks.logout,
    groupManager: {
      getGroup: vi.fn(() => ({
        getMembers: vi.fn(getMembers || (async () => ({ items: [], hasMore: false })))
      }))
    }
  }
}

const baseOptions = {
  appKey: 'org#app',
  userId: 'me',
  token: 'token'
}

describe('createCallKitHost', () => {
  let callUi: ReturnType<typeof createFakeCallUi>
  let callkit: ReturnType<typeof createFakeCallkit>

  beforeEach(() => {
    bus.clear()
    navigateTo.mockClear()
    Object.values(mocks).forEach((fn) => fn.mockClear())
    mocks.login.mockResolvedValue(undefined)
    mocks.logout.mockResolvedValue(undefined)
    callUi = createFakeCallUi()
    callkit = createFakeCallkit(callUi)
    mocks.createCallkit.mockReturnValue(callkit)
    mocks.init.mockReturnValue(createFakeClient())
  })

  it('缺 appKey / userId / token 直接抛 TypeError', async () => {
    await expect(createCallKitHost({ ...baseOptions, token: '' })).rejects.toThrow(TypeError)
    expect(mocks.init).not.toHaveBeenCalled()
  })

  it('登录后以 component 模式创建 CallKit，并返回 callUi', async () => {
    const host = await createCallKitHost(baseOptions)

    expect(mocks.init).toHaveBeenCalledWith({
      appKey: 'org#app',
      managers: expect.any(Array)
    })
    expect(mocks.login).toHaveBeenCalledWith({ userId: 'me', token: 'token' })
    expect(mocks.createCallkit).toHaveBeenCalledWith(
      expect.objectContaining({ rtcOwnership: 'component', client: expect.anything() })
    )
    expect(host.callUi).toBe(callUi)
    expect(host.userId).toBe('me')
  })

  it('callUi 缺失时销毁 CallKit 并抛错，不留半初始化实例', async () => {
    mocks.createCallkit.mockReturnValue({ ...callkit, callUi: undefined })

    await expect(createCallKitHost(baseOptions)).rejects.toThrow(/callUi/)
    expect(callkit.dispose).toHaveBeenCalled()
  })

  it('view.visible 变 true 时导航一次，重复变更不重复导航', async () => {
    await createCallKitHost(baseOptions)

    callUi.emit({ visible: true })
    callUi.emit({ visible: true })

    expect(navigateTo).toHaveBeenCalledTimes(1)
    expect(navigateTo).toHaveBeenCalledWith(expect.objectContaining({ url: '/pages/call/call' }))
  })

  it('callPageUrl / onNavigate 可替换导航行为', async () => {
    const onNavigate = vi.fn()
    await createCallKitHost({ ...baseOptions, callPageUrl: '/pages/my-call', onNavigate })

    callUi.emit({ visible: true })

    expect(onNavigate).toHaveBeenCalledWith('/pages/my-call')
    expect(navigateTo).not.toHaveBeenCalled()
  })

  it('通话页退场（closed 动作）后允许下一通再次导航', async () => {
    const host = await createCallKitHost(baseOptions)

    callUi.emit({ visible: true, callId: 'call_1' })
    expect(navigateTo).toHaveBeenCalledTimes(1)

    // 模拟 nvue 页面卸载时发回的动作；closed 必须带 callId，
    // 否则旧页面的迟到事件会复位掉新通话的导航标记
    bus.get('em-callkit:action')!.forEach((handler) => handler({ type: 'closed', callId: 'call_1' }))

    callUi.emit({ visible: true, callId: 'call_1' })
    expect(navigateTo).toHaveBeenCalledTimes(2)
    expect(host.markCallPageClosed).toBeTypeOf('function')
  })

  it('inviteCall 先预热对方资料再发起', async () => {
    const host = await createCallKitHost(baseOptions)

    await host.inviteCall({ calleeUserId: 'peer', callType: CALL_TYPE.AUDIO_1V1 })

    expect(callkit.imAdapter.fetchUserInfoById).toHaveBeenCalledWith(['peer'])
    expect(callkit.core.inviteCall).toHaveBeenCalledWith({
      calleeUserId: 'peer',
      callType: CALL_TYPE.AUDIO_1V1
    })
  })

  it('inviteGroupCall 自动拉群成员并排除自己', async () => {
    mocks.init.mockReturnValue(
      createFakeClient(async () => ({
        items: [{ user: { userId: 'me' } }, { user: { userId: 'b' } }, { user: { userId: 'c' } }],
        hasMore: false
      }))
    )
    const host = await createCallKitHost(baseOptions)

    const count = await host.inviteGroupCall({ groupId: 'g1', callType: CALL_TYPE.VIDEO_MULTI })

    expect(count).toBe(2)
    expect(callkit.core.inviteGroupCall).toHaveBeenCalledWith({
      groupId: 'g1',
      participantIds: ['b', 'c'],
      callType: CALL_TYPE.VIDEO_MULTI
    })
  })

  it('群里没有其他成员时拒绝发起', async () => {
    mocks.init.mockReturnValue(
      createFakeClient(async () => ({ items: [{ user: { userId: 'me' } }], hasMore: false }))
    )
    const host = await createCallKitHost(baseOptions)

    await expect(
      host.inviteGroupCall({ groupId: 'g1', callType: CALL_TYPE.AUDIO_MULTI })
    ).rejects.toThrow(/没有其他成员/)
    expect(callkit.core.inviteGroupCall).not.toHaveBeenCalled()
  })

  it('dispose 断开监听、销毁 CallKit 并登出，且可重复调用', async () => {
    const host = await createCallKitHost(baseOptions)

    await host.dispose()
    await host.dispose()

    expect(callkit.dispose).toHaveBeenCalledTimes(1)
    expect(mocks.logout).toHaveBeenCalledTimes(1)
    // 监听已断开：再推 view 不该导航
    callUi.emit({ visible: true })
    expect(navigateTo).not.toHaveBeenCalled()
  })

  it('dispose 之后 invitCall 抛错', async () => {
    const host = await createCallKitHost(baseOptions)
    await host.dispose()

    await expect(
      host.inviteCall({ calleeUserId: 'peer', callType: CALL_TYPE.AUDIO_1V1 })
    ).rejects.toThrow(/已销毁/)
  })
})
