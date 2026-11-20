/**
 * RTC 公共 JS Facade。
 *
 * 职责：参数校验、原生返回码检查、Promise 封装、事件分发和 Engine 操作串行化。
 * 非职责：Vue 页面状态、原生视频 refs、路由、权限弹窗和 Token 签发。
 *
 * 当前原生 Engine 与本模块均为单例；同一时刻只支持一个活动频道。
 * 业务方通常优先使用 RtcCallSession 或默认通话 UI，而不是直接管理本模块。
 *
 * Engine 所有权：initialize(appId, owner) 会把 owner 记为当前 Engine 的持有者，
 * destroy(owner) 只有在该 owner 仍是持有者时才真正销毁，避免旧页面异步销毁时
 * 误毁新页面刚创建的 Engine。省略 owner 时保持旧的“无条件销毁”语义。
 */
// 必须导入插件根模块以生成 UTS 代理；不能直接导入 utssdk 内部文件。
import * as native from '@/uni_modules/agora-rtc'

import {
  RTC_CONNECTION_STATE,
  RTC_ERROR_CATEGORY,
  RTC_EVENT
} from './rtc-constants.js'
import {
  RtcError,
  createConnectionError,
  createNativeError,
  rtcErrorMessage
} from './rtc-errors.js'
import {
  rtcLogger,
  traceRtcApi
} from './rtc-logger.js'

const JOIN_TIMEOUT_MS = 15000
const VIDEO_ENCODER_FRAME_RATES = [1, 7, 10, 15, 24, 30, 60]
const VIDEO_ORIENTATION_MODES = ['adaptive', 'portrait', 'landscape']

let initialized = false
let currentAppId = ''
let activeJoinAttempt = null
const nativeLeaveRequests = []
let engineOwner = null
const listeners = new Map()
let operationQueue = Promise.resolve()

/**
 * 将所有 Engine 操作放入同一 Promise 队列。
 *
 * 即使某一步失败，也用独立的 catch 恢复队列，避免一次错误永久阻塞后续调用。
 * 返回给调用方的 result 仍保留原始 reject，不会吞掉业务错误。
 */
function enqueue(operation) {
  const result = operationQueue.then(operation)
  operationQueue = result.catch(() => {})
  return result
}

const supported = typeof native.setEventListener === 'function'

function assertSupported() {
  if (!supported) throw new RtcError('声网 RTC 仅支持 App 自定义基座，请使用真机运行', {
    category: RTC_ERROR_CATEGORY.STATE
  })
}

function clearJoinTimer(attempt) {
  if (attempt && attempt.timer !== null) {
    clearTimeout(attempt.timer)
    attempt.timer = null
  }
}

/**
 * 原生层只有一个事件监听器，这里再分发给多个 JS 订阅者。
 * 单个业务监听器异常不能阻断其他监听器，也不能影响原生回调线程。
 */
function dispatch(event, data = {}) {
  rtcLogger.debug(`NATIVE EVENT ${event}`, data)
  routeJoinEvent(event, data)
  const callbacks = listeners.get(event)
  if (!callbacks) return
  callbacks.forEach((callback) => {
    try {
      callback(data, event)
    } catch (error) {
      console.error(`[agora-rtc] ${event} listener failed`, error)
    }
  })
}

if (supported) native.setEventListener(dispatch)

/** 返回取消订阅函数；页面销毁时必须调用。 */
export function on(event, callback) {
  rtcLogger.debug('API on', { event })
  if (typeof callback !== 'function') throw new TypeError('callback must be a function')
  if (!listeners.has(event)) listeners.set(event, new Set())
  listeners.get(event).add(callback)
  return () => off(event, callback)
}

export function off(event, callback) {
  rtcLogger.debug('API off', { event, scoped: Boolean(callback) })
  const callbacks = listeners.get(event)
  if (!callbacks) return
  if (callback) callbacks.delete(callback)
  else callbacks.clear()
  if (callbacks.size === 0) listeners.delete(event)
}

export function requestPermissions(options = {}) {
  assertSupported()
  const audio = options.audio !== false
  const video = options.video !== false
  return traceRtcApi('requestPermissions', { audio, video }, () => {
    if (!audio && !video) return true
    return new Promise((resolve) => native.requestPermissions({
      audio,
      video
    }, resolve))
  })
}

export async function requestPermissionsOrThrow(options = {}) {
  const granted = await requestPermissions(options)
  if (!granted) {
    throw new RtcError('摄像头或麦克风权限未授权，请在系统设置中允许后重试', {
      category: RTC_ERROR_CATEGORY.PERMISSION,
      operation: 'requestPermissions'
    })
  }
}

/** 打开 App 系统权限设置页，仅支持 App 平台。 */
export function openPermissionSettings() {
  assertSupported()
  return traceRtcApi('openPermissionSettings', undefined, () => new Promise((resolve, reject) => {
    if (typeof uni === 'undefined' || typeof uni.openAppAuthorizeSetting !== 'function') {
      reject(new RtcError('当前平台不支持打开权限设置', {
        category: RTC_ERROR_CATEGORY.STATE
      }))
      return
    }
    uni.openAppAuthorizeSetting({
      success: resolve,
      fail: reject
    })
  }))
}

function checkResult(code, operation) {
  if (Number(code) !== 0) throw createNativeError(code, operation)
}

/**
 * 创建或复用 Engine。
 * 同一 App ID 可重复初始化；切换 App ID 前必须 await destroy()。
 * 传入 owner 时会把所有权交给该 owner（通常是一个 RtcCallSession）。
 */
export async function initialize(appId, owner) {
  assertSupported()
  const normalizedAppId = String(appId || '').trim()
  if (!normalizedAppId) {
    throw new RtcError('App ID 不能为空', {
      category: RTC_ERROR_CATEGORY.PARAMETER
    })
  }
  return traceRtcApi('initialize', { appId: normalizedAppId, hasOwner: owner !== undefined }, () => enqueue(() => {
    if (initialized && currentAppId !== normalizedAppId) {
      throw new RtcError('App ID 已变更，请先调用 destroy()', {
        category: RTC_ERROR_CATEGORY.STATE
      })
    }
    checkResult(native.createRtcEngine(normalizedAppId), 'initialize')
    initialized = true
    currentAppId = normalizedAppId
    // 接管时作废旧入房，并清理已提交但可能迟到的原生连接。
    if (owner !== undefined) {
      const ownershipChanged = engineOwner !== owner
      engineOwner = owner
      if (ownershipChanged) cancelJoinForTakeover()
    }
  }))
}

/** 判断调用方是否仍是当前 Engine 的持有者；省略 owner 时按旧语义返回 true。 */
export function isEngineOwner(owner) {
  return owner === undefined || engineOwner === null || engineOwner === owner
}

function requireEngine(owner) {
  assertSupported()
  if (!initialized) {
    throw new RtcError('请先调用 initialize(appId)', {
      category: RTC_ERROR_CATEGORY.STATE,
      code: -1001
    })
  }
  if (!isEngineOwner(owner)) {
    throw new RtcError('RTC Engine 已被其他通话接管', {
      category: RTC_ERROR_CATEGORY.STATE,
      code: -1003
    })
  }
}

function normalizeVideoEncoderValue(value, defaultValue, field) {
  const normalized = value === undefined ? defaultValue : Number(value)
  if (!Number.isInteger(normalized) || normalized <= 0) {
    throw new RtcError(`${field} 必须是正整数`, {
      category: RTC_ERROR_CATEGORY.PARAMETER,
      operation: 'joinChannel'
    })
  }
  return normalized
}

function normalizeVideoFrameRate(value) {
  const normalized = value === undefined ? 24 : Number(value)
  if (!VIDEO_ENCODER_FRAME_RATES.includes(normalized)) {
    throw new RtcError('videoEncoderFrameRate 仅支持 1、7、10、15、24、30、60', {
      category: RTC_ERROR_CATEGORY.PARAMETER,
      operation: 'joinChannel'
    })
  }
  return normalized
}

function normalizeVideoOrientationMode(value) {
  const normalized = String(value === undefined ? 'adaptive' : value).trim().toLowerCase()
  if (!VIDEO_ORIENTATION_MODES.includes(normalized)) {
    throw new RtcError('videoOrientationMode 仅支持 adaptive、portrait、landscape', {
      category: RTC_ERROR_CATEGORY.PARAMETER,
      operation: 'joinChannel'
    })
  }
  return normalized
}

function normalizeJoinOptions(options) {
  if (!options || !String(options.channelName || '').trim()) {
    throw new RtcError('频道名不能为空', {
      category: RTC_ERROR_CATEGORY.PARAMETER
    })
  }
  const uid = Number(options.uid)
  if (!Number.isInteger(uid) || uid < 0 || uid > 2147483647) {
    throw new RtcError('uid 必须是 0 到 2147483647 的整数', {
      category: RTC_ERROR_CATEGORY.PARAMETER
    })
  }
  return {
    channelName: String(options.channelName).trim(),
    token: String(options.token || ''),
    uid,
    publishAudio: options.publishAudio !== false,
    publishVideo: options.publishVideo !== false,
    autoSubscribeAudio: options.autoSubscribeAudio !== false,
    autoSubscribeVideo: options.autoSubscribeVideo !== false,
    videoEncoderWidth: normalizeVideoEncoderValue(options.videoEncoderWidth, 960, 'videoEncoderWidth'),
    videoEncoderHeight: normalizeVideoEncoderValue(options.videoEncoderHeight, 540, 'videoEncoderHeight'),
    videoEncoderFrameRate: normalizeVideoFrameRate(options.videoEncoderFrameRate),
    videoOrientationMode: normalizeVideoOrientationMode(options.videoOrientationMode)
  }
}

function createJoinAttempt(options, owner, waiting) {
  if (activeJoinAttempt) {
    throw new RtcError('已有等待中的入房操作，请先退出或销毁当前通话', {
      category: RTC_ERROR_CATEGORY.STATE,
      operation: 'joinChannel'
    })
  }
  let resolve
  let reject
  const promise = waiting ? new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  }) : null
  // 提交阶段发生同步取消时，调用方尚未拿到 result；避免短暂的无处理拒绝。
  if (promise) promise.catch(() => {})
  const attempt = {
    options,
    owner,
    waiting,
    promise,
    resolve,
    reject,
    submitted: false,
    settled: false,
    timer: null,
    error: null
  }
  activeJoinAttempt = attempt
  return attempt
}

function succeedJoinAttempt(attempt, data) {
  if (!attempt || attempt.settled) return
  attempt.settled = true
  clearJoinTimer(attempt)
  if (activeJoinAttempt === attempt) activeJoinAttempt = null
  if (attempt.waiting) attempt.resolve(data)
}

function failJoinAttempt(attempt, error, shouldLeave = false) {
  if (!attempt || attempt.settled) return
  attempt.settled = true
  attempt.error = error
  clearJoinTimer(attempt)
  if (activeJoinAttempt === attempt) activeJoinAttempt = null
  // 先排队清理再 reject，确保随后发起的新入房不会越过这次 native leave。
  if (shouldLeave && attempt.submitted) requestLeaveChannel(attempt.owner, attempt).catch(() => {})
  if (attempt.waiting) attempt.reject(error)
}

function matchesJoinSuccess(attempt, data) {
  if (!attempt.submitted || String(data.channel || '') !== attempt.options.channelName) return false
  const uid = Number(data.uid)
  if (!Number.isInteger(uid) || uid < 0) return false
  // uid=0 表示由原生 SDK 分配，成功后以回调中的实际 uid 为准。
  return attempt.options.uid === 0 || attempt.options.uid === uid
}

function routeJoinEvent(event, data) {
  if (event === RTC_EVENT.LEAVE_CHANNEL) {
    // 每次成功提交的原生 leave 只消费一个回调；旧 leave 不得取消新 attempt。
    if (nativeLeaveRequests.length > 0) {
      nativeLeaveRequests.shift()
      return
    }
    if (activeJoinAttempt) {
      failJoinAttempt(activeJoinAttempt, new RtcError('入房操作已因离开频道而取消', {
        category: RTC_ERROR_CATEGORY.CANCELLED,
        operation: 'joinChannel'
      }))
    }
    return
  }
  const attempt = activeJoinAttempt
  if (!attempt || attempt.settled) return
  if (event === RTC_EVENT.JOIN_CHANNEL_SUCCESS) {
    if (matchesJoinSuccess(attempt, data)) succeedJoinAttempt(attempt, data)
    return
  }
  if (event === RTC_EVENT.JOIN_CHANNEL_TIMEOUT) {
    failJoinAttempt(attempt, new RtcError('加入频道超时，请检查网络或 Token', {
      category: RTC_ERROR_CATEGORY.TIMEOUT,
      operation: 'joinChannel',
      code: data.timeout
    }), true)
    return
  }
  if (event === RTC_EVENT.CONNECTION_STATE_CHANGED && Number(data.state) === RTC_CONNECTION_STATE.FAILED) {
    failJoinAttempt(attempt, createConnectionError(data), true)
    return
  }
  if (event === RTC_EVENT.ERROR) {
    const code = Number(data.code)
    if ([101, 109, 110].includes(code)) {
      failJoinAttempt(attempt, new RtcError(rtcErrorMessage(code), {
        category: RTC_ERROR_CATEGORY.AUTH,
        code,
        operation: 'joinChannel'
      }), true)
    }
  }
}

function submitJoinAttempt(attempt) {
  return traceRtcApi('joinChannel', attempt.options, () => enqueue(() => {
    // 等待设备操作或退出期间，attempt 可能已取消，不能再提交原生入房。
    if (attempt.settled || activeJoinAttempt !== attempt) return false
    requireEngine(attempt.owner)
    // 先标记再调用，兼容原生同步回调；返回非零时立即回滚。
    attempt.submitted = true
    try {
      checkResult(native.joinChannel(attempt.options), 'joinChannel')
    } catch (error) {
      attempt.submitted = false
      throw error
    }
    if (!attempt.settled && activeJoinAttempt === attempt) {
      attempt.timer = setTimeout(() => {
        // 已清除但进入任务队列的旧 timeout 仍可能执行，必须校验 attempt 身份。
        if (activeJoinAttempt !== attempt || attempt.settled || !attempt.submitted) return
        attempt.timer = null
        dispatch(RTC_EVENT.JOIN_CHANNEL_TIMEOUT, {
          timeout: JOIN_TIMEOUT_MS
        })
      }, JOIN_TIMEOUT_MS)
    }
    return true
  }))
}

function invokeNativeLeave() {
  const request = {}
  nativeLeaveRequests.push(request)
  try {
    checkResult(native.leaveChannel(), 'leaveChannel')
  } catch (error) {
    const index = nativeLeaveRequests.indexOf(request)
    if (index >= 0) nativeLeaveRequests.splice(index, 1)
    throw error
  }
}

async function requestLeaveChannel(owner, targetAttempt) {
  requireEngine()
  // 非持有者不再操作共享 Engine，避免旧页面把新页面的通话退出。
  if (!isEngineOwner(owner)) return
  if (targetAttempt && activeJoinAttempt === targetAttempt) {
    failJoinAttempt(targetAttempt, new RtcError('入房操作已因退出频道而取消', {
      category: RTC_ERROR_CATEGORY.CANCELLED,
      operation: 'joinChannel'
    }))
  }
  return traceRtcApi('leaveChannel', { hasOwner: owner !== undefined }, () => enqueue(() => {
    requireEngine()
    if (!isEngineOwner(owner)) return
    invokeNativeLeave()
  }))
}

function cancelJoinForTakeover() {
  const attempt = activeJoinAttempt
  if (!attempt) return
  failJoinAttempt(attempt, new RtcError('入房操作已因 Engine 所有权变更而取消', {
    category: RTC_ERROR_CATEGORY.CANCELLED,
    operation: 'joinChannel'
  }))
  // 旧 owner 已无权调用公开 leave，但接管方必须清理旧 attempt 的迟到连接。
  if (attempt.submitted) invokeNativeLeave()
}

/** Promise 成功只表示原生入房请求已提交；需要等待入房结果请使用 joinChannelAndWait。 */
export async function joinChannel(options, owner) {
  requireEngine(owner)
  const normalized = normalizeJoinOptions(options)
  const attempt = createJoinAttempt(normalized, owner, false)
  let submitted
  try {
    submitted = await submitJoinAttempt(attempt)
  } catch (error) {
    failJoinAttempt(attempt, error)
    throw error
  }
  if (!submitted) {
    throw attempt.error || new RtcError('入房操作已取消', {
      category: RTC_ERROR_CATEGORY.CANCELLED,
      operation: 'joinChannel'
    })
  }
}

/**
 * 提交入房并等待真实结果。
 *
 * - resolve：收到与本次 channel/uid 匹配的 joinChannelSuccess，返回该事件数据。
 * - reject：鉴权失败、连接失败、15 秒超时、主动离开、所有权变化或销毁取消。
 * - 鉴权/连接失败和超时会主动 leaveChannel()，清理可能残留的半连接状态。
 *
 * 注意：joinChannel() 的 Promise 成功只代表原生返回 0，不能替代本方法。
 */
async function joinChannelAndWaitInternal(options, owner) {
  requireEngine(owner)
  const normalized = normalizeJoinOptions(options)
  const attempt = createJoinAttempt(normalized, owner, true)
  try {
    await submitJoinAttempt(attempt)
  } catch (error) {
    failJoinAttempt(attempt, error)
  }
  return attempt.promise
}

export function joinChannelAndWait(options, owner) {
  return traceRtcApi('joinChannelAndWait', options, () => joinChannelAndWaitInternal(options, owner))
}

/** 离开频道，并只取消调用时属于当前 owner 的入房 attempt。 */
export async function leaveChannel(owner) {
  const attempt = activeJoinAttempt
  const targetAttempt = attempt && (owner === undefined || attempt.owner === undefined || attempt.owner === owner) ?
    attempt :
    null
  return requestLeaveChannel(owner, targetAttempt)
}

function enqueueEngineCall(operation, invoke, owner, details = {}) {
  requireEngine(owner)
  return traceRtcApi(operation, { ...details, hasOwner: owner !== undefined }, () => enqueue(() => {
    // 等待队列期间所有权可能已经变化，执行原生调用前必须再次检查。
    requireEngine(owner)
    checkResult(invoke(), operation)
  }))
}

export async function startPreview(owner) {
  return enqueueEngineCall('startPreview', () => native.startPreview(), owner)
}

export async function stopPreview(owner) {
  return enqueueEngineCall('stopPreview', () => native.stopPreview(), owner)
}

export async function enableLocalAudio(enabled, owner) {
  return enqueueEngineCall('enableLocalAudio', () => native.enableLocalAudio(Boolean(enabled)), owner, { enabled: Boolean(enabled) })
}

export async function enableLocalVideo(enabled, owner) {
  return enqueueEngineCall('enableLocalVideo', () => native.enableLocalVideo(Boolean(enabled)), owner, { enabled: Boolean(enabled) })
}

export async function muteLocalAudio(muted, owner) {
  return enqueueEngineCall('muteLocalAudioStream', () => native.muteLocalAudioStream(Boolean(muted)), owner, { muted: Boolean(muted) })
}

export async function muteLocalVideo(muted, owner) {
  return enqueueEngineCall('muteLocalVideoStream', () => native.muteLocalVideoStream(Boolean(muted)), owner, { muted: Boolean(muted) })
}

export async function switchCamera(owner) {
  return enqueueEngineCall('switchCamera', () => native.switchCamera(), owner)
}

/** 扬声器与听筒切换；实际音频路由仍可能受蓝牙/有线耳机和系统策略影响。 */
export async function setSpeakerphoneEnabled(enabled, owner) {
  return enqueueEngineCall('setEnableSpeakerphone', () => native.setEnableSpeakerphone(Boolean(enabled)), owner, {
    enabled: Boolean(enabled)
  })
}

/**
 * 销毁当前 Engine。
 *
 * - 传入 owner 时只允许持有者销毁；旧 Session 的延迟销毁不会影响新 Session。
 * - 不调用 off() 清空 JS 监听器：旧页面异步销毁时，不能误删新页面/新 Session 的订阅。
 * - Session 自己负责退订；此处只恢复原生单监听器并等待队列中的旧操作完成。
 */
export async function destroy(owner) {
  if (!isEngineOwner(owner)) return
  if (activeJoinAttempt && (owner === undefined || activeJoinAttempt.owner === undefined || activeJoinAttempt.owner === owner)) {
    failJoinAttempt(activeJoinAttempt, new RtcError('入房操作已因 Engine 销毁而取消', {
      category: RTC_ERROR_CATEGORY.CANCELLED,
      operation: 'joinChannel'
    }))
  }
  return traceRtcApi('destroy', { hasOwner: owner !== undefined }, () => enqueue(() => {
    // 入队期间可能已有新 Session 接管 Engine，必须再次确认所有权。
    if (!isEngineOwner(owner)) return
    try {
      if (supported) native.destroyRtcEngine()
    } finally {
      // 即使原生销毁异常，也不能让 JS 永远保留一个实际已失效的 Engine 状态。
      initialized = false
      currentAppId = ''
      engineOwner = null
      if (supported) native.setEventListener(dispatch)
    }
  }))
}

export * from './rtc-constants.js'
export * from './rtc-errors.js'
export * from './rtc-logger.js'
