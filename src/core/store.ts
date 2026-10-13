import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/**
 * 一个小 JSON 文件的读写：先写临时文件再改名（写到一半被杀进程也不留半截 JSON）。
 * 读不到 / 坏掉返回 undefined，由调用方决定退回什么默认值。
 */
export function readJson<T>(file: string): T | undefined {
  try {
    const raw = readFileSync(file, 'utf8')
    return raw.trim() ? (JSON.parse(raw) as T) : undefined
  } catch {
    return undefined
  }
}

export function writeJsonAtomic(file: string, value: unknown): void {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 })
  renameSync(tmp, file)
}

/** 服务的本地改动（覆盖默认值）：开关、本机端口。 */
export interface ServiceOverride {
  enabled?: boolean
  localPort?: number
}

/**
 * 界面上改过的「开关 / 本机端口」，键是服务在 NAS 上的端口（改显示名不该把状态弄丢）。
 * 落盘失败时不改内存：否则界面显示「已保存」、重启后却回到旧值，是最难查的一类不一致。
 */
export class ServiceOverrideStore {
  private data: Record<string, ServiceOverride>

  constructor(private readonly file: string) {
    this.data = readJson<{ services?: Record<string, ServiceOverride> }>(file)?.services ?? {}
  }

  get(nasPort: number): ServiceOverride {
    return { ...this.data[String(nasPort)] }
  }

  set(nasPort: number, patch: ServiceOverride): void {
    const key = String(nasPort)
    const next = { ...this.data, [key]: { ...this.data[key], ...patch } }
    writeJsonAtomic(this.file, { services: next })
    this.data = next
  }
}
