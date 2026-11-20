import { describe, expect, it, vi } from 'vitest'
import { CALL_TYPE } from '@easemob-community/callkit-core-v5'
import type { RtcAdapter } from '@easemob-community/callkit-core-v5'
import { createUniappAppCallKit } from './core-adapter'

function createMockClient() {
  const handlers = new Map<string, any>()
  const client = {
    chatManager: {
      createTextMessage: vi.fn((options: any) => ({ ...options })),
      createCmdMessage: vi.fn((options: any) => ({ ...options })),
      sendMessage: vi.fn(async (message: any) => message)
    },
    addEventHandler: vi.fn((id: string, handler: any) => {
      handlers.set(id, handler)
    }),
    removeEventHandler: vi.fn((id: string) => {
      handlers.delete(id)
    }),
    getCurrentUserId: vi.fn(() => 'user_local'),
    getClientResource: vi.fn(() => 'dev_me'),
    getRTCTokenInfo: vi.fn(async () => ({
      rtcToken: 'rtc_token',
      appId: 'app_x',
      rtcUid: 789,
      expireAt: Date.now() + 3600_000
    })),
    getUserIdsWithRTCUids: vi.fn(async () => ({}))
  }
  return { client, handlers }
}

function createMockRtcAdapter(): RtcAdapter {
  return {
    joinChannel: vi.fn(async () => {}),
    leaveChannel: vi.fn(async () => {}),
    publishLocalTracks: vi.fn(async () => {}),
    unpublishLocalTracks: vi.fn(async () => {}),
    subscribeRemoteUser: vi.fn(async () => {}),
    unsubscribeRemoteUser: vi.fn(async () => {}),
    setAudioEnabled: vi.fn(async () => {}),
    setVideoEnabled: vi.fn(async () => {})
  } as unknown as RtcAdapter
}

const buildInviteMessage = () => ({
  type: 'text',
  msgLocalId: 'msg_1',
  from: 'user_a',
  to: 'user_local',
  body: { content: '' },
  ext: {
    action: 'invite',
    callId: 'call_1',
    callerIMName: 'user_a',
    calleeIMName: 'user_local',
    callerDevId: 'dev_a',
    channelName: 'ch_1',
    type: CALL_TYPE.VIDEO_1V1,
    chatType: CALL_TYPE.VIDEO_1V1,
    ts: Date.now(),
    msgType: 'rtcCallWithAgora'
  }
})

describe('createUniappAppCallKit — rtcOwnership', () => {
  it('默认 adapter 模式：既无 createRtcSession 也无 rtcAdapter → 抛错', () => {
    const { client } = createMockClient()
    expect(() => createUniappAppCallKit({ client: client as any })).toThrow(/createRtcSession/)
  })

  it('adapter 模式：传入 rtcAdapter 时原样使用，且不创建 callUi', async () => {
    const { client } = createMockClient()
    const rtcAdapter = createMockRtcAdapter()

    const callkit = createUniappAppCallKit({ client: client as any, rtcAdapter })

    expect(callkit.rtcAdapter).toBe(rtcAdapter)
    expect(callkit.callUi).toBeUndefined()
    await callkit.dispose()
  })

  it('component 模式：无需 createRtcSession，rtcAdapter 为 undefined，callUi 存在', async () => {
    const { client } = createMockClient()

    const callkit = createUniappAppCallKit({ client: client as any, rtcOwnership: 'component' })

    expect(callkit.rtcAdapter).toBeUndefined()
    expect(callkit.callUi).toBeDefined()
    await callkit.dispose()
  })

  it('非法 rtcOwnership → 抛错', () => {
    const { client } = createMockClient()
    expect(() =>
      createUniappAppCallKit({ client: client as any, rtcOwnership: 'bogus' as any })
    ).toThrow(/rtcOwnership/)
  })

  it('component 模式：来电事件经 core 驱动 callUi，且业务 onEvent 仍收到', async () => {
    const { client, handlers } = createMockClient()
    const onEvent = vi.fn()

    const callkit = createUniappAppCallKit({
      client: client as any,
      rtcOwnership: 'component',
      defaultRtcAppId: 'app_fallback',
      onEvent
    })

    const handler = Array.from(handlers.values())[0]
    await handler.onMessage(buildInviteMessage())

    const view = callkit.callUi!.getView()
    expect(view.visible).toBe(true)
    expect(view.channelName).toBe('ch_1')
    expect(view.token).toBe('rtc_token')
    expect(view.uid).toBe(789)
    expect(view.appId).toBe('app_x')
    expect(view.callDirection).toBe('incoming')
    expect(view.ringing).toBe(true)
    expect(onEvent).toHaveBeenCalledWith(expect.objectContaining({ type: 'incomingCall' }))

    await callkit.dispose()
  })

  it('component 模式 RTC 错误经真实 Core 暴露给宿主', async () => {
    const { client } = createMockClient()
    const onEvent = vi.fn()
    const callkit = createUniappAppCallKit({
      client: client as any,
      rtcOwnership: 'component',
      onEvent
    })

    await callkit.callUi!.reportRtcEvent({
      type: 'error',
      payload: { error: 'native failed', errorCode: 17 }
    })

    expect(onEvent).toHaveBeenCalledWith({
      type: 'rtcReport',
      payload: {
        type: 'error',
        payload: { error: 'native failed', errorCode: 17 }
      }
    })
    await callkit.dispose()
  })

  it('dispose 会摘掉 IM handler 并销毁桥接', async () => {
    const { client } = createMockClient()
    const callkit = createUniappAppCallKit({ client: client as any, rtcOwnership: 'component' })

    await callkit.dispose()

    expect(client.removeEventHandler).toHaveBeenCalled()
    // 销毁后事件不应再驱动视图
    callkit.callUi!.handleEvent({
      type: 'incomingCall',
      payload: { callId: 'c', callType: CALL_TYPE.AUDIO_1V1, channel: 'ch' }
    } as any)
    expect(callkit.callUi!.getView().visible).toBe(false)
  })
})
