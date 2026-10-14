import http from 'node:http'
import { readFileSync } from 'node:fs'
import { writeJsonAtomic } from '../../src/core/store.js'

/**
 * 服务清单：kura-server 能反代到哪些应用。
 *
 * 来源是 `/state/services.json`（管理页编辑，也可手改），**不再**像 gen-services.sh 那样从 nginx 配置里解析。
 * 内置服务（webdav、nas-console）不在文件里，由 kura-server 自己提供、固定出现在清单上。
 *
 * `/__services` 的输出形状与现网一致（客户端 src/core/mirror.ts 的 RegistryEntry）：
 *   {"services":[{"name":"openlist","container_port":5244,"host_port":5244,"published":true}]}
 * host_port / published 要查 docker（容器端口有没有发布到宿主）；没给 docker.sock 就一律当没发布 ——
 * 客户端照样能用，只是全部走网关。
 */
export interface ServiceEntry {
  name: string
  /** 后端地址，如 http://openlist:5244（Docker 内置 DNS 解析容器名） */
  backend: string
  /** 应用会发绝对路径的跳转（hermes 那种）：路径前缀模式下把 Location 重新加上前缀 */
  rewriteRedirect?: boolean
}

export interface RegistryEntry {
  name: string
  container_port: number
  host_port: number
  published: boolean
}

/** 服务名的合法形状：和 nginx map 白名单一样，字母数字连字符。 */
const nameRe = /^[a-z0-9][a-z0-9-]{0,62}$/

export function parseServices(text: string): ServiceEntry[] {
  const doc = JSON.parse(text) as { services?: unknown }
  if (!Array.isArray(doc.services)) throw new Error('services.json 里没有 services 数组')
  const out: ServiceEntry[] = []
  const seen = new Set<string>()
  for (const raw of doc.services as Array<Record<string, unknown>>) {
    const name = String(raw.name ?? '')
    const backend = String(raw.backend ?? '')
    if (!nameRe.test(name)) throw new Error(`服务名不合法：${JSON.stringify(name)}`)
    if (seen.has(name)) throw new Error(`服务名重复：${name}`)
    let url: URL
    try {
      url = new URL(backend)
    } catch {
      throw new Error(`${name} 的 backend 不是合法地址：${JSON.stringify(backend)}`)
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error(`${name} 的 backend 只能是 http / https`)
    seen.add(name)
    out.push({ name, backend: url.origin, rewriteRedirect: raw.rewriteRedirect === true })
  }
  return out
}

/** 只用到 docker API 的这一个接口；别的一概不调（docker.sock 等于 root，代码里白名单这一条）。 */
interface DockerContainer {
  Names?: string[]
  Ports?: Array<{ PrivatePort?: number; PublicPort?: number; Type?: string }>
}

export type DockerLister = () => Promise<DockerContainer[]>

export function dockerSocketLister(socketPath = '/var/run/docker.sock'): DockerLister {
  return () =>
    new Promise((resolve, reject) => {
      const req = http.request({ socketPath, path: '/containers/json', method: 'GET', timeout: 5_000 }, (res) => {
        let body = ''
        res.on('data', (c) => (body += c))
        res.on('end', () => {
          try {
            resolve(JSON.parse(body) as DockerContainer[])
          } catch (error) {
            reject(error as Error)
          }
        })
      })
      req.on('timeout', () => req.destroy(new Error('docker API 超时')))
      req.on('error', reject)
      req.end()
    })
}

export class Registry {
  private services: ServiceEntry[] = []
  private loadError = ''

  constructor(
    private readonly file: string | undefined,
    /** 内置服务：名字 → 容器内端口（用于清单上的 container_port） */
    private readonly builtin: Record<string, number>,
    private readonly docker?: DockerLister,
  ) {
    this.reload()
  }

  reload(): void {
    if (!this.file) return
    try {
      this.services = parseServices(readFileSync(this.file, 'utf8'))
      this.loadError = ''
    } catch (error) {
      // 文件坏了保留上一份：一次手误不该让所有应用一起 404
      this.loadError = (error as Error).message
    }
  }

  /** 测试与管理页直接设。 */
  set(services: ServiceEntry[]): void {
    this.services = services
    this.loadError = ''
  }

  /** 管理页保存：写回 services.json（原子替换，写坏了不影响已加载的一份）。 */
  save(services: ServiceEntry[]): void {
    if (!this.file) throw new Error('没有配置 services.json 路径')
    // 先过一遍校验，坏数据不落盘
    parseServices(JSON.stringify({ services }))
    writeJsonAtomic(this.file, { services })
    this.set(services)
  }

  error(): string {
    return this.loadError
  }

  list(): ServiceEntry[] {
    return [...this.services]
  }

  find(name: string): ServiceEntry | undefined {
    return this.services.find((s) => s.name === name)
  }

  isBuiltin(name: string): boolean {
    return name in this.builtin
  }

  /** 是不是已知服务名（内置或配置的）—— 路径前缀分流的白名单。 */
  known(name: string): boolean {
    return this.isBuiltin(name) || this.find(name) !== undefined
  }

  async entries(): Promise<RegistryEntry[]> {
    let containers: DockerContainer[] = []
    if (this.docker) {
      try {
        containers = await this.docker()
      } catch {
        // 查不到 docker 就当都没发布
      }
    }
    const published = (host: string, port: number): number => {
      const c = containers.find((x) => (x.Names ?? []).some((n) => n.replace(/^\//, '') === host))
      return c?.Ports?.find((p) => p.PrivatePort === port && p.Type === 'tcp' && p.PublicPort)?.PublicPort ?? 0
    }
    const out: RegistryEntry[] = Object.entries(this.builtin).map(([name, port]) => ({
      name,
      container_port: port,
      host_port: 0,
      published: false,
    }))
    for (const s of this.services) {
      const url = new URL(s.backend)
      const port = Number(url.port) || (url.protocol === 'https:' ? 443 : 80)
      const host = published(url.hostname, port)
      out.push({ name: s.name, container_port: port, host_port: host, published: host > 0 })
    }
    return out
  }
}
