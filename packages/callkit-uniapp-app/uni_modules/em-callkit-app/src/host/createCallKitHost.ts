import { ChatClient } from 'easemob-websdk'
import { ChatManager } from 'easemob-websdk/managers/chat'
import { UserInfoManager } from 'easemob-websdk/managers/user-info'
import { GroupManager } from 'easemob-websdk/managers/group'
import { CALL_TYPE, type CallKitCore, type CallKitEvent } from '@easemob-community/callkit-core-v5'
import { createUniappAppCallKit } from '../core-adapter'
import type { UniappAppCallKit } from '../core-adapter'
import { attachCallStageHost } from '../ui/callStageHost'
import type { CallUiBridge } from '../ui/callUiBridge'
import type { SDK5IMAdapter } from '../im/SDK5IMConnectionAdapter'

export interface CreateCallKitHostOptions {
  appKey: string
  userId: string
  /** SDK 5.x 只支持 token 登录；密码登录需要服务端先换 token */
  token: string
  nickname?: string
  /** getRTCToken 未返回 appId 时兜底 */
  defaultRtcAppId?: string
  /** 通话页路径，默认 /pages/call/call */
  callPageUrl?: string
  /**
   * 需要进通话页时的导航实现。不传则用 uni.navigateTo(url)。
   * 传了之后「导航失败要复位标记」的责任交给调用方。
   */
  onNavigate?: (url: string) => void
  /** 通话事件，可直接用来打日志或做业务埋点 */
  onEvent?: (event: CallKitEvent) => void
  logger?: (message: string, data?: unknown) => void
}

export interface CallKitHost {
  core: CallKitCore
  callUi: CallUiBridge
  imAdapter: SDK5IMAdapter
  userId: string
  /** 单聊外呼（会自动预热对方昵称） */
  inviteCall(params: { calleeUserId: string; callType: CALL_TYPE }): Promise<void>
  /** 群聊外呼；不传 participantIds 就自动拉全部群成员（排除自己），返回实际邀请人数 */
  inviteGroupCall(params: {
    groupId: string
    callType: CALL_TYPE
    participantIds?: string[]
  }): Promise<number>
  /** 拉群成员 userId（排除自己） */
  fetchGroupMemberIds(groupId: string): Promise<string[]>
  /** 预热昵称头像缓存；桥接层是同步查的，异步来源必须先调这个 */
  primeUserProfiles(userIds: string[]): Promise<void>
  /** 通话页退场后调用，允许下一通再次导航 */
  markCallPageClosed(): void
  /** 断开监听、销毁 CallKit、登出 */
  dispose(): Promise<void>
}

const DEFAULT_CALL_PAGE = '/pages/call/call'

/**
 * 宿主统一入口：从「建 IM 连接」到「通话页导航」一次做完。
 *
 * 内部固定 `rtcOwnership: 'component'`——RTC 交给 agora-rtc 自带 UI，
 * 本插件只负责信令与桥接；因此宿主不需要创建 RtcCallSession。
 *
 * 注意：通话页必须是 `.nvue`，且宿主项目里要有 `uni_modules/agora-rtc`。
 */
export async function createCallKitHost(options: CreateCallKitHostOptions): Promise<CallKitHost> {
  if (!options || !options.appKey || !options.userId || !options.token) {
    throw new TypeError('[createCallKitHost] appKey / userId / token 必传')
  }

  const log = (message: string, data?: unknown) => options.logger?.(`[CallKitHost] ${message}`, data)
  const userCache: Record<string, { nickname?: string; avatarURL?: string }> = {}

  const client: any = ChatClient.init({
    appKey: options.appKey,
    managers: [ChatManager, UserInfoManager, GroupManager]
  })
  await client.login({ userId: options.userId, token: options.token })
  userCache[options.userId] = { nickname: options.nickname || options.userId }

  let callkit: UniappAppCallKit
  try {
    callkit = createUniappAppCallKit({
      client,
      // 固定组件模式：不创建 AgoraAppRtcAdapter，RTC 归 agora-rtc 组件
      rtcOwnership: 'component',
      defaultRtcAppId: options.defaultRtcAppId,
      userProfile: {
        userId: options.userId,
        nickname: options.nickname || options.userId
      },
      resolveProfile: (userId) => userCache[userId],
      onEvent: (event) => {
        // 来电自带的资料先落到缓存，后续桥接层同步查时才能拿到昵称
        const payload = event.payload as { callerUserId?: string; callerInfo?: { nickname?: string; avatarURL?: string } }
        if (event.type === 'incomingCall' && payload.callerInfo && payload.callerUserId) {
          userCache[payload.callerUserId] = payload.callerInfo
        }
        options.onEvent?.(event)
      },
      logger: options.logger
    })
  } catch (error) {
    // 创建失败时把 IM 连接收掉，避免半初始化状态
    try {
      await client.logout()
    } catch (logoutError) {
      log('登录成功后创建 CallKit 失败，登出也失败', logoutError)
    }
    throw error
  }

  const callUi = callkit.callUi
  if (!callUi) {
    await callkit.dispose().catch(() => undefined)
    throw new Error('[createCallKitHost] callUi 未创建，请确认 rtcOwnership 为 component')
  }

  let onCallPage = false

  const offStageHost = attachCallStageHost({
    callUi,
    core: callkit.core,
    onClosed: () => {
      onCallPage = false
    },
    logger: options.logger
  })

  const navigate =
    options.onNavigate ||
    ((url: string) => {
      uni.navigateTo({
        url,
        fail: () => {
          // 导航失败必须复位，否则这一通之后再也进不了通话页
          onCallPage = false
        }
      })
    })

  const offViewChange = callUi.onChange((view) => {
    if (!view.visible || onCallPage) return
    onCallPage = true
    try {
      navigate(options.callPageUrl || DEFAULT_CALL_PAGE)
    } catch (error) {
      onCallPage = false
      log('导航到通话页失败', error)
    }
  })

  const primeUserProfiles = async (userIds: string[]): Promise<void> => {
    if (!userIds.length) return
    try {
      const profiles = await callkit.imAdapter.fetchUserInfoById(userIds)
      profiles.forEach((profile) => {
        userCache[profile.userId] = { nickname: profile.nickname, avatarURL: profile.avatarURL }
      })
    } catch (error) {
      log('拉取用户资料失败', error)
    }
  }

  const fetchGroupMemberIds = async (groupId: string): Promise<string[]> => {
    const manager = client.groupManager
    if (!manager || typeof manager.getGroup !== 'function') {
      throw new Error('[createCallKitHost] 当前 SDK 未注册 GroupManager，无法读取群成员')
    }
    const group = manager.getGroup(groupId)
    if (!group || typeof group.getMembers !== 'function') {
      throw new Error(`[createCallKitHost] 群 ${groupId} 不存在或不可读`)
    }
    const ids: string[] = []
    let cursor: string | undefined
    // 游标翻页，上限 10 页（2000 人），防止异常数据把内存撑爆
    for (let page = 0; page < 10; page += 1) {
      const result: any = await group.getMembers(cursor ? { pageSize: 200, cursor } : { pageSize: 200 })
      const items: any[] = (result && result.items) || []
      items.forEach((item) => {
        const id = item && item.user && item.user.userId
        if (id) ids.push(String(id))
      })
      cursor = result && result.hasMore ? String(result.cursor || '') : ''
      if (!cursor) break
    }
    const unique = Array.from(new Set(ids))
    return unique.filter((id) => id !== options.userId)
  }

  let disposed = false

  const host: CallKitHost = {
    core: callkit.core,
    callUi,
    imAdapter: callkit.imAdapter,
    userId: options.userId,

    async inviteCall(params) {
      if (disposed) throw new Error('[createCallKitHost] 实例已销毁')
      await primeUserProfiles([params.calleeUserId])
      await callkit.core.inviteCall(params)
    },

    async inviteGroupCall(params) {
      if (disposed) throw new Error('[createCallKitHost] 实例已销毁')
      if (!params.groupId) throw new Error('[createCallKitHost] 群 ID 不能为空')
      const participantIds =
        params.participantIds && params.participantIds.length
          ? Array.from(new Set(params.participantIds))
          : await fetchGroupMemberIds(params.groupId)
      if (!participantIds.length) {
        throw new Error('[createCallKitHost] 群里没有其他成员，无法发起群通话')
      }
      await primeUserProfiles(participantIds)
      await callkit.core.inviteGroupCall({
        groupId: params.groupId,
        participantIds,
        callType: params.callType
      })
      return participantIds.length
    },

    fetchGroupMemberIds,
    primeUserProfiles,

    markCallPageClosed() {
      onCallPage = false
    },

    async dispose() {
      if (disposed) return
      disposed = true
      offViewChange()
      offStageHost()
      await callkit.dispose().catch((error) => log('销毁 CallKit 失败', error))
      try {
        await client.logout()
      } catch (error) {
        log('登出失败', error)
      }
    }
  }

  return host
}
