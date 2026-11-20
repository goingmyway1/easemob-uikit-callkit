import {
  CALL_TYPE,
  type CallKitCore,
  type CallKitEvent,
  type RtcReport
} from '@easemob-community/callkit-core-v5'

/**
 * RTC 会话所有权。
 *
 * - `adapter`（默认）：CallKitCore 持有 rtcAdapter，由 Core 自动 join/leave/publish。
 * - `component`：RTC 交给 agora-rtc 的默认 UI 组件独占，Core 只负责信令，
 *   通过本桥接层把 shouldJoinRtc 等事件翻译成组件 props 与命令。
 *
 * 两者不可同时挂载：组件内部会 `new RtcCallSession()`，与 AgoraAppRtcAdapter
 * 各持一个会话，同时 join 同一频道属于未定义行为。
 */
export type RtcOwnership = 'adapter' | 'component'

/**
 * 一屏通话页需要的全部只读状态。
 * 页面把它整体绑定到 `agora-call-one-to-one` / `agora-call-group` 上即可。
 */
export interface GroupCallParticipantView {
  userId: string
  nickname: string
  avatarURL: string
  state: 'invited' | 'accepted' | 'joinedRtc' | 'left'
}

/** 数字 RTC UID 到用户资料的映射，供群聊网格渲染已入房成员头像/昵称。 */
export interface GroupRtcProfileView {
  uid: string
  userId: string
  nickname: string
  avatarURL: string
}

export interface CallViewProps {
  /** 是否展示通话页（页面用 v-if 控制，保证组件挂载时 props 已就绪） */
  visible: boolean
  /** Stable call identity for native component reconstruction. */
  callId?: string
  appId: string
  channelName: string
  token: string
  /** 本端数字 UID；0 表示尚未就绪（Core 会以 rtcUidMissing 中止，不会走到这里） */
  uid: number
  mediaType: 'audio' | 'video'
  callDirection: 'outgoing' | 'incoming'
  /** 入局振铃：来电未接听、或呼出等待对方应答时为 true */
  ringing: boolean
  /**
   * 该调组件 join() 了（由 shouldJoinRtc 驱动）。
   * agora-rtc 组件固定 autoJoin=false，入房时机完全由这个标志决定：
   * 页面看到它变 true 再调 ref.join()，避免 props 还没就绪就入房。
   */
  shouldJoin: boolean
  /** 群聊走 agora-call-group，单聊走 agora-call-one-to-one */
  groupMode: boolean
  /** 群 ID（仅群聊有值） */
  groupId: string
  /** 群名称（仅群聊且服务端下发时有值），界面优先显示它而不是"群聊通话" */
  groupName: string
  remoteName: string
  remoteAvatar: string
  /** 群聊远端成员快照；用于渲染未入房占位，不包含本机 */
  groupParticipants: GroupCallParticipantView[]
  /** 已入房成员的 RTC UID → 昵称/头像映射 */
  groupRtcProfiles: Record<string, GroupRtcProfileView>
  /** 群聊主叫已入房但尚无远端成员入房 */
  groupWaiting: boolean
  /** 入房时的初始静音态，取自 Core 状态机，避免"界面开着、实际静音" */
  initialAudioMuted: boolean
  initialVideoMuted: boolean
  /** 跨 JS 上下文媒体命令：目标静音态与单调递增的命令序号 */
  audioMuted?: boolean
  videoMuted?: boolean
  audioCommandId?: number
  videoCommandId?: number
}

/** 组件 ref 暴露的方法子集（对应 agora-rtc 的 AgoraCallMethods） */
export interface CallViewComponent {
  join(): Promise<unknown>
  setAudioMuted(muted: boolean): Promise<void>
  setVideoMuted(muted: boolean): Promise<void>
  switchCamera(): Promise<void>
}

export interface CallUiBridgeOptions {
  core: CallKitCore
  /** RTC Token 未返回 appId 时的兜底 */
  defaultRtcAppId?: string
  /** 当前登录用户 ID，用于从群成员快照中排除本机 */
  localUserId?: string
  /** 按 userId 查昵称头像（异步场景请自行预热缓存，桥接层保持同步） */
  resolveProfile?: (userId: string) => { nickname?: string; avatarURL?: string } | undefined
  /** component 模式通过 SDK5 补全 RTC UID 对应的 userId */
  resolveRtcUserId?: (uid: number | string) => Promise<string | undefined> | string | undefined
  /** 组件操作失败等非致命错误 */
  onError?: (error: unknown, context: string) => void
  logger?: (message: string, data?: unknown) => void
}

export interface CallUiBridge {
  /** 返回快照副本，页面直接绑定；变更后通过 onChange 通知 */
  getView(): CallViewProps
  onChange(listener: (view: CallViewProps) => void): () => void
  /** 由 Core 事件驱动；由 core-adapter 统一转发，业务不必手动调用 */
  handleEvent(event: CallKitEvent): void
  /** 页面在组件 mounted / beforeUnmount 时调用，传 null 表示卸载 */
  attach(component: CallViewComponent | null): void
  /** component 模式的原生 RTC 事件；异步 UID 解析按上报顺序串行执行 */
  reportRtcEvent(report: RtcReport): Promise<void>
  /** 显式入房；正常流程由 handleEvent 自动触发 */
  join(): Promise<void>
  setAudioMuted(muted: boolean): Promise<void>
  setVideoMuted(muted: boolean): Promise<void>
  switchCamera(): Promise<void>
  /** 组件自带控制栏改静音后，把结果回写 Core 状态机；commandId 用于丢弃乱序回执 */
  syncMediaToCore(state: {
    audioMuted?: boolean
    videoMuted?: boolean
    audioCommandId?: number
    videoCommandId?: number
  }): void
  /** nvue 原生命令失败；只有最新命令允许回滚 Core */
  handleMediaCommandError?(kind: 'audio' | 'video', commandId: number, error: unknown): void
  /** 通话结束后重置可见性与入房参数（页面退场动画结束后调用） */
  reset(): void
  dispose(): void
}

function isVideoCallType(callType: CALL_TYPE | null | undefined): boolean {
  return callType === CALL_TYPE.VIDEO_1V1 || callType === CALL_TYPE.VIDEO_MULTI
}

function isGroupCallType(callType: CALL_TYPE | null | undefined): boolean {
  return callType === CALL_TYPE.VIDEO_MULTI || callType === CALL_TYPE.AUDIO_MULTI
}

type MediaKind = 'audio' | 'video'

interface MediaRequest {
  id: number
  muted: boolean
  resolve: () => void
}

interface MediaChannel {
  latestId: number
  latestPreviousEnabled: boolean
  running: boolean
  pending: MediaRequest | null
}

function createMediaChannel(latestId = 0): MediaChannel {
  return { latestId, latestPreviousEnabled: true, running: false, pending: null }
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

/**
 * 创建「Core 信令 ↔ agora-rtc 默认 UI」之间的桥接。
 *
 * 设计要点：
 * 1. 不依赖 vue：`view` 是普通对象，页面自行用 reactive/computed 承接，
 *    这样 Vue2/Vue3 宿主、以及 vitest 下都能直接跑。
 * 2. Vue 组件可通过 `attach(ref)` 入房；nvue 不共享实例，改由 `shouldJoin`
 *    与媒体命令快照驱动原生组件，两条路径都不依赖跨上下文传递 ref。
 * 3. `ringing` 只由信令控制，符合插件「不自行推断来电」的约定。
 */
export function createCallUiBridge(options: CallUiBridgeOptions): CallUiBridge {
  if (!options || !options.core) {
    throw new TypeError('[createCallUiBridge] core 必传')
  }

  const { core } = options
  let view = createEmptyView()
  let component: CallViewComponent | null = null
  let pendingJoin = false
  let disposed = false
  let generation = 0
  let callId: string | undefined
  let joiningComponent: CallViewComponent | null = null
  const mediaChannels: Record<MediaKind, MediaChannel> = {
    audio: createMediaChannel(),
    video: createMediaChannel()
  }
  // 只覆盖 Core 同步发出事件的调用栈，不作为异步操作锁。
  const coreMediaEcho: Record<MediaKind, boolean> = { audio: false, video: false }
  let rtcReportQueue: Promise<void> = Promise.resolve()
  const rtcUidToUserId = new Map<string, string>()
  const listeners = new Set<(view: CallViewProps) => void>()

  const log = (message: string, data?: unknown) => options.logger?.(`[CallUiBridge] ${message}`, data)

  const notify = () => {
    const snapshot = { ...view }
    listeners.forEach((listener) => {
      try {
        listener(snapshot)
      } catch (error) {
        log('onChange 回调抛错', error)
      }
    })
  }

  const patch = (next: Partial<CallViewProps>) => {
    let changed = false
    ;(Object.keys(next) as Array<keyof CallViewProps>).forEach((key) => {
      const value = next[key]
      if (value !== undefined && view[key] !== value) {
        view[key] = value as never
        changed = true
      }
    })
    if (changed) notify()
  }

  const reportError = (error: unknown, context: string) => {
    log(`${context} 失败`, error)
    options.onError?.(error, context)
  }

  const createGroupParticipant = (
    userId: string,
    state: GroupCallParticipantView['state'] = 'invited'
  ): GroupCallParticipantView => {
    const profile = options.resolveProfile?.(userId)
    return {
      userId,
      nickname: profile?.nickname || userId,
      avatarURL: profile?.avatarURL || '',
      state
    }
  }

  /**
   * 群成员快照统一从这里写回，保证 `groupWaiting` 与成员状态不会分叉。
   * 等待态只看主叫方向是否已有远端真正进入 RTC；已接受但未入房仍算等待。
   */
  const commitGroupParticipants = (
    participants: GroupCallParticipantView[],
    overrides: Partial<CallViewProps> = {}
  ) => {
    const groupMode = overrides.groupMode ?? view.groupMode
    const callDirection = overrides.callDirection ?? view.callDirection
    patch({
      ...overrides,
      groupParticipants: participants,
      groupWaiting:
        groupMode &&
        callDirection === 'outgoing' &&
        participants.length > 0 &&
        !participants.some((participant) => participant.state === 'joinedRtc')
    })
  }

  /** RTC 上报里 UID 解析成功后立刻缓存资料，原生网格下一次渲染即可替换数字 UID。 */
  const rememberRtcProfile = (uid: number | string, userId: string) => {
    if (!view.groupMode || uid === undefined || uid === null || !userId) return
    const profile = createGroupParticipant(userId)
    const key = String(uid)
    patch({
      groupRtcProfiles: {
        ...view.groupRtcProfiles,
        [key]: {
          uid: key,
          userId,
          nickname: profile.nickname,
          avatarURL: profile.avatarURL
        }
      }
    })
  }

  const updateGroupParticipant = (
    userId: string,
    state: GroupCallParticipantView['state']
  ) => {
    if (!userId) return
    if (state === 'left') {
      commitGroupParticipants(view.groupParticipants.filter((participant) => participant.userId !== userId))
      return
    }
    const index = view.groupParticipants.findIndex((participant) => participant.userId === userId)
    if (index < 0) {
      commitGroupParticipants([...view.groupParticipants, createGroupParticipant(userId, state)])
      return
    }
    const rank: Record<GroupCallParticipantView['state'], number> = {
      invited: 0,
      accepted: 1,
      joinedRtc: 2,
      left: 3
    }
    const current = view.groupParticipants[index]
    if (rank[state] < rank[current.state]) return
    const next = view.groupParticipants.map((participant) =>
      participant.userId === userId ? { ...participant, state } : participant
    )
    commitGroupParticipants(next)
  }

  /**
   * 服务端 UID 映射不可用时，用已接听/未入房的占位成员反推当前 UID。
   * 这保证“占位卡 → 实际成员卡”是原位转换，而不是再新增一张远端卡。
   * 优先 accepted（主叫端能精确知道谁接听了），再退回 invited（其他端尽力而为）。
   */
  const inferRtcUserId = (uniqueOnly = false): string | undefined => {
    if (!view.groupMode) return undefined
    const mappedUserIds = new Set(rtcUidToUserId.values())
    const accepted = view.groupParticipants.filter(
      (participant) => participant.state === 'accepted' && !mappedUserIds.has(participant.userId)
    )
    if (accepted.length > 0) {
      return uniqueOnly && accepted.length !== 1 ? undefined : accepted[0].userId
    }
    const invited = view.groupParticipants.filter(
      (participant) => participant.state === 'invited' && !mappedUserIds.has(participant.userId)
    )
    if (invited.length === 0) return undefined
    return uniqueOnly && invited.length !== 1 ? undefined : invited[0].userId
  }

  const reportRtcEvent = (report: RtcReport): Promise<void> => {
    const epoch = generation
    const task = rtcReportQueue.then(async () => {
      if (disposed || epoch !== generation) return
      const uid = report.payload?.uid
      const hasUid = uid !== undefined && uid !== null
      const uidKey = hasUid ? String(uid) : ''
      const isGroupJoin = report.type === 'userJoined' || report.type === 'userPublished'
      let userId = report.payload?.userId || (hasUid ? rtcUidToUserId.get(uidKey) : undefined)

      // 只有一个明确候选时先本地映射，避免等待服务端查询期间占位与远端卡短暂并存。
      if (hasUid && !userId && isGroupJoin) {
        userId = inferRtcUserId(true)
      }
      if (hasUid && !userId && options.resolveRtcUserId) {
        try {
          userId = (await options.resolveRtcUserId(uid)) || undefined
        } catch (error) {
          log('解析 RTC UID 失败，交由 Core 缓存兜底', { uid, error })
        }
      }
      if (disposed || epoch !== generation) return
      if (hasUid && !userId && isGroupJoin) {
        userId = inferRtcUserId()
        if (userId) log('RTC UID 无服务端映射，按占位成员反推', { uid, userId })
      }
      if (hasUid && userId) {
        rtcUidToUserId.set(uidKey, userId)
        rememberRtcProfile(uid as number | string, userId)
      }

      core.reportRtcEvent({
        ...report,
        payload: {
          ...report.payload,
          ...(userId ? { userId } : {})
        }
      })
    })
    rtcReportQueue = task.catch((error) => reportError(error, 'reportRtcEvent'))
    return task
  }

  const performJoin = async (): Promise<void> => {
    if (disposed) return
    const current = component
    if (!current) {
      // 页面还没渲染出组件：等 attach 时补一次
      pendingJoin = true
      return
    }
    pendingJoin = false
    if (!view.appId || !view.channelName) {
      reportError(new Error('appId/channelName 未就绪，跳过入房'), 'join')
      return
    }
    if (!view.uid) {
      reportError(new Error('uid 未就绪，跳过入房'), 'join')
      return
    }
    if (joiningComponent === current) return
    const epoch = generation
    joiningComponent = current
    try {
      await current.join()
      if (disposed || epoch !== generation || component !== current) return
      // Reapply commands that may have arrived while the native engine was joining.
      for (const kind of ['audio', 'video'] as MediaKind[]) {
        const channel = mediaChannels[kind]
        const commandId = kind === 'audio' ? view.audioCommandId : view.videoCommandId
        if (commandId && commandId === channel.latestId && !channel.running && !channel.pending) {
          void enqueueLocalMedia(kind, channel.latestId, Boolean(kind === 'audio' ? view.audioMuted : view.videoMuted))
        }
      }
    } catch (error) {
      if (!disposed && epoch === generation && component === current) reportError(error, 'join')
    } finally {
      if (epoch === generation && joiningComponent === current) joiningComponent = null
    }
  }

  const patchMediaDesired = (kind: MediaKind, muted: boolean, commandId?: number) => {
    if (kind === 'audio') {
      patch({
        initialAudioMuted: muted,
        audioMuted: muted,
        ...(commandId === undefined ? {} : { audioCommandId: commandId })
      })
    } else {
      patch({
        initialVideoMuted: muted,
        videoMuted: muted,
        ...(commandId === undefined ? {} : { videoCommandId: commandId })
      })
    }
  }

  const setCoreMediaEnabled = (kind: MediaKind, enabled: boolean) => {
    const state = core.getSingleCallState()
    const current = kind === 'audio' ? state.audioEnabled : state.videoEnabled
    if (current === enabled) return
    coreMediaEcho[kind] = true
    try {
      if (kind === 'audio') core.toggleAudio()
      else core.toggleVideo()
    } finally {
      coreMediaEcho[kind] = false
    }
  }

  const handleMediaCommandError = (kind: MediaKind, commandId: number, error: unknown): void => {
    if (disposed || (kind !== 'audio' && kind !== 'video')) return
    const channel = mediaChannels[kind]
    if (commandId <= 0 || commandId !== channel.latestId) return
    reportError(error, `${kind}MediaCommand`)
    // Retire the failed command so duplicate failures or late success cannot undo the rollback.
    channel.latestId += 1
    // 只有最新命令可以回滚；旧命令失败时，后续目标态仍然有效。
    patchMediaDesired(kind, !channel.latestPreviousEnabled)
    setCoreMediaEnabled(kind, channel.latestPreviousEnabled)
  }

  const drainLocalMedia = async (kind: MediaKind): Promise<void> => {
    const channel = mediaChannels[kind]
    if (channel.running) return
    const request = channel.pending
    if (!request) return
    channel.pending = null
    const target = component
    if (!target) {
      request.resolve()
      return
    }

    channel.running = true
    try {
      if (kind === 'audio') await target.setAudioMuted(request.muted)
      else await target.setVideoMuted(request.muted)
    } catch (error) {
      if (!disposed && mediaChannels[kind] === channel && component === target) {
        handleMediaCommandError(kind, request.id, error)
      }
    } finally {
      channel.running = false
      request.resolve()
    }
    if (!disposed && mediaChannels[kind] === channel && component === target && channel.pending) {
      void drainLocalMedia(kind)
    }
  }

  const enqueueLocalMedia = (kind: MediaKind, id: number, muted: boolean): Promise<void> => {
    if (!component || disposed) return Promise.resolve()
    const channel = mediaChannels[kind]
    return new Promise<void>((resolve) => {
      channel.pending?.resolve()
      channel.pending = { id, muted, resolve }
      void drainLocalMedia(kind)
    })
  }

  const requestLocalMedia = (kind: MediaKind, muted: boolean, previousEnabled: boolean): Promise<void> => {
    if (disposed) return Promise.resolve()
    const channel = mediaChannels[kind]
    const id = ++channel.latestId
    channel.latestPreviousEnabled = previousEnabled
    patchMediaDesired(kind, muted, id)
    return enqueueLocalMedia(kind, id, muted)
  }

  const invalidateMediaCommands = (): void => {
    generation += 1
    joiningComponent = null
    rtcReportQueue = Promise.resolve()
    rtcUidToUserId.clear()
    view.audioCommandId = 0
    view.videoCommandId = 0
    ;(['audio', 'video'] as MediaKind[]).forEach((kind) => {
      const channel = mediaChannels[kind]
      channel.pending?.resolve()
      channel.pending = null
      // Replace the channel: an old finally must never unlock or drain a new call's queue.
      mediaChannels[kind] = createMediaChannel(channel.latestId + 1)
    })
  }

  const syncNativeMedia = (kind: MediaKind, muted: boolean, commandId?: number): void => {
    if (disposed) return
    const channel = mediaChannels[kind]
    if (commandId !== undefined) {
      // 快速切换时旧原生回执不得覆盖最新目标态。
      if (commandId !== channel.latestId) return
    } else {
      if (channel.running && component) return
      // A control-bar action supersedes outstanding cross-context receipts without issuing a native command.
      channel.latestId += 1
    }
    patchMediaDesired(kind, muted)
    setCoreMediaEnabled(kind, !muted)
  }

  const handleEvent = (event: CallKitEvent): void => {
    if (disposed) return
    if (
      event.type === 'incomingCall' ||
      event.type === 'groupCallInit' ||
      event.type === 'singleCallInvited' ||
      event.type === 'shouldJoinRtc'
    ) {
      const nextCallId = event.payload.callId
      if (callId !== undefined && nextCallId !== callId) {
        invalidateMediaCommands()
        component = null
        pendingJoin = false
      }
      callId = nextCallId
    }

    switch (event.type) {
      case 'groupCallInit': {
        const p = event.payload
        const participants = (p.invitedMembers || [])
          .filter((userId) => userId && userId !== options.localUserId && userId !== p.callerUserId)
          .map((userId) => createGroupParticipant(userId, 'invited'))
        commitGroupParticipants(participants, {
          callId: p.callId,
          groupMode: true,
          groupId: p.groupId,
          groupName: p.groupName || '',
          groupRtcProfiles: {}
        })
        break
      }

      case 'incomingCall': {
        // core 的群聊 incomingCall 会额外带 groupId / groupName / invitedMembers，
        // IncomingCallEvent 的公开类型只声明了单聊字段，这里局部放宽读取
        const p = event.payload as typeof event.payload & { groupId?: string; groupName?: string }
        const profile = options.resolveProfile?.(p.callerUserId)
        const mediaType: 'audio' | 'video' = isVideoCallType(p.callType) ? 'video' : 'audio'
        const state = core.getSingleCallState()
        const groupMode = isGroupCallType(p.callType)
        patch({
          visible: true,
          callId: p.callId,
          appId: p.appId || options.defaultRtcAppId || '',
          channelName: p.channel,
          token: p.token || '',
          uid: Number(p.uid) || 0,
          mediaType,
          callDirection: 'incoming',
          ringing: true,
          shouldJoin: false,
          groupMode,
          groupId: p.groupId || '',
          groupName: p.groupName || '',
          remoteName: p.callerInfo?.nickname || profile?.nickname || '',
          remoteAvatar: p.callerInfo?.avatarURL || profile?.avatarURL || '',
          groupWaiting: false,
          initialAudioMuted: state.audioEnabled === false,
          initialVideoMuted: state.videoEnabled === false,
          audioMuted: state.audioEnabled === false,
          videoMuted: state.videoEnabled === false
        })
        break
      }

      case 'singleCallInvited': {
        // 主叫发出邀请成功：此时还拿不到 appId/uid/token，只能先给一个「正在呼叫」界面。
        // 不处理这个事件的话，主叫点完呼叫什么都不发生，直到被叫接听才会跳页。
        const p = event.payload
        if (!p.isCaller) break
        const calleeProfile = options.resolveProfile?.(p.calleeUserId || '')
        const isGroup = isGroupCallType(p.callType)
        // groupCallInit 与 singleCallInvited 是同一 build 内先后发出的两个事件，
        // 主叫必须保留前者的群名和成员快照；只有 callId 不同才视为上一通残留。
        const sameGroupCall = isGroup && view.callId === p.callId && (!!view.groupId || !!view.groupName)
        const groupParticipants = sameGroupCall ? view.groupParticipants : []
        patch({
          visible: true,
          callId: p.callId,
          appId: '',
          channelName: p.channel,
          token: '',
          uid: 0,
          mediaType: isVideoCallType(p.callType) ? 'video' : 'audio',
          callDirection: 'outgoing',
          ringing: true,
          shouldJoin: false,
          groupMode: isGroup,
          groupId: sameGroupCall ? view.groupId : '',
          groupName: sameGroupCall ? view.groupName : '',
          groupParticipants,
          groupWaiting:
            isGroup &&
            groupParticipants.length > 0 &&
            !groupParticipants.some((participant) => participant.state === 'joinedRtc'),
          remoteName: isGroup
            ? (sameGroupCall ? view.groupName || view.remoteName : p.calleeUserId || '')
            : calleeProfile?.nickname || p.calleeUserId || '',
          remoteAvatar: isGroup ? (sameGroupCall ? view.remoteAvatar : '') : calleeProfile?.avatarURL || '',
          initialAudioMuted: core.getSingleCallState().audioEnabled === false,
          initialVideoMuted: core.getSingleCallState().videoEnabled === false,
          audioMuted: core.getSingleCallState().audioEnabled === false,
          videoMuted: core.getSingleCallState().videoEnabled === false
        })
        break
      }

      case 'shouldJoinRtc': {
        const p = event.payload
        const state = core.getSingleCallState()
        // 被叫：来电时已经渲染并振铃，这里只需停止振铃后入房
        const wasIncoming = view.visible && view.callDirection === 'incoming'
        const callDirection = wasIncoming || p.role === 'callee' ? 'incoming' : 'outgoing'
        const groupMode = isGroupCallType(p.callType)
        patch({
          visible: true,
          callId: p.callId,
          appId: p.appId || options.defaultRtcAppId || view.appId,
          channelName: p.channel,
          token: p.token || '',
          uid: Number(p.uid) || 0,
          mediaType: isVideoCallType(p.callType) ? 'video' : 'audio',
          callDirection,
          ringing: false,
          shouldJoin: true,
          groupMode,
          groupWaiting:
            groupMode &&
            callDirection === 'outgoing' &&
            view.groupParticipants.length > 0 &&
            !view.groupParticipants.some((participant) => participant.state === 'joinedRtc'),
          initialAudioMuted: state.audioEnabled === false,
          initialVideoMuted: state.videoEnabled === false,
          audioMuted: state.audioEnabled === false,
          videoMuted: state.videoEnabled === false
        })
        void performJoin()
        break
      }

      case 'participantStateChanged': {
        // 群成员状态：invited/accepted 继续显示占位，joinedRtc 才移出未入房列表。
        const p = event.payload
        if (p.callId !== view.callId) break
        updateGroupParticipant(p.userId, p.state)
        break
      }

      case 'participantJoined': {
        const p = event.payload
        if (p.callId !== view.callId) break
        // answerCall 只代表已接听，真正入房以 participantStateChanged(joinedRtc) 为准。
        updateGroupParticipant(p.userId, 'accepted')
        break
      }

      case 'participantLeft': {
        const p = event.payload
        if (p.callId !== view.callId) break
        updateGroupParticipant(p.userId, 'left')
        break
      }

      case 'callConnected':
      case 'callAccepted':
      case 'singleCallConnected':
      case 'singleCallAccepted':
      case 'groupCallConnected':
      case 'groupCallAccepted': {
        patch({ ringing: false })
        break
      }

      case 'callEnded':
      case 'callCanceled':
      case 'callRefused':
      case 'callBusy':
      case 'callTimeout':
      case 'singleCallEnded':
      case 'singleCallTimeout':
      case 'singleCallCanceled':
      case 'singleCallRefused':
      case 'singleCallBusy':
      case 'groupCallEnded':
      case 'groupCallTimeout':
      case 'groupCallCanceled':
      case 'groupCallRefused':
      case 'groupCallBusy': {
        // 只隐藏，不清参数：页面可能还要做退场动画/展示结束原因
        invalidateMediaCommands()
        component = null
        if (view.visible) patch({ visible: false, ringing: false, shouldJoin: false })
        pendingJoin = false
        break
      }

      case 'localAudioChanged': {
        if (coreMediaEcho.audio) {
          patchMediaDesired('audio', !event.payload.enabled)
          break
        }
        void requestLocalMedia('audio', !event.payload.enabled, !event.payload.enabled)
        break
      }

      case 'localVideoChanged': {
        if (coreMediaEcho.video) {
          patchMediaDesired('video', !event.payload.enabled)
          break
        }
        void requestLocalMedia('video', !event.payload.enabled, !event.payload.enabled)
        break
      }

      default:
        break
    }
  }

  return {
    getView() {
      return { ...view }
    },

    onChange(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },

    handleEvent,
    reportRtcEvent,

    attach(next) {
      if (disposed || component === next) return
      if (component) invalidateMediaCommands()
      component = next
      if (!next) {
        pendingJoin = view.shouldJoin
        return
      }
      if (pendingJoin || view.shouldJoin) void performJoin()
    },

    join: performJoin,

    async setAudioMuted(muted) {
      if (disposed) return
      const previousEnabled = core.getSingleCallState().audioEnabled
      // join 前先统一 Core 与快照，组件 join 时直接使用同一初始静音态。
      setCoreMediaEnabled('audio', !muted)
      await requestLocalMedia('audio', muted, previousEnabled)
    },

    async setVideoMuted(muted) {
      if (disposed) return
      const previousEnabled = core.getSingleCallState().videoEnabled
      setCoreMediaEnabled('video', !muted)
      await requestLocalMedia('video', muted, previousEnabled)
    },

    async switchCamera() {
      if (disposed) return
      const target = component
      const epoch = generation
      if (!target) {
        reportError(new Error('通话组件未挂载'), 'switchCamera')
        return
      }
      try {
        await target.switchCamera()
      } catch (error) {
        if (!disposed && epoch === generation) reportError(error, 'switchCamera')
      }
    },

    handleMediaCommandError,

    syncMediaToCore(state) {
      // UI/原生已完成操作，只同步目标态，不递增命令序号，避免再次写回原生。
      if (typeof state.audioMuted === 'boolean') {
        syncNativeMedia('audio', state.audioMuted, state.audioCommandId)
      }
      if (typeof state.videoMuted === 'boolean') {
        syncNativeMedia('video', state.videoMuted, state.videoCommandId)
      }
    },

    reset() {
      if (disposed) return
      pendingJoin = false
      component = null
      callId = undefined
      invalidateMediaCommands()
      view = createEmptyView()
      notify()
    },

    dispose() {
      if (disposed) return
      disposed = true
      pendingJoin = false
      invalidateMediaCommands()
      component = null
      listeners.clear()
    }
  }
}
