import { describe, expect, it, vi } from 'vitest'
import type { Message } from 'easemob-websdk'
import { createSDK5IMAdapter, type SDK5ChatClient } from './SDK5IMConnectionAdapter'

function createFakeMessage(overrides: Partial<Message>): Message {
  return {
    msgServerId: 'server_1',
    msgLocalId: 'local_1',
    from: 'user_a',
    to: 'user_local',
    sender: { userId: 'user_a' } as any,
    conversationId: 'user_local',
    conversationType: 'singleChat',
    type: 'text',
    sendStatus: 'sent',
    ext: {},
    timestamp: Date.now(),
    body: { content: 'hello' },
    ...overrides
  } as Message
}

function createMockClient() {
  const handlers = new Map<string, Record<string, (...args: any[]) => void>>()
  const createTextMessage = vi.fn((params: any) => createFakeMessage({
    type: 'text',
    body: { content: params.content }
  }))
  const createCmdMessage = vi.fn((params: any) => createFakeMessage({
    type: 'cmd',
    body: { action: params.action }
  }))
  const sendMessage = vi.fn(async (message: Message) => message)
  const removeEventHandler = vi.fn((id: string) => handlers.delete(id))
  const getUserInfoByAttribute = vi.fn(async () => [
    { userId: 'user_a', nickname: 'Alice', avatarUrl: 'https://avatar/a.png' }
  ])

  const client = {
    getCurrentUserId: () => 'user_local',
    getClientResource: () => 'device_app',
    chatManager: {
      createTextMessage,
      createCmdMessage,
      sendMessage
    },
    userInfoManager: {
      getUserInfoByAttribute
    },
    addEventHandler: vi.fn((id: string, value: Record<string, (...args: any[]) => void>) => {
      handlers.set(id, value)
    }),
    removeEventHandler,
    getRTCTokenInfo: vi.fn(async (params: { channelName?: string }) => ({
      appId: 'agora_app',
      rtcToken: `token_${params.channelName}`,
      channelName: params.channelName,
      rtcUid: 123,
      expireAt: Date.now() + 60_000
    })),
    getUserIdsWithRTCUids: vi.fn(async (uids: number[]) => {
      const result: Record<number, string> = { 123: 'user_a' }
      if (uids[0] !== 123) result[uids[0]] = 'user_a'
      return result
    })
  } as unknown as SDK5ChatClient

  return {
    client,
    handlers,
    createTextMessage,
    createCmdMessage,
    sendMessage,
    removeEventHandler,
    getUserInfoByAttribute
  }
}

describe('createSDK5IMAdapter', () => {
  it('创建单聊文本消息并映射 SDK5 参数', () => {
    const { client, createTextMessage } = createMockClient()
    const adapter = createSDK5IMAdapter(client)

    adapter.createMessage({
      type: 'txt',
      to: 'user_b',
      chatType: 'singleChat',
      msg: 'hello',
      ext: { action: 'invite', callId: 'call_1' }
    })

    expect(createTextMessage).toHaveBeenCalledWith({
      conversationId: 'user_b',
      conversationType: 'singleChat',
      content: 'hello',
      ext: { action: 'invite', callId: 'call_1' }
    })
  })

  it('创建群聊 CMD 消息并携带 receiverList', () => {
    const { client, createCmdMessage } = createMockClient()
    const adapter = createSDK5IMAdapter(client)

    adapter.createMessage({
      type: 'cmd',
      to: 'group_1',
      chatType: 'groupChat',
      action: 'rtcCall',
      ext: { action: 'alert' },
      receiverList: ['user_b', 'user_c']
    })

    expect(createCmdMessage).toHaveBeenCalledWith({
      conversationId: 'group_1',
      conversationType: 'groupChat',
      action: 'rtcCall',
      ext: { action: 'alert' },
      receiverList: ['user_b', 'user_c']
    })
  })

  it('send 委托 chatManager.sendMessage', async () => {
    const { client, sendMessage } = createMockClient()
    const adapter = createSDK5IMAdapter(client)
    const message = createFakeMessage({})

    await adapter.connection.send(message)

    expect(sendMessage).toHaveBeenCalledWith(message)
  })

  it('把 onMessage 文本消息归一化为 onTextMessage', async () => {
    const { client, handlers } = createMockClient()
    const adapter = createSDK5IMAdapter(client)
    const onTextMessage = vi.fn()
    const onCmdMessage = vi.fn()

    adapter.connection.addEventHandler('test', { onTextMessage, onCmdMessage })
    await handlers.get('test')!.onMessage(createFakeMessage({
      ext: { action: 'invite', callId: 'call_1' },
      body: { content: 'call me' }
    }))

    expect(onTextMessage).toHaveBeenCalledWith(expect.objectContaining({
      id: 'local_1',
      from: 'user_a',
      msg: 'call me',
      ext: { action: 'invite', callId: 'call_1' }
    }))
    expect(onCmdMessage).not.toHaveBeenCalled()
  })

  it('把 onMessage CMD 消息归一化为 onCmdMessage', async () => {
    const { client, handlers } = createMockClient()
    const adapter = createSDK5IMAdapter(client)
    const onTextMessage = vi.fn()
    const onCmdMessage = vi.fn()

    adapter.connection.addEventHandler('test', { onTextMessage, onCmdMessage })
    await handlers.get('test')!.onMessage(createFakeMessage({
      type: 'cmd',
      ext: { action: 'alert', callId: 'call_1' },
      body: { action: 'rtcCall' }
    }))

    expect(onCmdMessage).toHaveBeenCalledWith(expect.objectContaining({
      id: 'local_1',
      action: 'rtcCall',
      ext: { action: 'alert', callId: 'call_1' }
    }))
    expect(onTextMessage).not.toHaveBeenCalled()
  })

  it('忽略非文本/CMD 消息', async () => {
    const { client, handlers } = createMockClient()
    const adapter = createSDK5IMAdapter(client)
    const onTextMessage = vi.fn()
    const onCmdMessage = vi.fn()

    adapter.connection.addEventHandler('test', { onTextMessage, onCmdMessage })
    await handlers.get('test')!.onMessage(createFakeMessage({ type: 'image' }))

    expect(onTextMessage).not.toHaveBeenCalled()
    expect(onCmdMessage).not.toHaveBeenCalled()
  })

  it('归一化 SDK5 RTC Token', async () => {
    const { client } = createMockClient()
    const adapter = createSDK5IMAdapter(client)

    const result = await adapter.connection.getRTCToken('channel_1')

    expect(result.data).toEqual(expect.objectContaining({
      RTCToken: 'token_channel_1',
      appId: 'agora_app',
      RTCUId: 123
    }))
    expect(result.data?.expireIn).toBeGreaterThan(0)
  })

  it('归一化 RTC UID → userId 映射', async () => {
    const { client } = createMockClient()
    const adapter = createSDK5IMAdapter(client)

    const result = await adapter.connection.getUserIdByRTCUIds(['123'])

    expect(client.getUserIdsWithRTCUids).toHaveBeenCalledWith([123])
    expect(result.data).toEqual({ '123': 'user_a' })
  })

  it('拒绝非法 RTC UID', async () => {
    const { client } = createMockClient()
    const adapter = createSDK5IMAdapter(client)

    await expect(adapter.connection.getUserIdByRTCUIds(['abc'])).rejects.toThrow('非法 RTC UID')
  })

  it('映射用户昵称和头像字段', async () => {
    const { client } = createMockClient()
    const adapter = createSDK5IMAdapter(client)

    const users = await adapter.fetchUserInfoById(['user_a'])

    expect(users).toEqual([
      { userId: 'user_a', nickname: 'Alice', avatarURL: 'https://avatar/a.png' }
    ])
  })

  it('使用当前 ChatClient 动态读取用户和设备信息', () => {
    const first = createMockClient()
    const adapter = createSDK5IMAdapter(first.client)
    const second = {
      ...createMockClient().client,
      getCurrentUserId: () => 'user_new',
      getClientResource: () => 'device_new'
    } as unknown as SDK5ChatClient

    adapter.updateClient(second)

    expect(adapter.connection.user).toBe('user_new')
    expect(adapter.connection.context.userId).toBe('user_new')
    expect(adapter.connection.context.jid.clientResource).toBe('device_new')
  })

  it('removeEventHandler 透传 handler id', () => {
    const { client, removeEventHandler } = createMockClient()
    const adapter = createSDK5IMAdapter(client)

    adapter.connection.removeEventHandler('handler_1')

    expect(removeEventHandler).toHaveBeenCalledWith('handler_1')
  })

  // ─── 回归：C-4 deliverOnlineOnly / M-7 账号切换 ───

  it('C-4: CMD 消息透传 deliverOnlineOnly', () => {
    const { client, createCmdMessage } = createMockClient()
    const adapter = createSDK5IMAdapter(client)

    adapter.createMessage({
      type: 'cmd',
      to: 'user_b',
      chatType: 'singleChat',
      action: 'rtcCall',
      ext: { action: 'alert' },
      deliverOnlineOnly: true
    })

    expect(createCmdMessage).toHaveBeenCalledWith(
      expect.objectContaining({ deliverOnlineOnly: true })
    )
  })

  it('C-4: 未指定 deliverOnlineOnly 时不注入该字段', () => {
    const { client, createCmdMessage } = createMockClient()
    const adapter = createSDK5IMAdapter(client)

    adapter.createMessage({
      type: 'cmd',
      to: 'user_b',
      chatType: 'singleChat',
      action: 'rtcCall',
      ext: { action: 'cancelCall' }
    })

    const params = createCmdMessage.mock.calls[0][0] as Record<string, unknown>
    expect('deliverOnlineOnly' in params).toBe(false)
  })

  it('M-7: 切换账号时先摘掉旧 client 的 handler，再注册到新 client', () => {
    const first = createMockClient()
    const second = createMockClient()
    const adapter = createSDK5IMAdapter(first.client)

    adapter.connection.addEventHandler('handler_a', {})
    expect(first.handlers.has('handler_a')).toBe(true)

    adapter.updateClient(second.client)

    // 旧实例上的 handler 必须被移除，否则旧账号消息会继续进入新实例
    expect(first.removeEventHandler).toHaveBeenCalledWith('handler_a')
    expect(first.handlers.has('handler_a')).toBe(false)
    expect(second.handlers.has('handler_a')).toBe(false)

    // Core 之后的重挂只注册到新 client
    adapter.connection.addEventHandler('handler_a', {})
    expect(second.handlers.has('handler_a')).toBe(true)
  })
})
