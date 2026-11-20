import { describe, expect, it, vi } from 'vitest'
import type { RtcReport } from '@easemob-community/callkit-core-v5'
import { AgoraAppRtcAdapter, type AgoraAppRtcAdapterOptions } from './AgoraAppRtcAdapter'
import type { AgoraRtcEventMap, AgoraRtcSession, AgoraSessionJoinOptions } from './types'

type EventName = keyof AgoraRtcEventMap
type EventCallback = (data: any, event: EventName) => void

function createFakeSession() {
  const listeners = new Map<EventName, Set<EventCallback>>()
  let joinDeferred: { resolve: (value: any) => void; reject: (reason: unknown) => void } | null = null
  const order: string[] = []

  const session: AgoraRtcSession = {
    on(event, callback) {
      const set = listeners.get(event) || new Set<EventCallback>()
      set.add(callback as EventCallback)
      listeners.set(event, set)
      return () => set.delete(callback as EventCallback)
    },
    cancelPendingOperations: vi.fn(() => {
      order.push('cancel')
    }),
    join: vi.fn((options: AgoraSessionJoinOptions) => {
      order.push('join')
      return new Promise<{ channel: string; uid: number; elapsed: number }>((resolve, reject) => {
        joinDeferred = { resolve, reject }
      })
    }),
    leave: vi.fn(async () => {
      order.push('leave')
    }),
    dispose: vi.fn(async () => {
      order.push('dispose')
    }),
    enableLocalAudio: vi.fn(async (enabled: boolean) => {
      order.push(`audio:${enabled}`)
    }),
    enableLocalVideo: vi.fn(async (enabled: boolean) => {
      order.push(`video:${enabled}`)
    }),
    startPreview: vi.fn(async () => {
      order.push('preview')
    }),
    muteLocalAudio: vi.fn(async (muted: boolean) => {
      order.push(`muteAudio:${muted}`)
    }),
    muteLocalVideo: vi.fn(async (muted: boolean) => {
      order.push(`muteVideo:${muted}`)
    }),
    switchCamera: vi.fn(async () => {
      order.push('switchCamera')
    }),
    setSpeakerphoneEnabled: vi.fn(async (enabled: boolean) => {
      order.push(`speaker:${enabled}`)
    })
  }

  const emit = (event: EventName, data: any) => {
    ;(listeners.get(event) || new Set<EventCallback>()).forEach((callback) => callback(data, event))
  }

  const resolveJoin = (uid = 456) => {
    joinDeferred?.resolve({ channel: 'channel_1', uid, elapsed: 1 })
  }

  const rejectJoin = (error: unknown) => {
    joinDeferred?.reject(error)
  }

  return { session, emit, resolveJoin, rejectJoin, order }
}

function createAdapter(overrides: Partial<AgoraAppRtcAdapterOptions> = {}) {
  const fake = createFakeSession()
  const reports: RtcReport[] = []
  const adapter = new AgoraAppRtcAdapter({
    createSession: () => fake.session,
    onReport: (report) => reports.push(report),
    defaultAppId: 'app_default',
    ...overrides
  })
  return { adapter, ...fake, reports }
}

async function flush() {
  await Promise.resolve()
  await Promise.resolve()
}

describe('AgoraAppRtcAdapter', () => {
  it('按视频通话配置入房并发布音视频', async () => {
    const { adapter, resolveJoin, reports } = createAdapter({
      resolveCallType: () => 'video'
    })

    const promise = adapter.joinChannel({
      channel: ' channel_1 ',
      token: 'token_1',
      uid: '123',
      appId: 'app_token'
    })
    await flush()
    resolveJoin(456)
    await promise

    expect(reports.filter((report) => report.type === 'rtcJoined')).toHaveLength(1)
    expect((reports.find((report) => report.type === 'rtcJoined') as any).payload.uid).toBe(456)
  })

  it('普通 join 失败后 dispose，并保留原始错误', async () => {
    const { adapter, rejectJoin, session } = createAdapter()
    const joinError = new Error('token expired')
    const promise = adapter.joinChannel({ channel: 'ch', token: 't', uid: 1, appId: 'a' })
    await flush()

    rejectJoin(joinError)

    await expect(promise).rejects.toBe(joinError)
    expect(session.dispose).toHaveBeenCalledTimes(1)
    expect(adapter.isJoined).toBe(false)
  })

  it('join 失败后的 dispose 异常不覆盖原始错误', async () => {
    const { adapter, rejectJoin, session } = createAdapter()
    const joinError = new Error('permission denied')
    ;(session.dispose as any).mockRejectedValueOnce(new Error('dispose failed'))
    const promise = adapter.joinChannel({ channel: 'ch', token: 't', uid: 1, appId: 'a' })
    await flush()

    rejectJoin(joinError)

    await expect(promise).rejects.toBe(joinError)
    expect(session.dispose).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['dispose', 1],
    ['leaveChannel', 1],
    ['dispose', 3],
    ['leaveChannel', 3]
  ] as const)('disposes the captured joined session on immediate %s after %i replacements', async (termination, count) => {
    const first = createFakeSession()
    const createSession = vi.fn(() => first.session)
    const { adapter, reports } = createAdapter({ createSession })
    const firstJoin = adapter.joinChannel({ channel: 'A', token: 't', uid: 1 })
    await flush()
    first.resolveJoin(1)
    await firstJoin
    reports.length = 0

    const cancellations = Array.from({ length: count }, (_, index) => {
      const replacement = adapter.joinChannel({ channel: `replacement_${index}`, token: 't', uid: 1 })
      return expect(replacement).rejects.toMatchObject({ name: 'CallKitRtcCancelledError' })
    })
    const terminationPromise = adapter[termination]()
    await Promise.all([...cancellations, terminationPromise])

    expect(createSession).toHaveBeenCalledTimes(1)
    expect(first.session.join).toHaveBeenCalledTimes(1)
    expect(first.session.dispose).toHaveBeenCalledTimes(1)
    expect(first.order).toEqual(['join', 'cancel', 'dispose'])
    expect(adapter.isJoined).toBe(false)
    expect(reports).toEqual([])

    await adapter.dispose()
    await adapter.dispose()
    expect(first.session.dispose).toHaveBeenCalledTimes(1)
  })

  it.each([false, true])('serializes consecutive replacements behind captured cleanup (cleanup fails: %s)', async (cleanupFails) => {
    const first = createFakeSession()
    const latest = createFakeSession()
    const cleanupError = new Error('old session cleanup failed')
    const logger = vi.fn()
    const createSession = vi.fn()
      .mockReturnValueOnce(first.session)
      .mockReturnValueOnce(latest.session)
    const { adapter, reports } = createAdapter({ createSession, logger })
    const firstJoin = adapter.joinChannel({ channel: 'A', token: 't', uid: 1 })
    await flush()
    first.resolveJoin(1)
    await firstJoin
    reports.length = 0

    let finishCleanup!: () => void
    vi.mocked(first.session.dispose).mockImplementationOnce(() => new Promise<void>((resolve, reject) => {
      finishCleanup = () => cleanupFails ? reject(cleanupError) : resolve()
    }))

    const secondJoin = adapter.joinChannel({ channel: 'B', token: 't', uid: 1 })
    const secondCancelled = expect(secondJoin).rejects.toMatchObject({ name: 'CallKitRtcCancelledError' })
    const thirdJoin = adapter.joinChannel({ channel: 'C', token: 't', uid: 1 })
    const thirdCancelled = expect(thirdJoin).rejects.toMatchObject({ name: 'CallKitRtcCancelledError' })
    const latestJoin = adapter.joinChannel({ channel: 'D', token: 't', uid: 1 })
    await flush()

    expect(first.session.dispose).toHaveBeenCalledTimes(1)
    expect(createSession).toHaveBeenCalledTimes(1)
    expect(latest.session.join).not.toHaveBeenCalled()

    finishCleanup()
    await Promise.all([secondCancelled, thirdCancelled])
    await flush()
    expect(createSession).toHaveBeenCalledTimes(2)
    expect(latest.session.join).toHaveBeenCalledWith(expect.objectContaining({ channelName: 'D' }))
    latest.resolveJoin(1)
    await latestJoin

    expect(adapter.isJoined).toBe(true)
    expect(reports).toEqual([{ type: 'rtcJoined', payload: { uid: 1, userId: undefined } }])
    expect(first.session.dispose).toHaveBeenCalledTimes(1)
    if (cleanupFails) {
      expect(logger).toHaveBeenCalledWith('[AgoraAppRtcAdapter] old session dispose failed', cleanupError)
    } else {
      expect(logger).not.toHaveBeenCalled()
    }

    await adapter.dispose()
    await adapter.dispose()
    expect(first.session.dispose).toHaveBeenCalledTimes(1)
    expect(latest.session.dispose).toHaveBeenCalledTimes(1)
  })

  it.each(['dispose', 'leaveChannel'] as const)('preserves replacement cancellation when captured cleanup fails before %s', async (termination) => {
    const first = createFakeSession()
    const cleanupError = new Error('old session cleanup failed')
    const logger = vi.fn()
    const createSession = vi.fn(() => first.session)
    const { adapter } = createAdapter({ createSession, logger })
    const firstJoin = adapter.joinChannel({ channel: 'A', token: 't', uid: 1 })
    await flush()
    first.resolveJoin(1)
    await firstJoin
    vi.mocked(first.session.dispose).mockRejectedValueOnce(cleanupError)

    const replacement = adapter.joinChannel({ channel: 'B', token: 't', uid: 1 })
    const cancelled = expect(replacement).rejects.toMatchObject({ name: 'CallKitRtcCancelledError' })
    const terminationPromise = adapter[termination]()
    await Promise.all([cancelled, terminationPromise])

    expect(first.session.dispose).toHaveBeenCalledTimes(1)
    expect(createSession).toHaveBeenCalledTimes(1)
    expect(logger).toHaveBeenCalledWith('[AgoraAppRtcAdapter] old session dispose failed', cleanupError)
    expect(adapter.isJoined).toBe(false)
    await adapter.dispose()
    expect(first.session.dispose).toHaveBeenCalledTimes(1)
  })

  it('continues cleanup and later joins after replacement join and both disposals fail', async () => {
    const first = createFakeSession()
    const replacement = createFakeSession()
    const next = createFakeSession()
    const previousCleanupError = new Error('previous dispose failed')
    const replacementCleanupError = new Error('replacement dispose failed')
    const joinError = new Error('replacement token expired')
    const logger = vi.fn()
    const createSession = vi.fn()
      .mockReturnValueOnce(first.session)
      .mockReturnValueOnce(replacement.session)
      .mockReturnValueOnce(next.session)
    const { adapter } = createAdapter({ createSession, logger })
    const firstJoin = adapter.joinChannel({ channel: 'A', token: 't', uid: 1 })
    await flush()
    first.resolveJoin(1)
    await firstJoin
    vi.mocked(first.session.dispose).mockRejectedValueOnce(previousCleanupError)
    vi.mocked(replacement.session.dispose).mockRejectedValueOnce(replacementCleanupError)

    const replacementJoin = adapter.joinChannel({ channel: 'B', token: 't', uid: 1 })
    const rejected = expect(replacementJoin).rejects.toBe(joinError)
    await vi.waitFor(() => expect(replacement.session.join).toHaveBeenCalledTimes(1))
    replacement.rejectJoin(joinError)
    await rejected

    expect(first.session.dispose).toHaveBeenCalledTimes(1)
    expect(replacement.session.dispose).toHaveBeenCalledTimes(1)
    expect(logger).toHaveBeenCalledWith('[AgoraAppRtcAdapter] old session dispose failed', previousCleanupError)
    expect(logger).toHaveBeenCalledWith('[AgoraAppRtcAdapter] join failed; session dispose failed', replacementCleanupError)
    expect(adapter.isJoined).toBe(false)

    const nextJoin = adapter.joinChannel({ channel: 'C', token: 't', uid: 1 })
    await flush()
    expect(createSession).toHaveBeenCalledTimes(3)
    next.resolveJoin(1)
    await nextJoin
    expect(adapter.isJoined).toBe(true)

    await adapter.dispose()
    expect(next.session.dispose).toHaveBeenCalledTimes(1)
  })

  it('把 SDK5 字符串 UID 转为数字并校验', async () => {
    const { adapter, resolveJoin, session } = createAdapter()
    const promise = adapter.joinChannel({ channel: 'ch', token: 't', uid: '12', appId: 'a' })
    await flush()
    resolveJoin()
    await promise

    expect(session.join).toHaveBeenCalledWith(expect.objectContaining({
      uid: 12,
      appId: 'a',
      channelName: 'ch',
      publishAudio: true,
      publishVideo: false,
      autoSubscribeAudio: true,
      autoSubscribeVideo: false,
      permissionOptions: { audio: true, video: false }
    }))
  })

  it('拒绝非法 UID 和缺失 App ID', async () => {
    const noApp = createAdapter({ defaultAppId: undefined })
    await expect(noApp.adapter.joinChannel({
      channel: 'ch',
      token: 't',
      uid: 1
    })).rejects.toThrow('App ID')

    const invalidUid = createAdapter()
    await expect(invalidUid.adapter.joinChannel({
      channel: 'ch',
      token: 't',
      uid: 'abc',
      appId: 'app'
    })).rejects.toThrow('非法 RTC UID')
  })

  it('把 userJoined 映射为 Core 事件并解析 userId', async () => {
    const { adapter, resolveJoin, emit, reports } = createAdapter({
      resolveUserId: async (uid) => (uid === 9 ? 'user_9' : undefined)
    })
    const promise = adapter.joinChannel({ channel: 'ch', token: 't', uid: 1, appId: 'a' })
    await flush()
    resolveJoin()
    await promise
    reports.length = 0

    emit('userJoined', { uid: 9, elapsed: 1 })
    await flush()

    expect(reports).toEqual([
      { type: 'userJoined', payload: { uid: 9, userId: 'user_9' } }
    ])
  })

  it('把远端音频/视频状态映射为 muted 事件', async () => {
    const { adapter, resolveJoin, emit, reports } = createAdapter()
    const promise = adapter.joinChannel({ channel: 'ch', token: 't', uid: 1, appId: 'a' })
    await flush()
    resolveJoin()
    await promise
    reports.length = 0

    emit('remoteAudioStateChanged', { uid: 9, state: 2, reason: 0, elapsed: 1 })
    emit('remoteVideoStateChanged', { uid: 9, state: 0, reason: 0, elapsed: 1 })
    await flush()

    expect(reports.map((report) => report.type)).toEqual([
      'userAudioUnmuted',
      'userVideoMuted'
    ])
  })

  it('setAudioEnabled 与设备控制映射到 Session', async () => {
    const { adapter, resolveJoin, session } = createAdapter()
    const promise = adapter.joinChannel({ channel: 'ch', token: 't', uid: 1, appId: 'a' })
    await flush()
    resolveJoin()
    await promise

    await adapter.setAudioEnabled(false)
    await adapter.setVideoEnabled(true)
    await adapter.switchCamera('front')
    await adapter.switchAudioOutput('earpiece')

    expect(session.muteLocalAudio).toHaveBeenCalledWith(true)
    expect(session.enableLocalVideo).toHaveBeenCalledWith(true)
    expect(session.startPreview).toHaveBeenCalled()
    expect(session.switchCamera).toHaveBeenCalled()
    expect(session.setSpeakerphoneEnabled).toHaveBeenCalledWith(false)
  })

  it('串行执行命令，避免并发设备操作', async () => {
    const { adapter, resolveJoin, session, order } = createAdapter()
    const joinPromise = adapter.joinChannel({ channel: 'ch', token: 't', uid: 1, appId: 'a' })
    await flush()
    resolveJoin()
    await joinPromise

    let releaseAudio!: () => void
    ;(session.muteLocalAudio as any).mockImplementationOnce(
      () => new Promise<void>((resolve) => { releaseAudio = resolve })
    )

    const audioPromise = adapter.setAudioEnabled(false)
    const videoPromise = adapter.setVideoEnabled(false)
    await flush()

    expect(session.enableLocalVideo).not.toHaveBeenCalled()
    releaseAudio()
    await Promise.all([audioPromise, videoPromise])
    expect(session.enableLocalVideo).toHaveBeenCalled()
  })

  it('离开频道后忽略旧 Session 的迟到事件', async () => {
    const { adapter, resolveJoin, emit, reports } = createAdapter()
    const joinPromise = adapter.joinChannel({ channel: 'ch', token: 't', uid: 1, appId: 'a' })
    await flush()
    resolveJoin()
    await joinPromise
    reports.length = 0

    await adapter.leaveChannel()
    emit('userJoined', { uid: 9, elapsed: 1 })
    await flush()

    expect(reports.filter((report) => report.type === 'userJoined')).toHaveLength(0)
    expect(reports.filter((report) => report.type === 'rtcLeft')).toHaveLength(1)
  })

  it('入房过程中离开会取消旧 join', async () => {
    const { adapter, rejectJoin } = createAdapter()
    const joinPromise = adapter.joinChannel({ channel: 'ch', token: 't', uid: 1, appId: 'a' })
    await flush()

    const leavePromise = adapter.leaveChannel()
    rejectJoin(new Error('cancelled'))
    await expect(joinPromise).rejects.toThrow('cancelled')
    await leavePromise
  })

  it('明确拒绝插件不支持的动态订阅', async () => {
    const { adapter } = createAdapter()
    await expect(adapter.subscribeRemoteUser('user_a', 'video')).rejects.toThrow('不支持')
    await expect(adapter.unsubscribeRemoteUser('user_a', 'audio')).rejects.toThrow('不支持')
    await expect(adapter.switchMicrophone('mic')).rejects.toThrow('不支持')
  })

  // ─── 回归：M-3 旧 session 释放 / M-4 关闭视频 / M-5 uid 兜底 ───

  it('M-3: 挂断后立刻重呼，旧 session 仍会被 leave + dispose', async () => {
    const sessions: ReturnType<typeof createFakeSession>[] = []
    const adapter = new AgoraAppRtcAdapter({
      createSession: () => {
        const fake = createFakeSession()
        sessions.push(fake)
        return fake.session
      },
      onReport: () => undefined,
      defaultAppId: 'app_default'
    })

    const firstJoin = adapter.joinChannel({ channel: 'ch_1', token: 't', uid: 1, appId: 'a' })
    await flush()
    sessions[0].resolveJoin()
    await firstJoin

    // 挂断与重呼紧邻：leave 的代际被 join 自增，旧实现会直接 return 导致资源泄漏
    const leavePromise = adapter.leaveChannel()
    const secondJoin = adapter.joinChannel({ channel: 'ch_2', token: 't', uid: 1, appId: 'a' })
    // join 任务排在 leave 之后，需要等 leave 的 leave()+dispose() 走完才会创建新 session
    for (let i = 0; i < 10 && sessions.length < 2; i++) await flush()
    expect(sessions).toHaveLength(2)
    sessions[1].resolveJoin()
    await Promise.all([leavePromise, secondJoin])

    expect(sessions[0].session.leave).toHaveBeenCalled()
    expect(sessions[0].session.dispose).toHaveBeenCalled()
  })

  it('M-4: setVideoEnabled(false) 同时 mute 并停预览', async () => {
    const { adapter, resolveJoin, session } = createAdapter({ resolveCallType: () => 'video' })
    const promise = adapter.joinChannel({ channel: 'ch', token: 't', uid: 1, appId: 'a' })
    await flush()
    resolveJoin()
    await promise

    await adapter.setVideoEnabled(false)

    expect(session.muteLocalVideo).toHaveBeenCalledWith(true)
    expect(session.enableLocalVideo).toHaveBeenLastCalledWith(false)
  })

  it('M-5: 解析失败时仍上报 uid，交由 Core 用本地缓存兜底', async () => {
    const { adapter, resolveJoin, emit, reports } = createAdapter({
      resolveUserId: async () => undefined
    })
    const promise = adapter.joinChannel({ channel: 'ch', token: 't', uid: 1, appId: 'a' })
    await flush()
    resolveJoin()
    await promise
    reports.length = 0

    emit('userJoined', { uid: 9, elapsed: 1 })
    await flush()

    expect(reports).toEqual([{ type: 'userJoined', payload: { uid: 9, userId: undefined } }])
  })
})
