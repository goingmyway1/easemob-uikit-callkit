import type { ChatClient, ChatManager, Message, UserInfoManager } from 'easemob-websdk'
import type { EasemobConnection, RtcReport } from '@easemob-community/callkit-core-v5'

/** ChatClient.init({ managers: [ChatManager, UserInfoManager] }) 的运行时形态 */
export type SDK5ChatClient = ChatClient & {
  chatManager: ChatManager
  userInfoManager?: UserInfoManager
}

export interface UserProfile {
  userId: string
  nickname?: string
  avatarURL?: string
}

export interface SDK5SignalMessageOptions {
  type: 'txt' | 'text' | 'cmd'
  to: string
  chatType?: 'singleChat' | 'groupChat'
  msg?: string
  action?: string
  ext?: Record<string, unknown>
  receiverList?: string[]
  /**
   * 是否仅投递给在线用户（SDK5 `createCmdMessage` 原生支持）。
   * alert / answerCall / busy 拒绝依赖它避免离线补投：重连后收到上一通的迟到信令
   * 会把用户重新拉回已结束的通话。
   */
  deliverOnlineOnly?: boolean
}

export interface SDK5IMAdapter {
  /** Core 实际消费的结构化 IM 连接 */
  connection: EasemobConnection
  /** 把 CallKit 的裸消息参数转换为 SDK5 Message */
  createMessage: (options: SDK5SignalMessageOptions) => Message
  /** 批量查询用户资料，返回统一 avatarURL 字段 */
  fetchUserInfoById: (userIds: string[]) => Promise<UserProfile[]>
  /** 账号切换时先更新当前 ChatClient，再调用 core.updateImClient(connection) */
  updateClient: (client: SDK5ChatClient) => void
}

interface NormalizedIncomingMessage {
  kind: 'text' | 'cmd'
  message: Record<string, any>
}

const RTC_UID_MAX = 2147483647

function assertChatClient(client: SDK5ChatClient): void {
  if (!client || typeof client !== 'object') {
    throw new TypeError('[SDK5IMAdapter] 需要有效的 ChatClient')
  }
  if (!client.chatManager || typeof client.chatManager.createTextMessage !== 'function') {
    throw new TypeError('[SDK5IMAdapter] ChatClient 未注册 ChatManager')
  }
}

function getMessageId(message: Message): string {
  return message.msgLocalId || message.msgServerId || ''
}

function getCmdAction(message: Message): string {
  const body = message.body as any
  if (body && !Array.isArray(body) && typeof body.action === 'string') {
    return body.action
  }
  const extAction = message.ext?.action
  return typeof extAction === 'string' ? extAction : ''
}

function normalizeIncomingMessage(message: Message): NormalizedIncomingMessage | null {
  if (!message || typeof message !== 'object') return null
  const base = {
    ...message,
    id: getMessageId(message),
    ext: message.ext || {}
  }

  if (message.type === 'text') {
    const body = message.body as any
    return {
      kind: 'text',
      message: {
        ...base,
        msg: body && !Array.isArray(body) && typeof body.content === 'string' ? body.content : ''
      }
    }
  }

  if (message.type === 'cmd') {
    return {
      kind: 'cmd',
      message: {
        ...base,
        action: getCmdAction(message)
      }
    }
  }

  return null
}

function normalizeChatType(chatType?: 'singleChat' | 'groupChat'): 'singleChat' | 'groupChat' {
  return chatType === 'groupChat' ? 'groupChat' : 'singleChat'
}

function toRtcUid(value: number | string): number {
  const uid = typeof value === 'number' ? value : Number(value)
  if (!Number.isInteger(uid) || uid < 0 || uid > RTC_UID_MAX) {
    throw new TypeError(`[SDK5IMAdapter] 非法 RTC UID: ${String(value)}`)
  }
  return uid
}

/**
 * 将 easemob-websdk 5.x ChatClient 适配为 CallKit Core 期望的 EasemobConnection。
 *
 * SDK5 与 SDK4 的关键差异均在此收敛：
 * - onMessage 统一事件拆分为文本/CMD
 * - chatManager.createTextMessage/createCmdMessage 替代 message.create
 * - getRTCTokenInfo 替代 getRTCToken
 * - getUserIdsWithRTCUids 替代 getUserIdByRTCUIds
 */
export function createSDK5IMAdapter(initialClient: SDK5ChatClient): SDK5IMAdapter {
  assertChatClient(initialClient)
  let client = initialClient
  /**
   * 已注册到「当前 client」的 handler id。
   * connection 是稳定引用的包装对象，换 client 后 Core 的 unmount 只会打到新实例上，
   * 旧实例的 handler 若不在这里主动摘掉，会继续把旧账号的消息灌进新实例。
   */
  const registeredHandlerIds = new Set<string>()

  const createMessage = (options: SDK5SignalMessageOptions): Message => {
    assertChatClient(client)
    if (!options || typeof options.to !== 'string' || !options.to.trim()) {
      throw new TypeError('[SDK5IMAdapter] createMessage 缺少有效 to')
    }

    const conversationId = options.to.trim()
    const conversationType = normalizeChatType(options.chatType)
    const ext = options.ext || {}
    const receiverList =
      conversationType === 'groupChat' && options.receiverList?.length
        ? options.receiverList
        : undefined

    if (options.type === 'cmd') {
      return client.chatManager.createCmdMessage({
        conversationId,
        conversationType,
        action: options.action || 'rtcCall',
        ext,
        // 必须显式透传：SignalSender 对所有 alert/answerCall/busy 都传 true，
        // 丢弃后信令会退化成可离线补投
        ...(options.deliverOnlineOnly !== undefined
          ? { deliverOnlineOnly: options.deliverOnlineOnly }
          : {}),
        ...(receiverList ? { receiverList } : {})
      })
    }

    if (options.type === 'txt' || options.type === 'text') {
      return client.chatManager.createTextMessage({
        conversationId,
        conversationType,
        content: options.msg || '',
        ext,
        ...(receiverList ? { receiverList } : {})
      })
    }

    throw new TypeError(`[SDK5IMAdapter] 不支持的消息类型: ${String((options as any).type)}`)
  }

  const connection: EasemobConnection = {
    get user() {
      return client.getCurrentUserId?.() || ''
    },

    get context() {
      return {
        userId: client.getCurrentUserId?.() || '',
        jid: {
          clientResource: client.getClientResource?.() || ''
        }
      }
    },

    get token() {
      return ''
    },

    async send(message: any) {
      assertChatClient(client)
      if (!message || typeof message !== 'object') {
        throw new TypeError('[SDK5IMAdapter] send 需要有效的 Message')
      }
      return client.chatManager.sendMessage(message as Message)
    },

    addEventHandler(id: string, handlers: Record<string, (...args: any[]) => void>) {
      assertChatClient(client)
      const bridge = {
        onMessage: async (message: Message) => {
          const normalized = normalizeIncomingMessage(message)
          if (!normalized) return
          if (normalized.kind === 'text') {
            await handlers.onTextMessage?.(normalized.message)
          } else {
            await handlers.onCmdMessage?.(normalized.message)
          }
        },
        onConnected: () => {
          handlers.onConnected?.()
        },
        onDisconnected: () => {
          handlers.onDisconnected?.()
        }
      }
      client.addEventHandler(id, bridge as Parameters<ChatClient['addEventHandler']>[1])
      registeredHandlerIds.add(id)
    },

    removeEventHandler(id: string) {
      registeredHandlerIds.delete(id)
      client.removeEventHandler(id)
    },

    async getRTCToken(channel: string) {
      assertChatClient(client)
      if (typeof client.getRTCTokenInfo !== 'function') {
        throw new Error('[SDK5IMAdapter] 当前 SDK5 不支持 getRTCTokenInfo')
      }
      if (!channel || !channel.trim()) {
        throw new TypeError('[SDK5IMAdapter] getRTCToken 缺少 channel')
      }
      const info = await client.getRTCTokenInfo({ channelName: channel.trim() })
      return {
        data: {
          RTCToken: info.rtcToken,
          appId: info.appId,
          RTCUId: info.rtcUid,
          expireIn: Math.max(0, info.expireAt - Date.now())
        }
      }
    },

    async getUserIdByRTCUIds(uids: (number | string)[]) {
      assertChatClient(client)
      if (typeof client.getUserIdsWithRTCUids !== 'function') {
        throw new Error('[SDK5IMAdapter] 当前 SDK5 不支持 getUserIdsWithRTCUids')
      }
      const normalized = (uids || []).map(toRtcUid)
      if (normalized.length === 0) return { data: {} }
      const result = await client.getUserIdsWithRTCUids(normalized)
      const data: Record<string, string> = {}
      Object.entries(result || {}).forEach(([uid, userId]) => {
        data[String(uid)] = String(userId)
      })
      return { data }
    }
  }

  const fetchUserInfoById = async (userIds: string[]): Promise<UserProfile[]> => {
    assertChatClient(client)
    const ids = Array.from(new Set((userIds || []).filter((id) => typeof id === 'string' && id)))
    if (ids.length === 0) return []
    if (!client.userInfoManager || typeof client.userInfoManager.getUserInfoByAttribute !== 'function') {
      return []
    }
    try {
      const users = await client.userInfoManager.getUserInfoByAttribute({
        userIds: ids,
        attributes: ['nickname', 'avatarUrl']
      })
      return users.map((user) => ({
        userId: user.userId,
        nickname: user.nickname,
        avatarURL: user.avatarUrl
      }))
    } catch {
      return []
    }
  }

  return {
    connection,
    createMessage,
    fetchUserInfoById,
    updateClient(nextClient: SDK5ChatClient) {
      assertChatClient(nextClient)
      if (nextClient === client) return
      const previous = client
      // 先摘掉旧 client 的 handler，再切换引用；Core 随后的 unmount/mount 只作用于新 client
      registeredHandlerIds.forEach((id) => {
        try {
          previous.removeEventHandler(id)
        } catch {
          // 旧实例可能已被 SDK 注销，忽略即可
        }
      })
      client = nextClient
    }
  }
}

/** 保留给业务层对 RTC 事件做额外分发的类型别名 */
export type SDK5RtcReporter = (report: RtcReport) => void
