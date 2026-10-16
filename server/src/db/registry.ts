import { readFileSync } from 'node:fs'
import { writeJsonAtomic, readJson } from '../../../src/core/store.js'
import { engineOfImage, type DbEngine } from '../../../src/core/db-types.js'
import { checkProjectName } from '../docker/compose.js'
import type { DockerEngine, RawContainer, RawInspect } from '../docker/engine.js'

/**
 * 数据库登记表（`state/databases.json`）。
 *
 * 两个职责：
 * 1. **隧道与服务端校验的唯一目标来源**。隧道接口只接受登记名，不接 host/port —— 白名单只有这一处。
 * 2. 记下 Kura 自己装的项目（Kura 装的、名字、目录），好在界面上区分「Kura 装的」与「接管来的」。
 *
 * **不存密码**：密码的唯一真相在项目目录的 `.env` 里（数据库容器自己启动时就要读它）。
 * 这里再存一份必然出现「.env 改了、Kura 还显示旧密码」的不一致 —— 那是 NasScopeService
 * 「范围只有一份、在 NAS 上」那次踩过的同一类坑。
 */

export interface DatabaseEntry {
  name: string
  engine: DbEngine
  /** 容器名（隧道按它在共享网络上解析；不用 IP —— 重启后 IP 会变） */
  container: string
  /** 容器内端口 */
  port: number
  user: string
  database: string
  /** 项目目录（宿主原路径）；接管的容器为空 */
  dir: string
  /** Kura 是不是自己装了它（false = 接管的已有容器） */
  managed: boolean
  createdAt: string
}

/** 磁盘上的形状；版本号留着以后迁移。 */
interface RegistryFile {
  version: 1
  databases: DatabaseEntry[]
}

export class DatabaseRegistry {
  private entries: DatabaseEntry[] = []

  constructor(private readonly file: string | undefined) {
    const doc = file ? readJson<RegistryFile>(file) : undefined
    if (doc?.databases) this.entries = doc.databases.filter((e) => e && typeof e.name === 'string')
  }

  list(): DatabaseEntry[] {
    return [...this.entries].sort((a, b) => a.name.localeCompare(b.name))
  }

  find(name: string): DatabaseEntry | undefined {
    return this.entries.find((e) => e.name === name)
  }

  private write(): void {
    if (!this.file) throw new Error('没有配置数据库登记表路径')
    writeJsonAtomic(this.file, { version: 1, databases: this.entries } satisfies RegistryFile)
  }

  add(entry: DatabaseEntry): void {
    if (this.find(entry.name)) throw Object.assign(new Error(`已经有一个叫「${entry.name}」的数据库`), { status: 409 })
    this.entries = [...this.entries, entry]
    this.write()
  }

  remove(name: string): void {
    this.entries = this.entries.filter((e) => e.name !== name)
    this.write()
  }
}

/** 登记表为空时（没人用过这功能）—— 隧道一律拒绝，NAS 上零暴露面。 */
export function isEmpty(registry: DatabaseRegistry): boolean {
  return registry.list().length === 0
}

/**
 * 把一个容器认成一个数据库。**只认镜像名**，不做模糊匹配 —— 宁可漏判（列成"其它容器"），
 * 也不要把不认识的东西当成数据库去连。
 */
export function engineOfContainer(raw: Pick<RawContainer, 'Image'>): DbEngine | '' {
  return engineOfImage(raw.Image)
}

/**
 * 从容器实际配置里推断用户 / 库名；端口由调用方从容器列表的 Ports 里给（更准）。
 *
 * **端口必须从容器读，不能按引擎硬编码**：NAS 上的 sakura-pg 是 postgres:18 跑在 5444，不是 5432
 * （docs/参考/nas-mirror/设计方案.md）。硬编码会连到错误的端口。
 */
export function deriveConnection(raw: Pick<RawInspect, 'Config'>, engine: DbEngine, fallbackPort: number): { port: number; user: string; database: string } {
  const env = new Map<string, string>()
  for (const line of raw.Config?.Env ?? []) {
    const at = line.indexOf('=')
    if (at > 0) env.set(line.slice(0, at), line.slice(at + 1))
  }
  const pick = (...keys: string[]): string => keys.map((k) => env.get(k) ?? '').find((v) => v) ?? ''
  switch (engine) {
    case 'postgres':
      return { port: fallbackPort, user: pick('POSTGRES_USER') || 'postgres', database: pick('POSTGRES_DB') || 'postgres' }
    case 'mysql':
    case 'mariadb':
      return { port: fallbackPort, user: pick('MYSQL_USER', 'MARIADB_USER') || 'root', database: pick('MYSQL_DATABASE', 'MARIADB_DATABASE') }
    case 'redis':
      return { port: fallbackPort, user: '', database: '' }
  }
}

/**
 * 容器上数据库监听的端口：优先用容器声明的私有端口（`docker ps` 那一列），
 * 没有就退回镜像默认。**不看发布端口** —— 隧道连的是容器网络里的端口，不是宿主端口。
 */
export function containerDbPort(raw: Pick<RawContainer, 'Ports'>, engine: DbEngine): number {
  const ports = (raw.Ports ?? []).map((p) => p.PrivatePort).filter((n): n is number => Number.isFinite(n) && (n ?? 0) > 0)
  // 同引擎的默认端口优先（避免把 8080 之类的辅助端口当成数据库端口）
  const preferred = defaultPort(engine)
  if (ports.includes(preferred)) return preferred
  return ports[0] ?? preferred
}

export function defaultPort(engine: DbEngine): number {
  switch (engine) {
    case 'postgres':
      return 5432
    case 'mysql':
    case 'mariadb':
      return 3306
    case 'redis':
      return 6379
  }
}

/**
 * 扫已有容器，认出哪些是数据库。**接管的容器不被登记**（不写盘）——
 * 它们由 Docker 自己存在，Kura 只在内存里把它们和登记项合并展示。
 * 这样「绿联商店装的、用户手动起的」数据库也能列出来、能给连接信息、能开隧道，
 * 但 Kura 不会去改它们的 compose（商店升级会覆盖）。
 *
 * 注意「能开隧道」有个前提：**登记表非空**（`TunnelService.targetOf()` 里的闸门）。
 * 登记表为空时一律拒绝 —— 那种情况下没人用过这功能，NAS 上应当零暴露面。
 *
 * 登记项优先（名字、用户、库名以登记为准）；容器提供实时状态与端口。
 */
export async function discoverDatabases(engine: DockerEngine, registry: DatabaseRegistry): Promise<DatabaseEntry[]> {
  const raw = await engine.listContainers()
  const byName = new Map<string, RawContainer>()
  for (const container of raw) {
    byName.set((container.Names?.[0] ?? container.Id.slice(0, 12)).replace(/^\//, ''), container)
  }
  const out: DatabaseEntry[] = []
  const seen = new Set<string>()
  for (const entry of registry.list()) {
    const live = byName.get(entry.container)
    seen.add(entry.container)
    const engineKind = entry.engine || (live ? engineOfContainer(live) : '')
    if (!engineKind) continue
    out.push({ ...entry, engine: engineKind, port: live ? containerDbPort(live, engineKind) : entry.port })
  }
  for (const [name, container] of byName) {
    if (seen.has(name)) continue
    const engineKind = engineOfContainer(container)
    if (!engineKind) continue
    out.push({
      name,
      engine: engineKind,
      container: name,
      port: containerDbPort(container, engineKind),
      user: '',
      database: '',
      dir: '',
      managed: false,
      createdAt: '',
    })
  }
  return out.sort((a, b) => a.name.localeCompare(b.name))
}

/** Kura 装的数据库项目目录：在项目目录下的一层子目录（和容器管理的约定一致）。 */
export function managedDir(root: string, name: string): string {
  checkProjectName(name)
  return `${root.replace(/\/+$/, '')}/${name}`
}

/** 从磁盘读一个项目目录的 .env 文本（读不到就当空 —— 接管来的容器可能根本没有 .env）。 */
export function readProjectEnv(dir: string): string {
  if (!dir) return ''
  try {
    return readFileSync(`${dir}/.env`, 'utf8')
  } catch {
    return ''
  }
}
