import {
  RTC_ERROR_CATEGORY
} from './rtc-constants.js'

const NATIVE_ERROR_MESSAGES = {
  '-2': '参数无效',
  '-17': '加入频道被拒绝，请退出残留连接后重试',
  '-1001': 'RTC 引擎尚未创建，请先初始化',
  '-1002': 'App ID 已变更，请先释放引擎后重新初始化',
  '101': 'App ID 无效',
  '109': 'Token 已过期，请重新生成',
  '110': 'Token 无效；启用 App Certificate 时不能为空'
}

const CONNECTION_REASON_MESSAGES = {
  6: 'App ID 无效',
  7: '频道名无效',
  8: 'Token 无效或未填写，请生成与频道和 UID 匹配的临时 Token',
  9: 'Token 已过期，请重新生成',
  10: '服务器拒绝连接，请检查 Token 和声网项目配置'
}

/**
 * 插件统一错误对象。
 * category 用于 UI 分支（权限设置、Token 刷新、网络重试等），code/reason 保留原生诊断信息；
 * operation 标识失败步骤，cause 可选保留原始异常；userMessage 是可直接展示给终端用户的文案。
 * 日志中不要附加完整 Token。
 */
export class RtcError extends Error {
  constructor(message, {
    category = RTC_ERROR_CATEGORY.NATIVE,
    code,
    operation,
    reason,
    cause,
    userMessage
  } = {}) {
    super(message)
    this.name = 'RtcError'
    this.category = category
    this.userMessage = userMessage || message
    if (code !== undefined) this.code = Number(code)
    if (operation) this.operation = operation
    if (reason !== undefined) this.reason = Number(reason)
    if (cause !== undefined) this.cause = cause
  }
}

export function nativeErrorHint(code) {
  return NATIVE_ERROR_MESSAGES[Number(code)] || ''
}

export function rtcErrorMessage(code) {
  const nativeCode = Number(code)
  return NATIVE_ERROR_MESSAGES[nativeCode] || `RTC 错误 ${nativeCode}`
}

export function connectionErrorMessage(reason) {
  const nativeReason = Number(reason)
  return CONNECTION_REASON_MESSAGES[nativeReason] || `连接失败（reason: ${nativeReason}）`
}

/** 将双端数字返回码归一为稳定的业务类别，页面无需分别判断 Android/iOS 错误码。 */
export function categorizeNativeError(code, operation = '') {
  const nativeCode = Number(code)
  if (nativeCode === -2) return RTC_ERROR_CATEGORY.PARAMETER
  if ([-1001, -1002, -17].includes(nativeCode)) return RTC_ERROR_CATEGORY.STATE
  if ([101, 109, 110].includes(nativeCode)) return RTC_ERROR_CATEGORY.AUTH
  if (/Video|Preview|Camera|Audio/i.test(operation)) return RTC_ERROR_CATEGORY.DEVICE
  return RTC_ERROR_CATEGORY.SERVICE
}

/** connectionStateChanged(FAILED) 到 RtcError 的集中映射，优先识别鉴权与参数问题。 */
export function createConnectionError(data = {}) {
  const reason = Number(data.reason)
  const category = reason === 7 ?
    RTC_ERROR_CATEGORY.PARAMETER :
    [6, 8, 9, 10].includes(reason) ?
    RTC_ERROR_CATEGORY.AUTH :
    RTC_ERROR_CATEGORY.NETWORK
  return new RtcError(connectionErrorMessage(reason), {
    category,
    reason,
    operation: 'joinChannel',
    userMessage: connectionErrorMessage(reason)
  })
}

export function createNativeError(code, operation) {
  const nativeCode = Number(code)
  const hint = nativeErrorHint(nativeCode)
  return new RtcError(`${operation} failed, native code: ${nativeCode}${hint ? `（${hint}）` : ''}`, {
    category: categorizeNativeError(nativeCode, operation),
    code: nativeCode,
    operation,
    userMessage: hint || '音视频操作失败，请稍后重试'
  })
}
