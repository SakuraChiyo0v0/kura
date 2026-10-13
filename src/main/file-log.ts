import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs'
import { dirname } from 'node:path'
import type { LogFields, Logger } from '../core/log.js'

/** 单个日志文件上限，超过就轮转成 .1（与 Go 版一致：10 MiB）。 */
export const logMaxBytes = 10 * 1024 * 1024

function line(level: string, message: string, fields?: LogFields): string {
  const extra = fields
    ? ' ' +
      Object.entries(fields)
        .map(([key, value]) => `${key}=${typeof value === 'string' ? JSON.stringify(value) : String(value)}`)
        .join(' ')
    : ''
  return `${new Date().toISOString()} ${level} ${message}${extra}\n`
}

/**
 * 落盘日志，同时打到控制台。同步追加：日志量小，换来的是进程崩溃前最后几行一定在文件里。
 * 写失败只放弃这一行，不能让日志拖垮映射。
 */
export function fileLogger(file: string, verbose = false): Logger {
  mkdirSync(dirname(file), { recursive: true })
  let size = 0
  try {
    size = statSync(file).size
  } catch {
    // 新文件
  }
  const write = (level: string, message: string, fields?: LogFields) => {
    const text = line(level, message, fields)
    if (level === 'ERROR' || level === 'WARN') console.warn(text.trimEnd())
    else if (verbose || level !== 'DEBUG') console.log(text.trimEnd())
    if (level === 'DEBUG' && !verbose) return
    try {
      if (size + text.length > logMaxBytes) {
        renameSync(file, `${file}.1`)
        size = 0
      }
      appendFileSync(file, text)
      size += Buffer.byteLength(text)
    } catch {
      // 放弃这一行
    }
  }
  return {
    debug: (m, f) => write('DEBUG', m, f),
    info: (m, f) => write('INFO', m, f),
    warn: (m, f) => write('WARN', m, f),
    error: (m, f) => write('ERROR', m, f),
  }
}
