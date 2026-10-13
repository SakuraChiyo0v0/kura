/**
 * 连接核心用的最小日志接口。
 *
 * 核心不依赖 Electron，也不决定日志落到哪里：主进程注入写文件的实现，测试注入收集器。
 * fields 用中文键名也没关系，和 Go 版 slog 的写法保持一致，方便对照日志。
 */
export type LogFields = Record<string, unknown>

export interface Logger {
  debug(message: string, fields?: LogFields): void
  info(message: string, fields?: LogFields): void
  warn(message: string, fields?: LogFields): void
  error(message: string, fields?: LogFields): void
}

export const silentLogger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
}

function format(level: string, message: string, fields?: LogFields): string {
  const time = new Date().toISOString()
  const extra = fields
    ? ' ' +
      Object.entries(fields)
        .map(([key, value]) => `${key}=${typeof value === 'string' ? JSON.stringify(value) : String(value)}`)
        .join(' ')
    : ''
  return `${time} ${level} ${message}${extra}`
}

/** 写到 console；verbose 为假时不打 debug。 */
export function consoleLogger(verbose = false): Logger {
  return {
    debug: (m, f) => {
      if (verbose) console.debug(format('DEBUG', m, f))
    },
    info: (m, f) => console.info(format('INFO', m, f)),
    warn: (m, f) => console.warn(format('WARN', m, f)),
    error: (m, f) => console.error(format('ERROR', m, f)),
  }
}

/** 测试用：把日志收进数组，便于断言「打了什么级别的什么话」。 */
export interface CapturedLog {
  level: 'debug' | 'info' | 'warn' | 'error'
  message: string
  fields?: LogFields
}

export function captureLogger(): Logger & { entries: CapturedLog[] } {
  const entries: CapturedLog[] = []
  const push = (level: CapturedLog['level']) => (message: string, fields?: LogFields) => {
    entries.push({ level, message, fields })
  }
  return { entries, debug: push('debug'), info: push('info'), warn: push('warn'), error: push('error') }
}
