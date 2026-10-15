import { appendFileSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'

/**
 * 终端审计：每次会话开关、每条 exec 记一行 JSON。
 *
 * 终端能拿宿主 root（`privileged + pid:host`），「谁、什么时候、执行了什么」必须留痕。
 * 一行一个 JSON（`.jsonl`），方便直接 `tail` 和机器处理；文件本身不轮转（宿主侧 rotate 更合适，
 * 这条数据面不归容器管）。
 */
export interface AuditEntry {
  at: string
  /** 会话 id 或 exec id */
  id: string
  /** 登录 kura-server 的用户名 */
  user: string
  /** 终端：pty-open / pty-close / exec；容器管理：docker-*（见 server/src/docker/handler.ts） */
  action: 'pty-open' | 'pty-close' | 'exec' | `docker-${string}`
  /** exec 的命令；pty-open 是 shell 名 */
  detail: string
  exitCode?: number
  durationMs?: number
  /** 来源 IP */
  ip?: string
}

export class AuditLog {
  constructor(private readonly file: string | undefined) {
    if (file) {
      try {
        mkdirSync(dirname(file), { recursive: true })
      } catch {
        // 目录建不了就让 append 时报错，不在这里崩
      }
    }
  }

  write(entry: AuditEntry): void {
    if (!this.file) return
    try {
      appendFileSync(this.file, JSON.stringify(entry) + '\n')
    } catch {
      // 审计写不进去不能拖垮会话；真要追责，宿主上的日志更权威
    }
  }

  /** 管理页「最近审计」用：读最后 n 条。 */
  tail(limit: number): AuditEntry[] {
    if (!this.file) return []
    try {
      const lines = readFileSync(this.file, 'utf8').trim().split('\n').filter(Boolean)
      return lines
        .slice(-limit)
        .map((line) => {
          try {
            return JSON.parse(line) as AuditEntry
          } catch {
            return null
          }
        })
        .filter((entry): entry is AuditEntry => entry !== null)
    } catch {
      return []
    }
  }
}
