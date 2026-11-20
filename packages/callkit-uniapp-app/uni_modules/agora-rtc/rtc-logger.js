/**
 * App 本地 RTC 诊断日志。
 *
 * 文件固定为应用私有文档目录下的 easemob-rtc.log。所有写入串行执行，避免
 * plus.io FileWriter 并发追加相互覆盖。文件达到 2 MB 后先清空再写入，
 * 保留最新一段诊断信息，避免长时间运行无限增长。日志失败只降级到 console，
 * 不能影响 RTC。Token 只记录是否存在和长度，App ID 只保留前后少量字符。
 */
export const RTC_LOG_FILE_NAME = 'easemob-rtc.log'
export const RTC_LOG_MAX_BYTES = 2 * 1024 * 1024

let sequence = 0
let loggingEnabled = true
let writeQueue = Promise.resolve()
let fileEntry = null
let fileError = null
let initializePromise = null
let cachedLogPath = ''

// 页面销毁/运行环境重建期间 plus 桥可能瞬间不可用（iOS 上表现为 plus.weexBridge.exec 不再是函数）。
// 写文件失败时短暂退避，避免刷屏、无意义重试和未处理异常；RTC 本身不受影响。
const BRIDGE_RETRY_COOLDOWN_MS = 5000
const FILE_ERROR_WARN_INTERVAL_MS = 10000
let bridgeRetryAt = 0
let lastFileErrorWarnAt = 0

function maskAppId(value) {
  const text = String(value || '')
  if (text.length <= 8) return text ? `${text.slice(0, 2)}***` : ''
  return `${text.slice(0, 4)}***${text.slice(-4)}`
}

/** 深度脱敏并限制体积；error 同时保留 category/code/reason/operation。 */
function sanitize(value, depth = 0) {
  if (value === null || value === undefined) return value
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      category: value.category,
      code: value.code,
      reason: value.reason,
      operation: value.operation,
      stack: value.stack
    }
  }
  if (typeof value === 'function') return '[Function]'
  if (typeof value !== 'object') return value
  if (depth > 4) return '[MaxDepth]'
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => sanitize(item, depth + 1))
  const output = {}
  Object.keys(value).slice(0, 80).forEach((key) => {
    const item = value[key]
    if (/^(token|accessToken|appCertificate|certificate|password|secret)$/i.test(key)) {
      output[key] = item ? `[REDACTED:length=${String(item).length}]` : '[EMPTY]'
    } else if (/^appId$/i.test(key)) {
      output[key] = maskAppId(item)
    } else {
      output[key] = sanitize(item, depth + 1)
    }
  })
  return output
}

function safeStringify(value) {
  try {
    return JSON.stringify(sanitize(value))
  } catch (error) {
    return JSON.stringify({ message: '日志参数序列化失败', detail: String(error) })
  }
}

function consoleWrite(level, line) {
  const method = level === 'ERROR' ? 'error' : level === 'WARN' ? 'warn' : 'log'
  if (typeof console !== 'undefined' && console[method]) console[method](line)
}

function isAppPlus() {
  // #ifdef APP-PLUS
  return typeof plus !== 'undefined' && plus.io
  // #endif
  return false
}

/** iOS 页面销毁后 plus.io 仍在，但内部 plus.weexBridge 已被置空；这类错误只退避，不当作异常上报。 */
function isBridgeUnavailableError(error) {
  const message = String((error && (error.message || error.errMsg)) || error || '')
  return /weexBridge/i.test(message) || /exec is not a function/i.test(message)
}

function handleFileError(error) {
  fileError = error
  if (isBridgeUnavailableError(error)) {
    // 让下一次写入重新初始化文件，并把文件日志暂停到冷却期结束。
    initializePromise = null
    fileEntry = null
    bridgeRetryAt = Date.now() + BRIDGE_RETRY_COOLDOWN_MS
    return
  }
  const now = Date.now()
  if (now - lastFileErrorWarnAt < FILE_ERROR_WARN_INTERVAL_MS) return
  lastFileErrorWarnAt = now
  if (typeof console !== 'undefined' && console.warn) console.warn('[agora-rtc] 日志写入失败', error)
}

function initializeFile() {
  if (!isAppPlus()) return Promise.resolve(null)
  if (fileEntry) return Promise.resolve(fileEntry)
  if (initializePromise) return initializePromise
  initializePromise = new Promise((resolve) => {
    try {
      plus.io.resolveLocalFileSystemURL('_doc/', (directory) => {
        directory.getFile(RTC_LOG_FILE_NAME, { create: true, exclusive: false }, (entry) => {
          fileEntry = entry
          fileError = null
          cachedLogPath = entry.fullPath || `_doc/${RTC_LOG_FILE_NAME}`
          resolve(entry)
        }, (error) => {
          handleFileError(error)
          resolve(null)
        })
      }, (error) => {
        handleFileError(error)
        resolve(null)
      })
    } catch (error) {
      // 桥接已销毁时 plus.io 调用可能同步抛错，退避而不是让队列中断。
      handleFileError(error)
      resolve(null)
    }
  })
  return initializePromise
}

function utf8ByteLength(value) {
  const text = String(value)
  let bytes = 0
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index)
    if (code < 0x80) bytes += 1
    else if (code < 0x800) bytes += 2
    else if (code >= 0xd800 && code <= 0xdbff && index + 1 < text.length) {
      const next = text.charCodeAt(index + 1)
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4
        index += 1
      } else bytes += 3
    } else bytes += 3
  }
  return bytes
}

function truncateWriter(writer) {
  return new Promise((resolve, reject) => {
    writer.onwrite = () => resolve()
    writer.onerror = reject
    writer.truncate(0)
  })
}

function appendLine(entry, line) {
  return new Promise((resolve) => {
    if (!entry) {
      resolve(false)
      return
    }
    try {
      entry.createWriter(async (writer) => {
        let completed = false
        writer.onerror = (error) => {
          if (completed) return
          completed = true
          fileError = error
          resolve(false)
        }
        try {
          let content = `${line}\n`
          if (utf8ByteLength(content) > RTC_LOG_MAX_BYTES) {
            content = '[agora-rtc] 单条日志超过文件上限，文件内已省略该行，请查看 console。\n'
          }
          // 达到上限时整文件覆盖，而不是环形写入半行，保证每行都可独立检索。
          if (writer.length > 0 && writer.length + utf8ByteLength(content) > RTC_LOG_MAX_BYTES) {
            const appendErrorHandler = writer.onerror
            try {
              await truncateWriter(writer)
            } finally {
              // truncateWriter 的 Promise 已 settle；追加写失败必须仍由 appendLine 处理。
              writer.onerror = appendErrorHandler
            }
          }
          writer.onwrite = () => {
            if (completed) return
            completed = true
            resolve(true)
          }
          writer.seek(writer.length)
          writer.write(content)
        } catch (error) {
          if (completed) return
          completed = true
          fileError = error
          resolve(false)
        }
      }, (error) => {
        fileError = error
        resolve(false)
      })
    } catch (error) {
      // 页面销毁后 createWriter 可能直接抛“plus.weexBridge.exec is not a function”。
      fileError = error
      resolve(false)
    }
  })
}

function write(level, message, data) {
  if (!loggingEnabled) return ''
  sequence += 1
  const id = `rtc-${Date.now()}-${sequence}`
  const suffix = data === undefined ? '' : ` ${safeStringify(data)}`
  const line = `${new Date().toISOString()} [${level}] [${id}] ${message}${suffix}`
  // 非 App 或无权限时至少保留控制台诊断；App 同时写文件。
  consoleWrite(level, line)
  if (isAppPlus() && Date.now() >= bridgeRetryAt) {
    writeQueue = writeQueue.then(async () => {
      // 排队期间可能已进入页面销毁阶段，桥接不可用就只保留 console。
      if (Date.now() < bridgeRetryAt) return
      const entry = await initializeFile()
      if (Date.now() < bridgeRetryAt) return
      const written = await appendLine(entry, line)
      if (!written && fileError) handleFileError(fileError)
    }).catch((error) => {
      handleFileError(error)
    })
  }
  return id
}

export const rtcLogger = {
  debug(message, data) {
    return write('DEBUG', message, data)
  },
  info(message, data) {
    return write('INFO', message, data)
  },
  warn(message, data) {
    return write('WARN', message, data)
  },
  error(message, data) {
    return write('ERROR', message, data)
  }
}

/** 给一次 API 调用生成统一 ID，成功和失败使用相同 ID，便于直接 grep。 */
export function traceRtcApi(operation, details, invoke) {
  const startedAt = Date.now()
  const callId = rtcLogger.debug(`API ${operation} START`, details)
  return Promise.resolve().then(invoke).then((result) => {
    rtcLogger.debug(`API ${operation} SUCCESS`, {
      callId,
      durationMs: Date.now() - startedAt,
      result: result === undefined ? { code: 0 } : result
    })
    return result
  }, (error) => {
    rtcLogger.error(`API ${operation} ERROR`, {
      callId,
      durationMs: Date.now() - startedAt,
      error
    })
    throw error
  })
}

/** 等待当前已排队日志落盘，不阻塞 RTC 操作本身。 */
export function flushRtcLogs() {
  return writeQueue
}

export function getRtcLogFilePath() {
  if (isAppPlus() && !initializePromise) initializeFile()
  return cachedLogPath || `_doc/${RTC_LOG_FILE_NAME}`
}

export function setRtcLoggingEnabled(enabled) {
  loggingEnabled = Boolean(enabled)
}

export function clearRtcLogs() {
  if (!isAppPlus()) return Promise.resolve()
  writeQueue = writeQueue.then(async () => {
    const entry = await initializeFile()
    if (!entry) throw fileError || new Error('无法打开 RTC 日志文件')
    await new Promise((resolve, reject) => {
      entry.createWriter((writer) => {
        writer.onwrite = resolve
        writer.onerror = reject
        writer.truncate(0)
      }, reject)
    })
  })
  return writeQueue
}
