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

/**
 * 把控制字符（含 `\r` / `\n`）转成可见转义，其余原样。日志里不少 message 来自 NAS / 网关的响应，
 * 是不可信输入；原样拼进去的话，一个带 `\r\n` 的错误信息就能伪造出整行假日志，排查时直接误导。
 * 只动控制字符、不加引号 —— 正常日志行的形状不变。键名同样处理（键也是外部来的）。
 */
function escape(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\u0000-\u001f\u007f]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`)
}

function format(level: string, message: string, fields?: LogFields): string {
  const time = new Date().toISOString()
  const extra = fields
    ? ' ' +
      Object.entries(fields)
        .map(([key, value]) => `${escape(key)}=${typeof value === 'string' ? JSON.stringify(value) : String(value)}`)
        .join(' ')
    : ''
  return `${time} ${level} ${escape(message)}${extra}`
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
