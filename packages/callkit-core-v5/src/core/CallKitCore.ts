import type {
  CallKitCoreConfig,
  InviteCallParams,
  AnswerCallParams,
  HangupParams,
  InviteGroupCallParams,
  RtcReport,
  EasemobConnection,
} from './CallKitCore.types'
import type { CallKitEvent } from '../events/CallKitEvents'
import { isUIEvent, isRtcEvent } from '../events/CallKitEvents'
import type { DomainEvent, SingleCallState } from '../state/SingleCallStateMachine'
import { getLogger } from '../utils/logger'
import type { Logger } from '../utils/logger'
import { EventBus } from '../events/EventBus'
import { SingleCallStateMachine } from '../state/SingleCallStateMachine'
import { GroupCallSession } from '../state/GroupCallSession'
import { SignalRouter } from '../signaling/SignalRouter'
import { SignalSender } from '../signaling/SignalSender'
import { SingleCallSignalHandler } from '../signaling/SingleCallSignalHandler'
import { GroupCallSignalHandler } from '../signaling/GroupCallSignalHandler'
import { IMListener } from '../im/IMListener'
import { MessageBuilder } from '../signaling/MessageBuilder'
import { generateRandomChannel, isMessageExpired, isCmdMessageExpired } from '../utils/callUtils'
import { CALL_STATUS, CALL_TYPE, HANGUP_REASON } from '../types/callstate.types'
import type { HangupReason } from '../types/callstate.types'

/**
 * CallKitCore
 * 框架无关的通话信令核心。
 *
 * 职责：
 * 1. 管理单聊/群聊通话生命周期
 * 2. 通过事件回调通知上层所有决策点
 * 3. 不直接操作任何 RTC SDK，RTC 由上层通过适配器或事件自行处理
 */
export class CallKitCore {
  /** 被叫 accept 后等待主叫 confirmCallee 的超时时长（正常链路为百毫秒级，10s 已足够宽容） */
  private static readonly CONFIRM_CALLEE_TIMEOUT_MS = 10000

  private config: CallKitCoreConfig
  private logger: Logger
  private singleCallState: SingleCallStateMachine
  private groupCallSession: GroupCallSession
  private signalRouter: SignalRouter
  private signalSender: SignalSender
  private singleCallHandler: SingleCallSignalHandler
  private groupCallHandler: GroupCallSignalHandler
  private imListener: IMListener
  private destroyed = false
  private inviteTimer: ReturnType<typeof setTimeout> | null = null
  // 被叫 accept 后等待主叫 confirmCallee 的超时定时器（confirmCallee 永不到达时回收状态机）
  private confirmCalleeTimer: ReturnType<typeof setTimeout> | null = null
  // 群聊成员邀请超时定时器：`${callId}:${userId}` → timer。
  // 单聊只有一个总超时，群聊必须按成员移除占位，否则部分拒绝/部分超时无法收敛。
  private groupParticipantTimers = new Map<string, ReturnType<typeof setTimeout>>()
  // 自动结束会再次触发状态机事件，防止重入
  private autoEndingGroupCall = false
  // 本场群聊是否曾有远端真正进入 RTC，用于区分“等待中没人接”和“通话中全部挂断”
  private groupCallHadRemoteJoined = false
  // 防止 inviteCall / inviteGroupCall 被并发调用导致状态机被覆盖
  private invitingLock = false

  // 群聊被叫方在 fetchRtcToken 期间可能收到主叫的取消/离开信令，
  // 但此时 singleCallState 仍为 IDLE，SignalRouter 会忽略这些信令。
  // 用 Map 记录“待处理的 incoming invite”，在 token 返回后检查是否已被 abort。
  private pendingIncomingInvites = new Map<string, { aborted: boolean }>()

  // 近期收到过 cancelCall 的 callId → 名单过期时间戳。
  // 场景：被叫离线期间主叫发起并取消呼叫，重新登录时 IM 离线补投不保证顺序，
  // cancelCall 可能先于 invite 到达（此时状态机 IDLE，cancel 被按 callId 不匹配丢弃），
  // 随后补投的 invite 会被当作新来电弹出"已放弃的呼叫"。
  // 记录名单后，同 callId 的迟到的 invite 直接丢弃。
  private recentlyCanceledCalls = new Map<string, number>()

  // RTC 凭据按 callId 绑定。token 请求可并发乱序完成，不能写入全局“当前值”后互相覆盖。
  // Agora 加入频道时必须使用服务端返回的数值 RTCUId，而不是 IM 的字符串 userId。
  private rtcCredentials = new Map<string, { token: string; appId: string; uid: number }>()

  // 数字 uid → IM userId 的本地缓存。
  // RTC 适配层解析 userId 依赖远端查询，失败时会只带 uid 上报；
  // 这里用历史成功结果兜底，避免成员状态永远停在 joinedRtc（离开也不更新）。
  private rtcUidToUserId = new Map<number | string, string>()

  // 当前用户信息（实时读取：因 Provider 在登录前就 init，必须每次发送时从 imClient 取最新值，与旧版 lib/services/ChatService.ts 行为对齐）
  private inviteTimeoutMs: number

  // 通话时长计时器
  private durationTimer: ReturnType<typeof setInterval> | null = null
  private durationSeconds: number = 0
  private durationCallInfo: { callId: string; channel: string; callType: CALL_TYPE; callerUserId: string } | null = null

  private get userId(): string {
    return this.config.imClient.context?.userId || (this.config.imClient as any).user || ''
  }

  private get deviceId(): string {
    return this.config.imClient.context?.jid?.clientResource || ''
  }

  // 事件总线（供上层精细订阅）
  private eventBus: EventBus<{ callKitEvent: CallKitEvent }>

  constructor(config: CallKitCoreConfig) {
    this.config = config
    this.logger = config.logger || getLogger()
    this.eventBus = new EventBus<{ callKitEvent: CallKitEvent }>(this.logger)

    // userId / deviceId 通过 getter 实时读取，避免登录前快照导致 ext 字段为空
    this.inviteTimeoutMs = config.inviteTimeout || 30000

    // 初始化状态层
    this.singleCallState = new SingleCallStateMachine(this.logger)
    this.groupCallSession = new GroupCallSession(this.logger)

    // 初始化信令层
    this.signalRouter = new SignalRouter(this.logger)
    this.signalSender = new SignalSender(config.imClient, this.logger, config.createMessage)

    // 初始化 Handler（传入 provider 函数，确保每次校验/读取时都拿最新登录态）
    this.singleCallHandler = new SingleCallSignalHandler(
      this.singleCallState,
      this.signalSender,
      () => this.deviceId,
      this.logger
    )
    this.groupCallHandler = new GroupCallSignalHandler(
      this.groupCallSession,
      this.singleCallState,
      this.signalSender,
      () => this.userId,
      this.logger
    )

    // 注册到 Router
    this.signalRouter.register('alert', this.singleCallHandler)
    this.signalRouter.register('confirmRing', this.singleCallHandler)
    this.signalRouter.register('answerCall', this.singleCallHandler)
    this.signalRouter.register('cancelCall', this.singleCallHandler)
    this.signalRouter.register('leaveCall', this.singleCallHandler)
    this.signalRouter.register('confirmCallee', this.singleCallHandler)

    this.signalRouter.register('answerCall', this.groupCallHandler)
    this.signalRouter.register('cancelCall', this.groupCallHandler)
    this.signalRouter.register('leaveCall', this.groupCallHandler)

    // 初始化 IM 监听
    this.imListener = new IMListener(
      config.imClient,
      {
        onTextMessage: (msg) => this.handleTextMessage(msg),
        onCmdMessage: (msg) => this.handleCmdMessage(msg),
        onConnected: () => this.handleIMConnected(),
        onDisconnected: () => this.handleIMDisconnected(),
      },
      this.logger
    )
    this.imListener.mount()

    this.logger.info('[CallKitCore] 初始化完成（userId/deviceId 将在登录后实时读取）')
    this.logger.warn('🚀 ========== CallKitCore 链路已激活 ========== 🚀')
    this.logger.warn('   版本: callkit-core | 当前用户:', this.userId || '(尚未登录)', '| 设备:', this.deviceId || '(尚未登录)')
  }

  /**
   * 更新底层 IM 客户端实例（用于账号切换等场景）。
   * 会同步更新 SignalSender、IMListener 以及内部 config，不丢失当前通话状态。
   */
  updateImClient(imClient: EasemobConnection): void {
    if (this.destroyed) throw new Error('CallKitCore 已销毁')
    if (!imClient) throw new Error('updateImClient 需要有效的 IM 客户端实例')

    this.config.imClient = imClient
    this.signalSender.updateImClient(imClient)
    this.imListener.updateImClient(imClient)

    this.logger.info('[CallKitCore] IM 客户端实例已更新')
    this.logger.warn('🚀 ========== CallKitCore 链路已更新 ========== 🚀')
    this.logger.warn('   版本: callkit-core | 当前用户:', this.userId || '(尚未登录)', '| 设备:', this.deviceId || '(尚未登录)')
  }

  // ───────────────────────────────────────────────
  // 单聊 API
  // ───────────────────────────────────────────────

  /**
   * 发起单聊通话
   */
  async inviteCall(params: InviteCallParams): Promise<void> {
    if (this.destroyed) throw new Error('CallKitCore 已销毁')
    if (!this.isIdle()) throw new Error('当前正在通话中，无法发起新通话')
    if (this.invitingLock) throw new Error('正在发起通话中，请勿重复点击')
    this.invitingLock = true

    try {
      const callId = generateRandomChannel(16)
      const channel = generateRandomChannel(12)
      const rtc = await this.fetchRtcToken(channel)

      // token 等待期间可能已销毁，或另一通 incoming/outgoing 已占用状态机。
      if (this.destroyed) return
      if (!this.isIdle()) throw new Error('当前正在通话中，无法发起新通话')

      const stateResult = this.singleCallState.initInvite({
        calleeUserId: params.calleeUserId,
        callType: params.callType,
        callerDevId: this.deviceId,
        callerUserId: this.userId,
        callId,
        channel,
        token: rtc.token,
        timeout: this.inviteTimeoutMs,
        inviteTs: Date.now(),
      })
      this.rtcCredentials.set(callId, rtc)
      this.startInviteTimeout()

      const callerInfo = {
        ...this.config.userProfile,
        ...params.callerInfo,
      }
      const ext = MessageBuilder.buildInviteExt({
        callId,
        callerUserId: this.userId,
        calleeUserId: params.calleeUserId,
        callerDevId: this.deviceId,
        channel,
        callType: params.callType,
        callerInfo,
      })

      try {
        await this.signalSender.sendInviteMessage(
          params.calleeUserId,
          'singleChat',
          '[通话邀请]',
          ext
        )
      } catch (sendError) {
        // 异步发送失败只能回滚它自己的呼叫，不能误伤等待期间建立的新通话。
        if (this.isCurrentCall(callId)) {
          this.emitError('inviteSendFailed', sendError, { callId, calleeUserId: params.calleeUserId })
          const snapshotBeforeRollback = this.singleCallState.getState()
          const hangupResult = this.singleCallState.hangup(HANGUP_REASON.CANCEL)
          this.processEvents(hangupResult.events, snapshotBeforeRollback)
        }
        throw sendError
      }

      if (!this.isCurrentCall(callId)) return
      if (this.singleCallState.getState().status === CALL_STATUS.INVITING) {
        this.processEvents(stateResult.events, this.singleCallState.getState())
      }
    } finally {
      this.invitingLock = false
    }
  }

  /**
   * 响应来电（接受/拒绝）
   */
  async answerCall(params: AnswerCallParams): Promise<void> {
    if (this.destroyed) throw new Error('CallKitCore 已销毁')

    const state = this.singleCallState.getState()

    // 无来电时直接拒绝：否则会用空 callId/空对端构造 CMD，
    // 最终在适配层抛"缺少有效 to"，把一次 UI 误触变成错误事件 + 一次失败网络请求
    if (state.status === CALL_STATUS.IDLE) {
      throw new Error('当前无来电，无法接听')
    }
    // UI 可能持有上一通的接听按钮（多端/快速重呼），必须校验 callId 才允许操作
    if (params.callId && params.callId !== state.callId) {
      throw new Error(`callId 不匹配：当前通话为 ${state.callId}，收到 ${params.callId}`)
    }

    // 兼容旧版 accept: boolean 参数
    const result = params.result ?? (params.accept ? 'accept' : 'refuse')
    const isGroupCall = state.type === CALL_TYPE.VIDEO_MULTI || state.type === CALL_TYPE.AUDIO_MULTI

    // 被叫方资料：本次传入的 calleeInfo 优先，回退到初始化时的 userProfile
    const mergedCalleeInfo = {
      nickname: params.calleeInfo?.nickname ?? this.config.userProfile?.nickname,
      avatarURL: params.calleeInfo?.avatarURL ?? this.config.userProfile?.avatarURL,
    }
    const calleeUserInfo =
      mergedCalleeInfo.nickname || mergedCalleeInfo.avatarURL ? mergedCalleeInfo : undefined

    // 构建并发送 answerCall 信令（群聊也是点对点发给主叫方）
    const ext = MessageBuilder.buildCmdExt({
      action: 'answerCall',
      callId: state.callId,
      callerDevId: state.callerDevId,
      calleeDevId: this.deviceId,
      result,
      userInfo: calleeUserInfo,
    })

    // 发送失败不阻断本地状态流转（accept 有 confirmCallee 超时兜底、refuse 必须完成本地清理），
    // 但需上报，避免"已拒绝但对方未知"的静默分叉
    try {
      await this.signalSender.sendCmdMessage(
        state.callerUserId,
        'singleChat',
        ext,
        { deliverOnlineOnly: true }
      )
    } catch (sendError) {
      if (this.isCurrentCall(state.callId)) {
        this.emitError('answerSendFailed', sendError, { callId: state.callId, result })
      }
    }

    // answer 发送期间可能已 destroy、被远端取消，或 confirmCallee 已先到。
    if (!this.isCurrentCall(state.callId)) return

    if (result === 'accept') {
      if (this.singleCallState.getState().status === CALL_STATUS.IN_CALL) return
      // 被叫 accept 后不直接进入 IN_CALL，等待主叫方 confirmCallee
      this.clearInviteTimeout()
      this.startConfirmCalleeTimeout()
      this.logger.info(
        isGroupCall
          ? '[CallKitCore] 群聊接受，等待 confirmCallee 后再进入 IN_CALL'
          : '[CallKitCore] 单聊接受，等待 confirmCallee'
      )
    } else {
      // ── 拒绝/忙线分支 ──
      // 清理本地状态
      const hangupReason = result === 'busy' ? HANGUP_REASON.BUSY : HANGUP_REASON.REFUSE
      const hangupResult = this.singleCallState.hangup(hangupReason)
      this.processEvents(hangupResult.events, state)
    }
  }

  /**
   * 挂断/取消通话
   */
  async hangup(params?: HangupParams): Promise<void> {
    if (this.destroyed) throw new Error('CallKitCore 已销毁')

    const state = this.singleCallState.getState()
    // UI 可能仍持有上一通通话的挂断按钮；旧 callId 不得清理新通话的定时器或发送信令。
    if (params?.callId && params.callId !== state.callId) {
      this.logger.warn('[CallKitCore] hangup: callId 不匹配，忽略', {
        requestedCallId: params.callId,
        currentCallId: state.callId,
      })
      return
    }
    const currentStatus = state.status

    if (currentStatus === CALL_STATUS.IDLE) {
      this.logger.warn('[CallKitCore] hangup: 当前 IDLE，忽略')
      return
    }

    // 显式清理 confirmCallee 等待定时器（L8：不依赖"新通话入口连带清理"的隐式路径）
    this.clearConfirmCalleeTimeout()

    // 根据状态决定发送 cancelCall 还是 leaveCall
    const isGroupCall =
      state.type === CALL_TYPE.VIDEO_MULTI || state.type === CALL_TYPE.AUDIO_MULTI

    if (currentStatus === CALL_STATUS.INVITING || currentStatus === CALL_STATUS.ALERTING) {
      this.clearInviteTimeout()
      // 发送 cancelCall
      const ext = MessageBuilder.buildCmdExt({
        action: 'cancelCall',
        callId: state.callId,
        callerDevId: state.callerDevId,
      })

      if (isGroupCall) {
        // 群聊：发送到群 groupId，携带 receiverList 定向给被邀请成员（与旧版 CallService 对齐）
        const groupSnapshot = this.groupCallSession.getSnapshot()
        const groupId = groupSnapshot?.groupId || state.calleeUserId
        const allParticipants = this.groupCallSession.getAllParticipants()
        const receiverList = allParticipants
          .filter((p) => p.userId !== this.userId && p.state === 'invited')
          .map((p) => p.userId)
        this.logger.warn(
          '[CallKitCore] 群聊取消: participants=',
          allParticipants.map((p) => ({ userId: p.userId, state: p.state })),
          '| receiverList=',
          receiverList
        )
        if (groupId && receiverList.length > 0) {
          this.logger.warn('[CallKitCore] 群聊取消: 发送 cancelCall 到', groupId, 'receiverList:', receiverList)
          await this.signalSender
            .sendCmdMessage(groupId, 'groupChat', ext, { receiverList })
            .catch((err) => {
              this.logger.error('[CallKitCore] 群聊取消: 发送 cancelCall 失败', err)
            })
        } else {
          this.logger.warn('[CallKitCore] 群聊取消: 无接收者，跳过发送 cancelCall')
        }
      } else {
        // 单聊
        const targetId = state.callerUserId === this.userId ? state.calleeUserId : state.callerUserId
        await this.signalSender.sendCmdMessage(targetId, 'singleChat', ext).catch((err) => {
          this.logger.error('[CallKitCore] 发送 cancelCall 失败（单聊）', { targetId, callId: state.callId, error: err })
        })
      }
    } else if (currentStatus === CALL_STATUS.IN_CALL) {
      this.clearInviteTimeout()
      // 发送 leaveCall
      const ext = MessageBuilder.buildCmdExt({
        action: 'leaveCall',
        callId: state.callId,
      })

      if (isGroupCall) {
        // 群聊：发送到群 groupId，携带 receiverList 定向给通话中成员（与旧版 CallService 对齐）
        const groupSnapshot = this.groupCallSession.getSnapshot()
        const groupId = groupSnapshot?.groupId || state.calleeUserId
        const receiverList = this.groupCallSession
          .getAllParticipants()
          .filter((p) => p.userId !== this.userId && p.state !== 'left')
          .map((p) => p.userId)
        if (groupId && receiverList.length > 0) {
          await this.signalSender
            .sendCmdMessage(groupId, 'groupChat', ext, { receiverList })
            .catch((err) => {
              this.logger.error('[CallKitCore] 发送 leaveCall 失败（群聊）', { groupId, callId: state.callId, error: err })
            })
        }
      } else {
        // 单聊
        const targetId = state.callerUserId === this.userId ? state.calleeUserId : state.callerUserId
        await this.signalSender.sendCmdMessage(targetId, 'singleChat', ext).catch((err) => {
          this.logger.error('[CallKitCore] 发送 leaveCall 失败（单聊）', { targetId, callId: state.callId, error: err })
        })
      }
    }

    // 信令发送等待期间，原呼叫可能已结束且新呼叫已建立；旧 hangup 不得清理新状态。
    if (!this.isCurrentCall(state.callId)) return

    const reason = params?.reason === 'cancel'
      ? HANGUP_REASON.CANCEL
      : params?.reason === 'timeout'
      ? HANGUP_REASON.NO_RESPONSE
      : HANGUP_REASON.HANGUP

    const hangupResult = this.singleCallState.hangup(reason)
    this.clearInviteTimeout()
    this.processEvents(hangupResult.events, state)
  }

  // ───────────────────────────────────────────────
  // 群聊 API
  // ───────────────────────────────────────────────

  /**
   * 通话中邀请更多成员加入群聊通话
   */
  async inviteMoreParticipants(participantIds: string[]): Promise<void> {
    if (this.destroyed) throw new Error('CallKitCore 已销毁')

    const state = this.singleCallState.getState()
    if (state.status !== CALL_STATUS.IN_CALL && state.status !== CALL_STATUS.INVITING) {
      this.logger.warn('[CallKitCore] inviteMoreParticipants: 当前不在通话中，忽略')
      return
    }

    const isGroupCall = state.type === CALL_TYPE.VIDEO_MULTI || state.type === CALL_TYPE.AUDIO_MULTI
    if (!isGroupCall) {
      this.logger.warn('[CallKitCore] inviteMoreParticipants: 当前不是群聊通话，忽略')
      return
    }

    const groupSnapshot = this.groupCallSession.getSnapshot()
    const groupId = groupSnapshot?.groupId
    if (!groupId) {
      this.logger.warn('[CallKitCore] inviteMoreParticipants: 群聊会话未初始化')
      return
    }

    // 构建 invite 文本消息
    // 追加邀请时复用当前会话的群名称，避免退化成 groupId
    const ext = MessageBuilder.buildInviteExt({
      callId: state.callId,
      callerUserId: this.userId,
      calleeUserId: groupId,
      callerDevId: this.deviceId,
      channel: state.channel,
      callType: state.type,
      invitedMembers: participantIds,
      groupInfo: { groupId, groupName: groupSnapshot?.groupName || groupId },
      callerInfo: this.config.userProfile,
    })

    // 先发送邀请消息，成功后再添加参与者到会话
    try {
      await this.signalSender.sendInviteMessage(
        participantIds,
        'groupChat',
        '[群通话邀请]',
        ext,
        groupId
      )
    } catch (err) {
      const currentSession = this.groupCallSession.getSnapshot()
      if (
        this.isCurrentCall(state.callId) &&
        currentSession?.sessionId === groupSnapshot.sessionId &&
        currentSession.groupId === groupId &&
        currentSession.status !== 'ended'
      ) {
        this.emitError('inviteMoreParticipantsFailed', err, { callId: state.callId, participantIds })
      }
      this.logger.error('[CallKitCore] 发送追加邀请失败', err)
      throw err
    }

    // A deferred send must not append to an ended or replacement call/session.
    const currentSession = this.groupCallSession.getSnapshot()
    if (
      !this.isCurrentCall(state.callId) ||
      currentSession?.sessionId !== groupSnapshot.sessionId ||
      currentSession.groupId !== groupId ||
      currentSession.status === 'ended'
    ) return

    // Add participants only after the original session's send succeeds.
    const addedParticipantIds: string[] = []
    participantIds.forEach((userId: string) => {
      if (!this.groupCallSession.getParticipant(userId)) {
        this.groupCallSession.addParticipant({
          userId,
          nickname: userId,
          avatarUrl: '',
          state: 'invited',
          isLocal: false,
          isMuted: false,
          isCameraOn: false,
          isSpeaking: false,
        })
        addedParticipantIds.push(userId)
      }
    })
    this.scheduleGroupParticipantTimeouts(state.callId, addedParticipantIds)
    addedParticipantIds.forEach((userId) => {
      this.emitEvent({
        type: 'participantStateChanged',
        payload: { callId: state.callId, userId, state: 'invited', groupId },
      } as CallKitEvent)
    })

    this.logger.info('[CallKitCore] 已发送追加邀请', { groupId, participantIds })
  }

  /**
   * 发起群聊通话
   */
  async inviteGroupCall(params: InviteGroupCallParams): Promise<void> {
    if (this.destroyed) throw new Error('CallKitCore 已销毁')
    if (!this.isIdle()) throw new Error('当前正在通话中，无法发起新通话')
    if (this.invitingLock) throw new Error('正在发起通话中，请勿重复点击')
    this.invitingLock = true

    try {
      const callId = generateRandomChannel(16)
      const channel = generateRandomChannel(12)
      const callTypeStr = params.callType === CALL_TYPE.VIDEO_MULTI ? 'video' : 'audio'
      const rtc = await this.fetchRtcToken(channel)

      if (this.destroyed) return
      if (!this.isIdle()) throw new Error('当前正在通话中，无法发起新通话')

      const groupName = params.ext?.groupName || params.groupId
      const groupAvatar = params.ext?.groupAvatar
      this.groupCallHadRemoteJoined = false

      this.groupCallSession.init({
        sessionId: channel,
        groupId: params.groupId,
        groupName,
        callType: callTypeStr,
        callerUserId: this.userId,
      })
      this.groupCallSession.addParticipant({
        userId: this.userId,
        nickname: this.userId,
        avatarUrl: '',
        state: 'joinedRtc',
        isLocal: true,
        isMuted: false,
        isCameraOn: callTypeStr === 'video',
        isSpeaking: false,
      })
      params.participantIds.forEach((userId: string) => {
        this.groupCallSession.addParticipant({
          userId,
          nickname: userId,
          avatarUrl: '',
          state: 'invited',
          isLocal: false,
          isMuted: false,
          isCameraOn: false,
          isSpeaking: false,
        })
      })

      this.processEvents(
        [
          {
            type: 'GROUP_CALL_INIT',
            callId,
            groupId: params.groupId,
            groupName,
            channel,
            callType: callTypeStr,
            callerUserId: this.userId,
            invitedMembers: params.participantIds,
          },
        ],
        this.singleCallState.getState()
      )
      if (this.destroyed) return

      const stateResult = this.singleCallState.initInvite({
        calleeUserId: params.groupId,
        callType: params.callType,
        callerDevId: this.deviceId,
        callerUserId: this.userId,
        callId,
        channel,
        token: rtc.token,
        timeout: this.inviteTimeoutMs,
        inviteTs: Date.now(),
      })
      this.rtcCredentials.set(callId, rtc)

      const callerInfo = {
        ...this.config.userProfile,
        ...params.callerInfo,
      }
      const ext = MessageBuilder.buildInviteExt({
        callId,
        callerUserId: this.userId,
        calleeUserId: params.groupId,
        callerDevId: this.deviceId,
        channel,
        callType: params.callType,
        invitedMembers: params.participantIds,
        groupInfo: { groupId: params.groupId, groupName, groupAvatar },
        callerInfo,
      })
      const inviteMessage = params.ext?.message || '[群通话邀请]'

      try {
        await this.signalSender.sendInviteMessage(
          params.participantIds,
          'groupChat',
          inviteMessage,
          ext,
          params.groupId
        )
      } catch (sendError) {
        if (this.isCurrentCall(callId)) {
          this.emitError('groupInviteSendFailed', sendError, { callId, groupId: params.groupId })
          const snapshotBeforeRollback = this.singleCallState.getState()
          this.groupCallSession.end()
          const rollback = this.singleCallState.hangup(HANGUP_REASON.CANCEL)
          this.processEvents(rollback.events, snapshotBeforeRollback)
        }
        throw sendError
      }

      if (!this.isCurrentCall(callId)) return
      if (this.singleCallState.getState().status !== CALL_STATUS.INVITING) return

      this.processEvents(stateResult.events, this.singleCallState.getState())
      if (!this.isCurrentCall(callId) || this.singleCallState.getState().status !== CALL_STATUS.INVITING) return
      this.logger.info('[CallKitCore] 群聊主叫方：进入 IN_CALL 并触发 RTC 加入')
      const answerResult = this.singleCallState.receiveAnswer('accept', false)
      if (answerResult.ok && this.isCurrentCall(callId)) {
        this.processEvents(answerResult.events, this.singleCallState.getState())
      }
    } finally {
      this.invitingLock = false
    }
  }

  // ───────────────────────────────────────────────
  // 媒体控制
  // ───────────────────────────────────────────────

  /**
   * 切换本地音频（静音/取消静音）
   */
  toggleAudio(): void {
    if (this.destroyed) throw new Error('CallKitCore 已销毁')
    const stateResult = this.singleCallState.toggleAudio()
    this.processEvents(stateResult.events, this.singleCallState.getState())
  }

  /**
   * 切换本地视频（开启/关闭摄像头）
   */
  toggleVideo(): void {
    if (this.destroyed) throw new Error('CallKitCore 已销毁')
    const stateResult = this.singleCallState.toggleVideo()
    this.processEvents(stateResult.events, this.singleCallState.getState())
  }

  // ───────────────────────────────────────────────
  // RTC 反馈
  // ───────────────────────────────────────────────

  /**
   * 获取本次呼叫独立的 RTC 凭据，不写共享可变状态。
   * 调用方在确认该呼叫仍可提交后，才按 callId 保存这份结果。
   */
  private async fetchRtcToken(channel: string): Promise<{ token: string; appId: string; uid: number }> {
    try {
      const tokenRes: any = await this.config.imClient.getRTCToken(channel)
      const data: any = tokenRes?.data ?? tokenRes ?? {}
      const token: string = data.RTCToken ?? data.accessToken ?? tokenRes?.accessToken ?? ''
      const appId: string = data.appId ?? tokenRes?.appId ?? ''
      const uid: number = Number(data.RTCUId ?? data.rtcUid ?? 0) || 0

      if (!token) {
        this.logger.warn('[CallKitCore] getRTCToken 返回 token 为空', { tokenRes })
      } else {
        this.logger.info('[CallKitCore] 获取 RTC token 成功', {
          channel,
          appId,
          rtcUid: uid,
          hasToken: true,
        })
      }
      return { token, appId, uid }
    } catch (err) {
      this.emitError('rtcTokenFetchFailed', err, { channel })
      this.logger.warn('[CallKitCore] 获取 RTC token 失败，使用空 token', err)
      return { token: '', appId: '', uid: 0 }
    }
  }

  /**
   * 上层调用 RTC SDK 后，通过此方法反馈 RTC 事件给核心库
   */
  reportRtcEvent(report: RtcReport): void {
    this.logger.info('[CallKitCore] reportRtcEvent', report)

    const { type, payload } = report
    const uid = payload.uid
    const hasUid = uid !== undefined && uid !== null

    // 任何同时带有 uid 与 userId 的上报都用于刷新本地映射
    if (payload.userId && hasUid) {
      this.rtcUidToUserId.set(uid as number | string, payload.userId)
    }
    // 适配层解析失败（只有 uid）时用缓存兜底，仍解析不到才跳过
    const userId = payload.userId || (hasUid ? this.rtcUidToUserId.get(uid as number | string) : undefined)

    // 群聊参与者 RTC 状态同步
    if (userId) {
      const callSnapshot = this.singleCallState.getState()
      const groupSnapshot = this.groupCallSession.getSnapshot()
      const previousState = this.groupCallSession.getParticipant(userId)?.state
      let participantState: 'joinedRtc' | 'left' | null = null
      switch (type) {
        case 'userJoined':
        case 'userPublished':
          if (this.groupCallSession.markJoinedRtc(userId) && previousState !== 'joinedRtc') {
            participantState = 'joinedRtc'
            if (userId !== this.userId) this.groupCallHadRemoteJoined = true
          }
          break
        case 'userLeft':
          // userUnpublished 只代表停发媒体，不代表成员离开频道；不能据此自动结束通话。
          if (this.groupCallSession.markLeftRtc(userId) && previousState !== 'left') {
            participantState = 'left'
          }
          break
        case 'userAudioMuted':
          this.groupCallSession.markAudioMuted(userId, true)
          break
        case 'userAudioUnmuted':
          this.groupCallSession.markAudioMuted(userId, false)
          break
        case 'userVideoMuted':
          this.groupCallSession.markVideoOn(userId, false)
          break
        case 'userVideoUnmuted':
          this.groupCallSession.markVideoOn(userId, true)
          break
      }
      if (participantState && callSnapshot.status === CALL_STATUS.IN_CALL) {
        this.clearGroupParticipantTimeout(callSnapshot.callId, userId)
        this.emitEvent({
          type: 'participantStateChanged',
          payload: {
            callId: callSnapshot.callId,
            userId,
            state: participantState,
            groupId: groupSnapshot?.groupId,
          },
        } as CallKitEvent)
        if (participantState === 'left') {
          this.maybeAutoEndGroupCall(HANGUP_REASON.HANGUP)
        }
      }
    } else if (hasUid) {
      // 以前这里是静默丢弃：出现"成员离开但头像不消失"时完全无迹可查
      this.logger.warn('[CallKitCore] RTC 参与者事件缺少 userId，无法同步成员状态', {
        type,
        uid,
      })
    }

    // 网络质量/说话状态/错误等事件直接透传给上层
    if (
      type === 'networkQuality' ||
      type === 'speaking' ||
      type === 'stoppedSpeaking' ||
      type === 'error'
    ) {
      const rtcEvent: CallKitEvent = {
        type: 'rtcReport',
        payload: { type: report.type, payload: report.payload },
      }
      this.emitEvent(rtcEvent)
    }
  }

  // ───────────────────────────────────────────────
  // 状态查询
  // ───────────────────────────────────────────────

  getSingleCallState() {
    return this.singleCallState.getState()
  }

  getGroupCallSession() {
    return this.groupCallSession.getSnapshot()
  }

  /**
   * 获取群聊通话的所有参与者（包含状态信息）
   */
  getGroupCallParticipants() {
    return this.groupCallSession.getAllParticipants()
  }

  /**
   * 当前是否在通话中（IN_CALL 状态）
   */
  isInCall(): boolean {
    return this.singleCallState.isInCall()
  }

  /**
   * 当前是否处于可被接听的状态（被叫端弹窗显示区间）
   */
  isWaitingCalleeAction(): boolean {
    return this.singleCallState.isWaitingCalleeAction()
  }

  /**
   * 当前是否处于活跃通话中（已进入 RTC 或即将进入）
   */
  isInActiveCall(): boolean {
    return this.singleCallState.isInActiveCall()
  }

  /**
   * 当前是否可以接听（被叫端按钮可点击）
   */
  canAccept(): boolean {
    return this.singleCallState.canAccept()
  }

  /**
   * 当前是否可以拒绝（被叫端按钮可点击）
   */
  canReject(): boolean {
    return this.singleCallState.canReject()
  }

  /**
   * 当前是否可以挂断（主叫/被叫端的挂断按钮可点击）
   */
  canHangup(): boolean {
    return this.singleCallState.canHangup()
  }

  /**
   * 当前是否在呼叫/响铃中（INVITING 或 ALERTING 状态）
   */
  isCalling(): boolean {
    return this.singleCallState.isCalling()
  }

  /**
   * 获取当前通话类型，无通话时返回 null
   */
  getCurrentCallType(): CALL_TYPE | null {
    const state = this.singleCallState.getState()
    return state.status === CALL_STATUS.IDLE ? null : state.type
  }

  /**
   * 获取当前通话 ID，无通话时返回空字符串
   */
  getCurrentCallId(): string {
    return this.singleCallState.getState().callId || ''
  }

  /**
   * 当前是否空闲
   */
  isIdle(): boolean {
    return this.singleCallState.isIdle()
  }

  // ───────────────────────────────────────────────
  // 事件订阅（供上层精细控制）
  // ───────────────────────────────────────────────

  /**
   * 订阅通话事件
   * @returns 取消订阅函数
   */
  onEvent(handler: (event: CallKitEvent) => void): () => void {
    return this.eventBus.on('callKitEvent', handler)
  }

  /**
   * 订阅单次通话事件
   */
  onceEvent(handler: (event: CallKitEvent) => void): () => void {
    return this.eventBus.once('callKitEvent', handler)
  }

  // ───────────────────────────────────────────────
  // 生命周期
  // ───────────────────────────────────────────────

  async destroy(): Promise<void> {
    if (this.destroyed) return
    const shouldLeaveChannel = !this.singleCallState.isIdle() && !!this.config.rtcAdapter
    this.destroyed = true

    // Clear local resources synchronously before awaiting external RTC teardown.
    this.clearInviteTimeout()
    this.clearConfirmCalleeTimeout()
    this.clearGroupParticipantTimeouts()
    this.groupCallHadRemoteJoined = false
    this.pendingIncomingInvites.clear()
    this.rtcCredentials.clear()
    this.recentlyCanceledCalls.clear()
    this.rtcUidToUserId.clear()
    this.stopDurationTimer()
    this.imListener.unmount()
    this.eventBus.clear()
    this.singleCallState.reset()
    this.groupCallSession.destroy()

    if (shouldLeaveChannel) {
      try {
        await this.config.rtcAdapter!.leaveChannel()
      } catch (err) {
        this.logger.warn('[CallKitCore] RTC leave failed during destroy; local resources are already cleared', err)
      }
    }

    this.logger.info('[CallKitCore] 已销毁')
  }

  // ───────────────────────────────────────────────
  // 内部：消息处理
  // ───────────────────────────────────────────────

  private isSelfMessage(msg: any): boolean {
    return msg.from === this.userId
  }

  private async handleTextMessage(msg: any): Promise<void> {
    if (this.destroyed) return
    // 无条件日志：所有文本消息都记录，方便排查消息是否到达 core
    const rawExt = msg.ext as any
    const bodyExt = msg.body?.ext as any
    const ext = rawExt || bodyExt
    this.logger.warn('✉️ [CallKitCore] handleTextMessage 被调用', {
      from: msg.from,
      to: msg.to,
      msgType: msg.type,
      chatType: msg.chatType,
      hasRawExt: !!rawExt,
      hasBodyExt: !!bodyExt,
      extAction: ext?.action,
      extCallId: ext?.callId,
      self: this.isSelfMessage(msg),
    })

    if (this.isSelfMessage(msg)) {
      this.logger.warn('[CallKitCore] ❌ 忽略自己发送的文本消息')
      return
    }

    if (!ext || ext.action !== 'invite') {
      this.logger.warn('[CallKitCore] ❌ 忽略非 invite 文本消息 | ext.action=', ext?.action)
      return
    }

    // iOS 使用顶层 groupId/receiverList；先归一化，后续所有群聊分支共用同一份语义。
    const groupId = (ext.callkitGroupInfo?.groupId || ext.groupId || '') as string
    const invitedMembers: string[] = ext.invitedMembers || ext.receiverList || []
    const isGroupCall = !!(
      ext.chatType === CALL_TYPE.VIDEO_MULTI ||
      ext.chatType === CALL_TYPE.AUDIO_MULTI ||
      groupId
    )

    // ========= Critical #2: 忙线自动拒绝 =========
    const currentStatus = this.singleCallState.getState().status
    if (currentStatus > CALL_STATUS.IDLE) {
      // 同 callId 的重复/重发 invite（IM 重投、群聊"添加成员"重复邀请在聊成员）：
      // 不是新呼叫，直接忽略。若回 busy，主叫侧会把仍在通话中的成员标记离开并移除。
      const currentCallId = this.singleCallState.getState().callId
      if (ext.callId && ext.callId === currentCallId) {
        this.logger.warn('[CallKitCore] 同 callId 重复 invite，忽略 | callId=', ext.callId)
        return
      }
      this.logger.warn('[CallKitCore] ❌ 当前已在通话中，发送忙线拒绝 | currentStatus=', currentStatus)
      this.sendBusyReject(msg.from as string, ext.callId as string, ext.callerDevId as string)
      return
    }

    // ========= Critical #3: 接收者校验 =========
    if (!isGroupCall) {
      // 单聊：检查消息是否发给当前用户
      if (msg.to && msg.to !== this.userId) {
        this.logger.warn('[CallKitCore] ❌ 单聊 invite 接收者不是当前用户 | msg.to=', msg.to)
        return
      }
      // 单聊：设备 ID 校验
      if (ext.calleeDevId && ext.calleeDevId !== this.deviceId) {
        this.logger.warn('[CallKitCore] ❌ 单聊 invite calleeDevId 不匹配 | ext=', ext.calleeDevId, '| my=', this.deviceId)
        return
      }
    } else {
      // 群聊：检查当前用户是否在被邀请列表中（含 iOS receiverList）
      if (invitedMembers.length > 0 && !invitedMembers.includes(this.userId)) {
        this.logger.warn('[CallKitCore] ❌ 群聊 invite 当前用户不在被邀请列表中')
        return
      }
    }

    // ========= Critical #3: 过期检查 =========
    const msgTime = msg.time || ext.ts
    if (msgTime && isMessageExpired(msgTime, this.inviteTimeoutMs + 10000)) {
      this.logger.warn('[CallKitCore] ❌ invite 消息已过期 | msgTime=', msgTime)
      return
    }

    // ========= 已取消呼叫拦截（离线补投乱序防护）=========
    // cancelCall 先于 invite 到达时状态机 IDLE 会丢弃 cancel，此处用名单兜底
    if (ext.callId && this.isCallRecentlyCanceled(ext.callId as string)) {
      this.logger.warn('[CallKitCore] ❌ invite 对应的呼叫已被取消（cancelCall 先到），丢弃 | callId=', ext.callId)
      return
    }

    this.logger.warn(
      isGroupCall
        ? '✉️ [CallKitCore] ✅ 【群聊】确认收到 invite 文本消息 → 进入群聊处理分支'
        : '✉️ [CallKitCore] ✅ 【单聊】确认收到 invite 文本消息 → 进入单聊处理分支',
      { from: msg.from, callId: ext.callId, channel: ext.channelName, type: ext.type }
    )

    if (isGroupCall) {
      const normalizedExt = {
        ...ext,
        groupId,
        invitedMembers,
        callkitGroupInfo: {
          ...ext.callkitGroupInfo,
          groupId,
        },
      }
      // 群聊 invite：异步获取 token 并初始化
      await this.handleGroupCallInvite(msg, normalizedExt).catch((err) => {
        this.emitError('groupCallInviteHandlingFailed', err, { messageId: msg.id })
        this.logger.error('[CallKitCore] 群聊 invite 处理失败', err)
      })
    } else {
      // 单聊 invite
      await this.handleSingleCallInvite(msg, ext)
    }
  }

  private async handleGroupCallInvite(msg: any, ext: any): Promise<void> {
    // 群聊 invite：同时初始化 singleCallState（被叫方需要它来处理 confirmCallee / cancelCall / leaveCall）
    const callId = ext.callId as string
    const channel = ext.channelName as string
    const callType = ext.type as CALL_TYPE
    const callerDevId = ext.callerDevId as string
    const callerUserId = (ext.callerIMName as string) || (msg.from as string) || ''
    const groupId = (ext.callkitGroupInfo?.groupId || ext.groupId || '') as string
    const invitedMembers: string[] = ext.invitedMembers || ext.receiverList || []

    // Deduplicate while the first invite owns this call's abort record.
    if (this.pendingIncomingInvites.has(callId)) return
    const pending = { aborted: false }
    this.pendingIncomingInvites.set(callId, pending)

    let rtc: { token: string; appId: string; uid: number }
    try {
      rtc = await this.fetchRtcToken(channel)
    } finally {
      if (this.pendingIncomingInvites.get(callId) === pending) {
        this.pendingIncomingInvites.delete(callId)
      }
    }

    if (this.destroyed) return
    if (pending.aborted || this.isCallRecentlyCanceled(callId)) {
      this.logger.warn('[CallKitCore] Group invite was canceled while fetching its token; skipping initialization')
      return
    }

    const currentState = this.singleCallState.getState()
    if (currentState.status === CALL_STATUS.IDLE) {
      this.logger.warn('🔄 [CallKitCore] 群聊被叫方：singleCallState 从 IDLE → ALERTING')
      const stateResult = this.singleCallState.initIncoming({
        callId,
        channel,
        token: rtc.token,
        callType,
        callerDevId,
        callerUserId,
        calleeDevId: this.deviceId,
        calleeUserId: groupId,
        inviteTs: (ext.ts as number) || 0,
      })
      this.rtcCredentials.set(callId, rtc)
      this.processEvents(stateResult.events, this.singleCallState.getState())
      this.startInviteTimeout()
    } else {
      // 同 callId 的重复请求已完成初始化；其他呼叫占用时才回 busy。
      if (currentState.callId === callId) return
      this.logger.warn(
        '[CallKitCore] ⚠️ 群聊被叫方：singleCallState 不是 IDLE，回 busy 并放弃本次 invite | 当前状态=',
        currentState.status
      )
      this.sendBusyReject(msg.from as string, callId, callerDevId)
      return
    }

    const events = this.groupCallHandler.handleInviteTextMessage(msg)
    this.logger.warn('[CallKitCore] 群聊 invite 处理后事件:', events.map((e: any) => e.type))
    this.processEvents(events, this.singleCallState.getState())

    // 发出 incomingCall 事件（与单聊行为保持一致，确保 UI 层能弹出待接听状态栏）
    const incomingEvent: CallKitEvent = {
      type: 'incomingCall',
      payload: {
        callId,
        callType,
        callerUserId,
        callerDevId,
        channel,
        calleeUserId: groupId,
        token: rtc.token,
        appId: rtc.appId || undefined,
        uid: rtc.uid || undefined,
        callerInfo: ext.ease_chat_uikit_user_info,
        groupId,
        groupName: ext.callkitGroupInfo?.groupName,
        invitedMembers,
      },
    }
    this.logger.warn('[CallKitCore] 即将发出 incomingCall 事件:', { callId, callerUserId, callType })
    this.emitEvent(incomingEvent)
    this.logger.warn('[CallKitCore] incomingCall 事件已发出')

    // 被叫方收到 invite 后回发 alert CMD（与旧版 useListenerManager 对齐）
    this.sendAlertSignal(msg.from as string, ext.callId as string, ext.callerDevId as string)
  }

  private async handleSingleCallInvite(msg: any, ext: any): Promise<void> {
    const callId = ext.callId as string
    const channel = ext.channelName as string
    const callType = ext.type as CALL_TYPE
    const callerDevId = ext.callerDevId as string
    const callerUserId = (ext.callerIMName as string) || (msg.from as string) || ''
    const calleeUserId = (ext.calleeIMName as string) || (msg.to as string) || ''

    this.logger.debug('[CallKitCore] handleSingleCallInvite', {
      from: msg.from,
      callerIMName: ext.callerIMName,
      calleeIMName: ext.calleeIMName,
      resolvedCallerId: callerUserId,
      resolvedCalleeId: calleeUserId,
    })

    // Deduplicate while the first invite owns this call's abort record.
    if (this.pendingIncomingInvites.has(callId)) return
    const pending = { aborted: false }
    this.pendingIncomingInvites.set(callId, pending)

    let rtc: { token: string; appId: string; uid: number }
    try {
      rtc = await this.fetchRtcToken(channel)
    } finally {
      if (this.pendingIncomingInvites.get(callId) === pending) {
        this.pendingIncomingInvites.delete(callId)
      }
    }

    if (this.destroyed) return
    if (pending.aborted) {
      this.logger.warn('[CallKitCore] Single invite was canceled while fetching its token; skipping initialization')
      return
    }

    if (this.isCallRecentlyCanceled(callId)) {
      this.logger.warn('[CallKitCore] 单聊 invite 命中已取消名单（token 窗口后复查），跳过初始化 | callId=', callId)
      return
    }

    const currentState = this.singleCallState.getState()
    if (currentState.status !== CALL_STATUS.IDLE) {
      // 同 callId 的重复请求不应对已建立的来电回 busy。
      if (currentState.callId === callId) return
      this.logger.warn('[CallKitCore] 获取 token 期间状态机已被其他呼叫占用，回 busy | callId=', callId)
      this.sendBusyReject(msg.from as string, callId, callerDevId)
      return
    }

    const stateResult = this.singleCallState.initIncoming({
      callId,
      channel,
      token: rtc.token,
      callType,
      callerDevId,
      callerUserId,
      calleeDevId: this.deviceId,
      calleeUserId,
      inviteTs: (ext.ts as number) || 0,
    })
    this.rtcCredentials.set(callId, rtc)

    // 启动超时定时器
    this.startInviteTimeout()

    // 发出 incomingCall 事件
    const incomingEvent: CallKitEvent = {
      type: 'incomingCall',
      payload: {
        callId,
        callType,
        callerUserId,
        callerDevId,
        channel,
        calleeUserId,
        token: rtc.token,
        appId: rtc.appId || undefined,
        uid: rtc.uid || undefined,
        callerInfo: ext.ease_chat_uikit_user_info,
      },
    }
    this.emitEvent(incomingEvent)

    // 处理状态机返回的事件（STATUS_CHANGED）
    this.processEvents(stateResult.events, this.singleCallState.getState())

    // 被叫方收到 invite 后回发 alert CMD（与旧版 useListenerManager 对齐）
    this.sendAlertSignal(msg.from as string, callId, callerDevId)
  }

  /**
   * 发送忙线拒绝（answerCall result=busy），在线直投
   */
  private sendBusyReject(to: string, callId: string, callerDevId: string): void {
    if (this.destroyed) return
    const busyExt = MessageBuilder.buildCmdExt({
      action: 'answerCall',
      callId,
      callerDevId,
      calleeDevId: this.deviceId,
      result: 'busy',
    })
    this.signalSender
      .sendCmdMessage(to, 'singleChat', busyExt as any, {
        deliverOnlineOnly: true,
      })
      .catch((e) => {
        this.logger.warn('[CallKitCore] 忙线拒绝发送失败:', e)
      })
  }

  /**
   * 发送 alert CMD 信令给主叫方
   */
  private sendAlertSignal(to: string, callId: string, callerDevId: string): void {
    if (this.destroyed) return
    const alertExt = MessageBuilder.buildCmdExt({
      action: 'alert',
      callId,
      callerDevId,
      calleeDevId: this.deviceId,
    })
    this.signalSender
      .sendCmdMessage(to, 'singleChat', alertExt as any, { deliverOnlineOnly: true })
      .catch((e) => {
        // alert 发送失败时主叫永远不知道被叫已响铃，必须留痕
        this.logger.warn('[CallKitCore] alert 发送失败:', { to, callId, err: e })
      })
  }

  private handleCmdMessage(msg: any): void {
    if (this.destroyed) return
    // 无条件日志：所有 CMD 消息都记录
    this.logger.warn('📨 [CallKitCore] handleCmdMessage 被调用', {
      from: msg.from,
      to: msg.to,
      action: msg.action,
      extAction: msg.ext?.action,
      callId: msg.ext?.callId,
      self: this.isSelfMessage(msg),
    })

    if (this.isSelfMessage(msg)) {
      this.logger.warn('[CallKitCore] ❌ 忽略自己发送的 CMD 消息')
      return
    }

    // ========= Critical #3: CMD 过滤 — 只处理 rtcCall 类型 =========
    if (msg.action !== 'rtcCall') {
      this.logger.warn('[CallKitCore] ❌ 忽略非 rtcCall CMD 消息 | action=', msg.action)
      return
    }

    // ========= Critical #3: CMD 过期检查 =========
    const cmdTime = msg.time || msg.ext?.ts
    if (cmdTime && isCmdMessageExpired(cmdTime)) {
      this.logger.warn('[CallKitCore] ❌ CMD 消息已过期 | cmdTime=', cmdTime)
      return
    }

    // ========= 记录已取消的 callId（离线补投乱序防护）=========
    // cancelCall 无论是否被状态机消费都记录：离线补投时 cancel 可能先于 invite 到达，
    // 此时状态机 IDLE 会将其丢弃，必须留痕供后续迟到的 invite 命中拦截。
    const extAction = msg.ext?.action
    const extCallId = msg.ext?.callId
    if (extAction === 'cancelCall' && extCallId) {
      this.markCallCanceled(extCallId)
    }

    // ========= 待处理 invite 的取消/离开拦截 =========
    // 群聊被叫方在 fetchRtcToken 期间 singleCallState 仍为 IDLE，SignalRouter 会忽略 cancelCall/leaveCall。
    // 此处提前拦截并标记为 aborted，避免 token 返回后仍弹出已取消的邀请。
    if (
      extCallId &&
      (extAction === 'cancelCall' || extAction === 'leaveCall') &&
      this.pendingIncomingInvites.has(extCallId)
    ) {
      this.logger.warn('[CallKitCore] 待处理 invite 收到取消/离开信令，标记为 aborted', {
        callId: extCallId,
        action: extAction,
      })
      this.pendingIncomingInvites.get(extCallId)!.aborted = true
      return
    }

    // 快照必须在 dispatch 之前取：cancel/leave/refuse/timeout 分支会先 resetCore() 再返回事件，
    // 用重置后的状态映射事件会让 callEnded 的 channel/callType/calleeUserId 全部丢失。
    const snapshotBeforeDispatch = this.singleCallState.getState()
    const events = this.signalRouter.dispatch(msg)
    // Only a confirm consumed by the handler may cancel the fallback timeout.
    if (
      extAction === 'confirmCallee' &&
      this.isCurrentCall(extCallId) &&
      events.some((event) => event.callId === extCallId && (
        event.type === 'CALL_ACCEPTED' || event.type === 'CALL_CONNECTED' || event.type === 'SHOULD_JOIN_RTC'
      ))
    ) {
      this.clearConfirmCalleeTimeout()
    }
    if (events.length > 0) {
      this.logger.warn('📨 [CallKitCore] ✅ CMD 消息处理后产生事件:', events.map((e) => e.type))
      this.processEvents(events, snapshotBeforeDispatch)
    } else {
      this.logger.warn('📨 [CallKitCore] ⚠️ CMD 消息未产生任何事件（可能被忽略或 handler 返回空）')
    }
  }

  // ───────────────────────────────────────────────
  // 内部：事件处理与映射
  // ───────────────────────────────────────────────

  private processEvents(events: DomainEvent[], snapshot: SingleCallState): void {
    if (this.destroyed) return
    events.forEach((event) => {
      // RTCUId 缺失时拿不到 Agora 签发的数值 uid，回退字符串 userId 必然 join 失败。
      if (event.type === 'SHOULD_JOIN_RTC' && !this.rtcCredentials.get(event.callId)?.uid) {
        this.emitError(
          'rtcUidMissing',
          new Error('getRTCToken 未返回数值型 RTCUId，无法加入 RTC 频道'),
          { callId: event.callId, channel: event.channel }
        )
        return
      }

      if (event.type === 'GROUP_CALL_INIT') {
        this.scheduleGroupParticipantTimeouts(event.callId, event.invitedMembers)
      }
      if (event.type === 'PARTICIPANT_STATE_CHANGED' && event.state !== 'invited') {
        this.clearGroupParticipantTimeout(event.callId, event.userId)
      }
      if (event.type === 'PARTICIPANT_JOINED' || event.type === 'PARTICIPANT_LEFT') {
        this.clearGroupParticipantTimeout(event.callId, event.userId)
      }

      const callKitEvents = this.mapDomainEvents(event, snapshot)
      callKitEvents.forEach((callKitEvent) => {
        this.emitEvent(callKitEvent)
        this.handleRtcEvent(callKitEvent)

        // 通话开始/连接时启动时长计时器；通话结束时停止
        if (callKitEvent.type === 'callStarted' || callKitEvent.type === 'callConnected') {
          this.startDurationTimer(
            callKitEvent.payload.callId,
            callKitEvent.payload.channel,
            callKitEvent.payload.callType,
            callKitEvent.payload.callerUserId
          )
        }
        if (callKitEvent.type === 'callEnded') {
          this.stopDurationTimer()
          // 通话已结束，遗留的邀请/确认定时器必须立即作废，否则会在下一通里误触发
          this.clearInviteTimeout()
          this.clearConfirmCalleeTimeout()
          this.clearGroupParticipantTimeouts()
          this.groupCallHadRemoteJoined = false
          // 群会话不收敛会让 getGroupCallSession() 在挂断后仍返回 status:'inCall'
          this.groupCallSession.end()
        }
      })
      if (event.type === 'CALL_ENDED') {
        this.rtcCredentials.delete(event.callId)
      }

      // 群聊成员全部拒绝/超时，或最后一名远端离开后，本地自动退出。
      const autoEndReason =
        event.type === 'PARTICIPANT_LEFT' && event.reason === 'timeout'
          ? HANGUP_REASON.NO_RESPONSE
          : event.type === 'PARTICIPANT_LEFT' && (event.reason === 'refused' || event.reason === 'busy')
            ? HANGUP_REASON.REFUSE
            : HANGUP_REASON.HANGUP
      this.maybeAutoEndGroupCall(autoEndReason)
    })
  }

  /**
   * 当配置了 rtcAdapter 时，自动处理 RTC 相关事件
   */
  private handleRtcEvent(event: CallKitEvent): void {
    const adapter = this.config.rtcAdapter
    if (!adapter) return

    switch (event.type) {
      case 'shouldJoinRtc': {
        const p = event.payload
        adapter
          .joinChannel({
            channel: p.channel,
            token: p.token,
            uid: p.uid,
            appId: p.appId,
          })
          .catch((e) => {
            // 快速挂断/重呼导致 join 被代际守卫取消属于正常流程，不应上报为通话错误
            if (this.isRtcCancelled(e)) {
              this.logger.debug('[CallKitCore] rtcAdapter.joinChannel 已取消（通话代际变化）', {
                channel: p.channel,
              })
              return
            }
            this.emitError('rtcJoinChannelFailed', e, { channel: p.channel, uid: p.uid })
            this.logger.error('[CallKitCore] rtcAdapter.joinChannel 失败:', e)
          })
        break
      }

      case 'shouldLeaveRtc': {
        adapter.leaveChannel().catch((e) => {
          if (this.isRtcCancelled(e)) {
            this.logger.debug('[CallKitCore] rtcAdapter.leaveChannel 已取消（通话代际变化）')
            return
          }
          this.emitError('rtcLeaveChannelFailed', e, { channel: event.payload.channel })
        })
        break
      }

      case 'shouldPublishTracks': {
        const p = event.payload
        adapter
          .publishLocalTracks(p.trackTypes)
          .catch((e) => {
            if (this.isRtcCancelled(e)) return
            this.emitError('rtcPublishTracksFailed', e, { channel: p.channel, trackTypes: p.trackTypes })
            this.logger.error('[CallKitCore] rtcAdapter.publishLocalTracks 失败:', e)
          })
        break
      }

      case 'localAudioChanged': {
        adapter
          .setAudioEnabled(event.payload.enabled)
          .catch((e) => {
            // 通话已结束时媒体开关失败无意义，回滚反而会给已结束的通话发事件
            if (this.isRtcCancelled(e)) return
            this.emitError('rtcSetAudioEnabledFailed', e, { enabled: event.payload.enabled })
            this.logger.error('[CallKitCore] rtcAdapter.setAudioEnabled 失败，回滚状态机:', e)
            this.rollbackLocalMedia('audio', !event.payload.enabled)
          })
        break
      }

      case 'localVideoChanged': {
        adapter
          .setVideoEnabled(event.payload.enabled)
          .catch((e) => {
            if (this.isRtcCancelled(e)) return
            this.emitError('rtcSetVideoEnabledFailed', e, { enabled: event.payload.enabled })
            this.logger.error('[CallKitCore] rtcAdapter.setVideoEnabled 失败，回滚状态机:', e)
            this.rollbackLocalMedia('video', !event.payload.enabled)
          })
        break
      }
    }
  }

  /** RTC 适配器在代际变化（挂断/重呼）时抛出的取消错误，属于正常控制流 */
  private isRtcCancelled(error: unknown): boolean {
    return (error as { name?: string } | null)?.name === 'CallKitRtcCancelledError'
  }

  /**
   * RTC 媒体开关操作失败后的状态回滚
   * 直接改状态机（不产生 LOCAL_*_CHANGED 域事件，避免再次触发 adapter 形成循环），
   * 仅向 UI 层广播回滚后的状态，保持 core 状态机与真实 RTC 状态一致（单一事实源）。
   */
  private rollbackLocalMedia(kind: 'audio' | 'video', enabled: boolean): void {
    this.singleCallState.setMediaEnabled(kind, enabled)
    this.emitEvent({
      type: kind === 'audio' ? 'localAudioChanged' : 'localVideoChanged',
      payload: { enabled },
    } as CallKitEvent)
  }

  private mapDomainEvents(event: DomainEvent, snapshot: SingleCallState): CallKitEvent[] {
    const base = {
      callId: event.callId,
      channel: snapshot.channel,
      callType: snapshot.type,
      callerUserId: snapshot.callerUserId,
      calleeUserId: snapshot.calleeUserId,
    }

    const isGroupCall = snapshot.type === CALL_TYPE.VIDEO_MULTI || snapshot.type === CALL_TYPE.AUDIO_MULTI

    switch (event.type) {
      case 'STATUS_CHANGED': {
        return [
          {
            type: 'statusChanged',
            payload: {
              ...base,
              from: String(event.from),
              to: String(event.to),
            },
          },
        ]
      }

      case 'CALL_INVITED': {
        const common = { ...base, isCaller: event.isCaller }
        return [
          { type: 'callInvited', payload: common },
          { type: isGroupCall ? 'groupCallInvited' : 'singleCallInvited', payload: common },
        ]
      }

      case 'CALL_STARTED': {
        const common = {
          ...base,
          isCaller: event.isCaller,
          startTime: Date.now(),
        }
        return [
          { type: 'callStarted', payload: common },
          { type: isGroupCall ? 'groupCallStarted' : 'singleCallStarted', payload: common },
        ]
      }

      case 'CALL_ACCEPTED': {
        const common = { ...base, isCaller: event.isCaller, calleeInfo: event.calleeInfo }
        return [
          { type: 'callAccepted', payload: common },
          { type: isGroupCall ? 'groupCallAccepted' : 'singleCallAccepted', payload: common },
        ]
      }

      case 'CALL_CONNECTED': {
        return [
          { type: 'callConnected', payload: base },
          { type: isGroupCall ? 'groupCallConnected' : 'singleCallConnected', payload: base },
        ]
      }

      case 'CALL_ENDED': {
        const common = {
          ...base,
          reason: event.reason as HangupReason,
          duration: event.duration,
        }
        return [
          { type: 'callEnded', payload: common },
          { type: isGroupCall ? 'groupCallEnded' : 'singleCallEnded', payload: common },
          // 所有结束路径（挂断/取消/拒接/忙线/超时）都会产生 CALL_ENDED，
          // 这是唯一能让上层退出 RTC 频道的机会：不发该指令，Agora 会一直占用摄像头与麦克风。
          { type: 'shouldLeaveRtc', payload: { ...base, reason: event.reason } },
        ]
      }

      case 'CALL_TIMEOUT': {
        return [
          { type: 'callTimeout', payload: base },
          { type: isGroupCall ? 'groupCallTimeout' : 'singleCallTimeout', payload: base },
        ]
      }

      case 'CALL_REFUSED': {
        const common = { ...base, isRemote: event.isRemote }
        return [
          { type: 'callRefused', payload: common },
          { type: isGroupCall ? 'groupCallRefused' : 'singleCallRefused', payload: common },
        ]
      }

      case 'CALL_BUSY': {
        return [
          { type: 'callBusy', payload: base },
          { type: isGroupCall ? 'groupCallBusy' : 'singleCallBusy', payload: base },
        ]
      }

      case 'CALL_CANCELED': {
        const common = { ...base, isRemote: event.isRemote }
        return [
          { type: 'callCanceled', payload: common },
          { type: isGroupCall ? 'groupCallCanceled' : 'singleCallCanceled', payload: common },
        ]
      }

      case 'SHOULD_JOIN_RTC': {
        const rtc = this.rtcCredentials.get(event.callId)
        return [
          {
            type: 'shouldJoinRtc',
            payload: {
              ...base,
              token: event.token,
              // processEvents 已保证当前 callId 的 RTCUId 非 0。
              uid: rtc?.uid || 0,
              appId: rtc?.appId || undefined,
              role: event.role,
            },
          },
          {
            // 必须排在 shouldJoinRtc 之后：适配器的命令队列按顺序执行，
            // 先入房再发布轨道，否则 publishLocalTracks 会因"尚未加入频道"报错
            type: 'shouldPublishTracks',
            payload: {
              ...base,
              trackTypes:
                event.callType === CALL_TYPE.VIDEO_1V1 || event.callType === CALL_TYPE.VIDEO_MULTI
                  ? (['audio', 'video'] as ('audio' | 'video')[])
                  : (['audio'] as ('audio' | 'video')[]),
            },
          },
        ]
      }

      case 'GROUP_CALL_INIT': {
        return [
          {
            type: 'groupCallInit',
            payload: {
              callId: event.callId,
              groupId: event.groupId,
              groupName: event.groupName,
              channel: event.channel,
              callType: event.callType,
              callerUserId: event.callerUserId,
              invitedMembers: event.invitedMembers,
            },
          },
        ]
      }

      case 'PARTICIPANT_STATE_CHANGED': {
        return [
          {
            type: 'participantStateChanged',
            payload: {
              callId: event.callId,
              userId: event.userId,
              state: event.state,
              groupId: event.groupId,
            },
          },
        ]
      }

      case 'PARTICIPANT_JOINED': {
        return [
          {
            type: 'participantJoined',
            payload: {
              ...base,
              userId: event.userId,
              groupId: event.groupId,
            },
          },
        ]
      }

      case 'PARTICIPANT_LEFT': {
        return [
          {
            type: 'participantLeft',
            payload: {
              ...base,
              userId: event.userId,
              reason: event.reason,
              groupId: event.groupId,
            },
          },
        ]
      }

      case 'LOCAL_AUDIO_CHANGED': {
        return [{ type: 'localAudioChanged', payload: { enabled: event.enabled } }]
      }

      case 'LOCAL_VIDEO_CHANGED': {
        return [{ type: 'localVideoChanged', payload: { enabled: event.enabled } }]
      }

      default:
        return []
    }
  }

  private emitEvent(event: CallKitEvent): void {
    if (this.destroyed) return
    this.logger.debug('[CallKitCore] emitEvent:', event.type, '| onEvent存在=', !!this.config.onEvent, '| onUIEvent存在=', !!this.config.onUIEvent)

    // 重复订阅检测：如果同时使用了 config.onEvent 和 core.onEvent()，发出警告
    const hasEventBusListeners = this.eventBus.listenerCount('callKitEvent') > 0
    const hasLegacyOnEvent = !!this.config.onEvent
    if (hasEventBusListeners && hasLegacyOnEvent) {
      this.logger.warn(
        '[CallKitCore] 同时使用了 config.onEvent 和 core.onEvent() 订阅，事件可能重复触发。' +
          '建议只使用其中一种订阅方式。'
      )
    }

    // 1. 通过 EventBus 分发（供上层 onEvent/offEvent 使用）
    this.eventBus.emit('callKitEvent', event)

    // 2. 兼容旧接口：onEvent 接收所有事件
    if (this.config.onEvent) {
      try {
        this.config.onEvent(event)
        this.logger.debug('[CallKitCore] onEvent 回调执行成功:', event.type)
      } catch (err) {
        this.logger.error('[CallKitCore] onEvent 回调执行失败:', err)
      }
    }

    // 3. 按来源分发到新接口
    if (isUIEvent(event) && this.config.onUIEvent) {
      try {
        this.config.onUIEvent(event)
        this.logger.debug('[CallKitCore] onUIEvent 回调执行成功:', event.type)
      } catch (err) {
        this.logger.error('[CallKitCore] onUIEvent 回调执行失败:', err)
      }
    }

    if (isRtcEvent(event) && this.config.onRtcEvent) {
      try {
        this.config.onRtcEvent(event)
      } catch (err) {
        this.logger.error('[CallKitCore] onRtcEvent 回调执行失败:', err)
      }
    }
  }

  private emitError(type: string, error: unknown, context?: Record<string, any>): void {
    const errMsg = error instanceof Error ? error.message : String(error)
    this.logger.error(`[CallKitCore] ${type}:`, error)
    this.emitEvent({
      type: 'callError',
      payload: {
        type,
        error: errMsg,
        callId: context?.callId,
        context,
      },
    })
  }

  private startDurationTimer(callId: string, channel: string, callType: CALL_TYPE, callerUserId: string): void {
    if (this.durationTimer) {
      clearInterval(this.durationTimer)
    }
    this.durationSeconds = 0
    this.durationCallInfo = { callId, channel, callType, callerUserId }
    this.durationTimer = setInterval(() => {
      if (!this.durationCallInfo) return
      // 自增计数，避免 Date.now() 累积误差
      this.durationSeconds++
      const duration = this.durationSeconds * 1000
      this.emitEvent({
        type: 'callDurationUpdated',
        payload: {
          callId: this.durationCallInfo.callId,
          channel: this.durationCallInfo.channel,
          callType: this.durationCallInfo.callType,
          callerUserId: this.durationCallInfo.callerUserId,
          duration,
        },
      })
    }, 1000)
  }

  private stopDurationTimer(): void {
    if (this.durationTimer) {
      clearInterval(this.durationTimer)
      this.durationTimer = null
    }
    this.durationSeconds = 0
    this.durationCallInfo = null
  }

  // ───────────────────────────────────────────────
  // 内部：IM 连接状态管理
  // ───────────────────────────────────────────────

  private handleIMConnected(): void {
    this.logger.info('[CallKitCore] IM 已重新连接')
    // IM 重连后无需 remount：环信 IM SDK 的 addEventHandler 是持久注册的，
    // 断连不会清除 handler，重连后消息回调自动恢复。此处仅记录日志。
    if (!this.destroyed && this.imListener) {
      this.logger.info('[CallKitCore] IM 重连恢复：监听状态正常')
    }
  }

  private handleIMDisconnected(): void {
    this.logger.warn('[CallKitCore] IM 已断开连接')
    // IM 断开后，通话状态保持不变，等待重连或超时
    // 如果通话正在进行，由 RTC 层维持音视频，信令暂时中断
  }

  // ───────────────────────────────────────────────
  // 内部：超时定时器管理（Critical #1）
  // ───────────────────────────────────────────────

  private groupParticipantTimerKey(callId: string, userId: string): string {
    return `${callId}:${userId}`
  }

  /** 每个被邀请成员单独计时；超时只移除该成员的占位，不打断已接听的通话。 */
  private scheduleGroupParticipantTimeouts(callId: string, userIds: readonly string[]): void {
    if (this.destroyed || !callId) return
    userIds.forEach((userId) => {
      if (!userId || userId === this.userId) return
      this.clearGroupParticipantTimeout(callId, userId)
      const key = this.groupParticipantTimerKey(callId, userId)
      const timer = setTimeout(() => {
        this.groupParticipantTimers.delete(key)
        if (!this.isCurrentCall(callId)) return
        const participant = this.groupCallSession.getParticipant(userId)
        if (!participant || participant.state !== 'invited') return
        const snapshot = this.singleCallState.getState()
        const groupId = this.groupCallSession.getSnapshot()?.groupId
        this.logger.info('[CallKitCore] 群聊成员邀请超时，移除占位', { callId, userId, groupId })
        this.groupCallSession.removeParticipant(userId)
        this.processEvents(
          [
            {
              type: 'PARTICIPANT_LEFT',
              callId,
              userId,
              channel: snapshot.channel,
              callType: snapshot.type,
              reason: 'timeout',
              groupId,
            },
          ],
          snapshot
        )
      }, this.inviteTimeoutMs)
      this.groupParticipantTimers.set(key, timer)
    })
  }

  private clearGroupParticipantTimeout(callId: string, userId: string): void {
    const key = this.groupParticipantTimerKey(callId, userId)
    const timer = this.groupParticipantTimers.get(key)
    if (!timer) return
    clearTimeout(timer)
    this.groupParticipantTimers.delete(key)
  }

  private clearGroupParticipantTimeouts(): void {
    this.groupParticipantTimers.forEach((timer) => clearTimeout(timer))
    this.groupParticipantTimers.clear()
  }

  /**
   * 群聊收敛：
   * - 所有被邀请人已拒绝/超时 → 发起方自动结束；
   * - 通话中最后一名远端离开 → 本地自动退出；
   * - 仍有 invited/accepted/joinedRtc 的远端时不处理。
   */
  private maybeAutoEndGroupCall(reason: HangupReason): void {
    if (this.destroyed || this.autoEndingGroupCall) return
    const state = this.singleCallState.getState()
    if (state.status !== CALL_STATUS.IN_CALL) return
    if (state.type !== CALL_TYPE.VIDEO_MULTI && state.type !== CALL_TYPE.AUDIO_MULTI) return
    const session = this.groupCallSession.getSnapshot()
    if (!session || session.status === 'ended') return

    const remoteParticipants = this.groupCallSession
      .getAllParticipants()
      .filter((participant) => participant.userId !== this.userId && participant.state !== 'left')
    const hasRemoteParticipant = remoteParticipants.length > 0
    // 已经有人入过房后，只要房间里不再有其他 joinedRtc 成员就退出；
    // 仍在等待的 invited 不应把最后一个人困在空房间里。
    const hasRemoteInRoom = remoteParticipants.some((participant) => participant.state === 'joinedRtc')
    if (this.groupCallHadRemoteJoined && !hasRemoteInRoom) {
      // 继续走结束流程
    } else if (hasRemoteParticipant) {
      return
    }

    this.autoEndingGroupCall = true
    try {
      this.logger.info('[CallKitCore] 群聊仅剩本地用户，自动结束', {
        callId: state.callId,
        reason,
      })
      const result = this.singleCallState.hangup(reason)
      if (result.ok) {
        this.processEvents(result.events, state)
      }
    } finally {
      this.autoEndingGroupCall = false
    }
  }

  private isCurrentCall(callId: string): boolean {
    return !this.destroyed && !!callId && this.singleCallState.getState().callId === callId
  }

  /** 启动邀请超时；回调按 callId 校验，旧定时器不能影响后续呼叫。 */
  private startInviteTimeout(): void {
    if (this.destroyed) return
    this.clearInviteTimeout()
    this.clearConfirmCalleeTimeout()
    const callId = this.singleCallState.getState().callId
    if (!callId) return

    this.inviteTimer = setTimeout(() => {
      this.inviteTimer = null
      if (!this.isCurrentCall(callId)) return
      const snapshot = this.singleCallState.getState()
      if (snapshot.status === CALL_STATUS.IDLE || snapshot.status === CALL_STATUS.IN_CALL) return

      this.notifyTimeoutPeer(snapshot, 'invite')
      const result = this.singleCallState.timeout()
      if (result.ok) {
        this.processEvents(result.events, snapshot)
      }
    }, this.inviteTimeoutMs)
  }

  private clearInviteTimeout(): void {
    if (this.inviteTimer) {
      clearTimeout(this.inviteTimer)
      this.inviteTimer = null
    }
  }

  /** 被叫 accept 后等待 confirmCallee；超时要通知已可能进入 IN_CALL 的主叫。 */
  private startConfirmCalleeTimeout(): void {
    if (this.destroyed) return
    this.clearConfirmCalleeTimeout()
    const callId = this.singleCallState.getState().callId
    if (!callId) return

    this.confirmCalleeTimer = setTimeout(() => {
      this.confirmCalleeTimer = null
      if (!this.isCurrentCall(callId)) return
      const snapshot = this.singleCallState.getState()
      if (snapshot.status === CALL_STATUS.IDLE || snapshot.status === CALL_STATUS.IN_CALL) return

      this.logger.warn('[CallKitCore] ⚠️ 等待 confirmCallee 超时，通知对端并回收状态机')
      this.notifyTimeoutPeer(snapshot, 'confirmCallee')
      const result = this.singleCallState.timeout()
      if (result.ok) {
        this.processEvents(result.events, snapshot)
      }
    }, CallKitCore.CONFIRM_CALLEE_TIMEOUT_MS)
  }

  private clearConfirmCalleeTimeout(): void {
    if (this.confirmCalleeTimer) {
      clearTimeout(this.confirmCalleeTimer)
      this.confirmCalleeTimer = null
    }
  }

  /**
   * 超时信令由当前角色和阶段决定：
   * - 主叫等待接听：cancelCall；被叫尚未接听：answerCall(refuse)。
   * - 被叫已 accept、等待 confirmCallee：leaveCall，让已进入 IN_CALL 的主叫同步退出。
   */
  private notifyTimeoutPeer(snapshot: SingleCallState, phase: 'invite' | 'confirmCallee'): void {
    if (this.destroyed) return
    const isCaller = snapshot.callerUserId === this.userId
    const action = phase === 'confirmCallee'
      ? 'leaveCall'
      : isCaller
      ? 'cancelCall'
      : 'answerCall'
    if (phase === 'confirmCallee' && isCaller) return

    const targetId = isCaller ? snapshot.calleeUserId : snapshot.callerUserId
    if (!targetId) return
    const ext = MessageBuilder.buildCmdExt({
      action,
      callId: snapshot.callId,
      callerDevId: snapshot.callerDevId,
      calleeDevId: this.deviceId,
      result: action === 'answerCall' ? 'refuse' : undefined,
    })

    this.signalSender
      .sendCmdMessage(targetId, 'singleChat', ext, {
        deliverOnlineOnly: action === 'answerCall',
      })
      .catch((err) => {
        this.logger.warn('[CallKitCore] 超时通知发送失败', {
          action,
          phase,
          callId: snapshot.callId,
          targetId,
          err,
        })
      })
  }

  /**
   * 记录已取消的 callId（TTL = inviteTimeout + 10s，与 invite 过期窗口对齐）
   * 同时惰性清理已过期的条目
   */
  private markCallCanceled(callId: string): void {
    const now = Date.now()
    this.recentlyCanceledCalls.set(callId, now + this.inviteTimeoutMs + 10000)
    for (const [id, expireAt] of this.recentlyCanceledCalls) {
      if (expireAt <= now) {
        this.recentlyCanceledCalls.delete(id)
      }
    }
    this.logger.debug('[CallKitCore] 已记录取消名单 | callId=', callId)
  }

  /**
   * 检查 callId 是否近期已被取消（命中且未过期）
   */
  private isCallRecentlyCanceled(callId: string): boolean {
    const expireAt = this.recentlyCanceledCalls.get(callId)
    if (expireAt === undefined) return false
    if (expireAt <= Date.now()) {
      this.recentlyCanceledCalls.delete(callId)
      return false
    }
    return true
  }
}
