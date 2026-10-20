import type { DbEngine } from '../../../src/core/db-types.js'
import { DockerError } from '../docker/engine.js'
import { templates } from './templates.js'

/**
 * 查 Docker Hub 上某个官方镜像有哪些版本，挑出「适合拿来装数据库」的那些。
 *
 * 为什么需要这个：模板里固定 tag 是为了可复现（不用 latest），但把版本写死在代码里
 * 意味着想装 16 就得改代码重发。查一次 Hub 就能让用户在界面上挑，挑了照样是钉死的具体 tag。
 *
 * **只做白名单式的过滤，不做模糊猜测**：宁可少列几个，也不要列出一个装不起来的 tag
 * （比如 `17-windowsservercore`、`8.4-rc`、带 arm 架构的老镜像）。
 *
 * 一个现实约束：**离线时不能把安装功能一起废掉**。查不到就回退到模板自带的默认镜像，
 * 界面显示「没联网，用默认版本」—— 而不是给一个空下拉框让人装不了。
 */

/** Docker Hub 的官方镜像都在 `library/` 命名空间下。 */
const hubApi = 'https://hub.docker.com/v2/repositories/library'

/** 一次最多回多少个版本（界面是下拉框，列 200 个没人看得完）。 */
const maxVersions = 40

/**
 * 内置的常用版本兜底。
 *
 * 为什么需要：查版本要联网，而 NAS 上的 kura-server 未必出得去（实测常见：
 * Docker Hub 的 web API 连不上、连上了也未必能列 tags、加速器常常直接禁掉 tags 接口）。
 * 但**装数据库本身不需要联网查版本** —— 所以哪怕一条路都不通，也得让用户能选。
 *
 * 这些是各引擎当前仍在维护的主版本（新的在前）。**过期的代价只是「列不出最新版」**，
 * 不会让人装错东西 —— 用户仍可通过配置镜像站点拿到完整的实时列表。
 */
export const fallbackVersions: Record<DbEngine, string[]> = {
  postgres: ['17', '16', '15', '14', '13'],
  mysql: ['8.4', '8.0', '5.7'],
  mariadb: ['11.4', '11.2', '10.11', '10.6'],
  redis: ['7', '6'],
}

/** 每个引擎的镜像仓库名（从模板的默认镜像里取，避免两处再写一遍）。 */
export function repositoryOf(engine: DbEngine): string {
  return templates[engine].image.split(':')[0] ?? engine
}

export interface ImageVersion {
  /** 完整 tag，如 `17-alpine`、`8.4` */
  tag: string
  /** 版本号部分，如 `17`、`8.4.5` */
  version: string
  /** 变体部分（alpine / bookworm / '' —— 空串是默认变体） */
  variant: string
  /** Docker Hub 上这个 tag 最后推送的时间（ISO），可能没有 */
  updatedAt?: string
  /** 镜像大小（字节），多架构时取第一个；不知道就不给 */
  size?: number
}

export interface VersionList {
  engine: DbEngine
  repository: string
  /** 可选的版本，**新的在前** */
  versions: ImageVersion[]
  /** 当前模板的默认镜像 */
  defaultImage: string
  /**
   * 这批版本是哪来的：
   * - `registry`：配置的镜像站点（国内网络通常只有这条能通）
   * - `hub`：Docker Hub 的 web API（带大小与更新时间）
   * - `builtin`：两条网络通道都不通，用的是内置的常用版本
   */
  source: 'registry' | 'hub' | 'builtin'
  /** 查失败的原因（`builtin` 时一定有，其余为空） */
  error?: string
}

/**
 * 从 tag 里切出「版本」与「变体」。
 *
 * 官方镜像的 tag 命名**不统一**，所以这里只认确定的形状：
 * - `17` / `17.2` / `17.2.1` → 版本号，无变体
 * - `17-alpine` / `17.2-alpine` / `17-bookworm` → 版本号 + 变体
 * - `alpine` / `latest` / `windowsservercore` → **不认**（不是版本化的 tag）
 *
 * 认不出就返回 undefined，调用方跳过 —— 不猜。
 */
export function splitTag(tag: string): { version: string; variant: string } | undefined {
  // 版本号必须是纯数字加分号：17 / 17.2 / 8.4.5（MongoDB 那种 7.0.5 也在内）
  const m = /^(\d+(?:\.\d+)*)(?:-([a-z][a-z0-9]*))?$/.exec(tag)
  if (!m) return undefined
  return { version: m[1]!, variant: m[2] ?? '' }
}

/**
 * 一个 tag 值不值得列出来。
 *
 * 过滤掉的东西与理由：
 * - 版本号 > 2 段的小版本（`17.2.1`）：官方镜像的小版本 tag 更新极快、很快被删，
 *   钉它没什么意义，而且下拉框会被补丁版本刷屏。只留主版本与大版本。
 * - 非 amd64 的变体（`-windowsservercore`、`-nanoserver`）：NAS 是 linux/amd64。
 * - 预发布（tag 里带 rc / beta / alpha）：装上去出问题很难说清是谁的锅。
 */
export function isListable(version: string, variant: string): boolean {
  const parts = version.split('.')
  // 只留 17 与 17.2，不留 17.2.1
  if (parts.length > 2) return false
  if (/windowsserver|nanoserver/i.test(variant)) return false
  return true
}

interface HubTag {
  name?: string
  last_updated?: string
  images?: Array<{ size?: number; architecture?: string }>
}

/**
 * 把一堆原始 tag 名字筛成界面可选的版本（两条通道共用这一步）。
 *
 * **分通道取数据、在这一处统一筛**：Docker Hub 的 web API 与 registry 的 `/v2/tags/list`
 * 返回形状完全不同，但「哪些 tag 值得列」这条规则只该有一份 —— 两处各写一遍必然漂移。
 */
export function selectVersions(engine: DbEngine, tags: string[]): ImageVersion[] {
  const template = templates[engine]
  const allowed = new Set(template.variants)
  const seen = new Set<string>()
  const versions: ImageVersion[] = []

  for (const tag of tags) {
    const split = splitTag(tag)
    if (!split) continue
    if (!isListable(split.version, split.variant)) continue
    // 只留这个引擎支持的变体（比如 MySQL 不会出现 alpine）
    if (!allowed.has(split.variant)) continue
    if (seen.has(tag)) continue
    seen.add(tag)
    versions.push({ tag, version: split.version, variant: split.variant })
  }

  // 按版本号从新到旧（不能按推送时间：老版本偶尔也会重推个补丁）
  versions.sort((a, b) => {
    const pa = a.version.split('.').map(Number)
    const pb = b.version.split('.').map(Number)
    for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
      const diff = (pb[i] ?? 0) - (pa[i] ?? 0)
      if (diff !== 0) return diff
    }
    // 同版本时把默认变体排前面
    if (a.variant === template.defaultVariant) return -1
    if (b.variant === template.defaultVariant) return 1
    return a.variant.localeCompare(b.variant)
  })

  return mergePatchVersions(versions, template.majorOf, template.imageOf).slice(0, maxVersions)
}

/**
 * 把同一「主版本 + 变体」下的一串小版本收成一个，tag 归一到主版本。
 *
 * 为什么必须做：registry 的 tags 列表是**全量**的。实测 `docker.1ms.run` 上 PostgreSQL
 * 列出来的前 8 个是 `17.11-alpine`、`17.11`、`17.11-bookworm`、`17.11-trixie`、
 * `17.10-alpine`、`17.10`… —— 光 17 这一个主版本就带几十条，下拉框直接被补丁版本刷满，
 * 用户找不到「17」本身。
 *
 * 归一到主版本号还有个实际好处：`17-alpine` 是官方长期维护的浮动 tag（跟着补丁走），
 * 而 `17.11-alpine` 这种具体小版本很快会被从 Hub 上删掉。
 *
 * 「主版本」的定义**按引擎分**（`majorOf`）：PostgreSQL 是 `17`，MySQL 的 `8.4` 本身就是
 * 它的主版本（不能收成 `8`，那样镜像根本不存在）。
 */
export function mergePatchVersions(
  versions: ImageVersion[],
  majorOf: (version: string) => string,
  imageOf: (version: string, variant: string) => string,
): ImageVersion[] {
  const seen = new Set<string>()
  const out: ImageVersion[] = []
  for (const version of versions) {
    const major = majorOf(version.version)
    const key = `${major}-${version.variant}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({
      ...version,
      version: major,
      tag: imageOf(major, version.variant).split(':').pop() ?? version.tag,
    })
  }
  return out
}

/**
 * 用内置兜底列表拼出可选版本（所有网络通道都失败时用）。
 *
 * **注意拼的是纯 tag（`17-alpine`），不是完整镜像名** —— `selectVersions()` 吃的就是 tag。
 * 这里踩过：拼成 `postgres:17-alpine` 传给筛子，`splitTag` 认不出（它只认 `版本-变体`），
 * 整个兜底列表被筛成空的，界面就变成了「查不到可用版本」。
 */
export function builtinVersions(engine: DbEngine): ImageVersion[] {
  const template = templates[engine]
  const tags: string[] = []
  for (const version of fallbackVersions[engine] ?? []) {
    tags.push(template.imageOf(version, template.defaultVariant).replace(`${repositoryOf(engine)}:`, ''))
    // 完整版（不带后缀）也是个常见选择，一起给
    if (template.defaultVariant) tags.push(version)
  }
  return selectVersions(engine, tags)
}

/**
 * 通道一：Docker Hub 的 web API。
 *
 * 好处是带镜像大小与更新时间；坏处是 `hub.docker.com` 在有些网络里连不上，
 * 而且它**不是 registry 接口** —— 镜像加速器代理的是 `/v2/`，帮不到这条路。
 */
async function fetchFromHubApi(repository: string, doFetch: typeof fetch, signal: AbortSignal): Promise<{ tags: string[]; meta: Map<string, HubTag> }> {
  // page_size 给大一点：Hub 的排序是「最近推送」，而我们要的是「版本从新到旧」，
  // 所以多拿一些再在本地筛、排序。
  const url = `${hubApi}/${encodeURIComponent(repository)}/tags?page_size=100&ordering=last_updated`
  const res = await doFetch(url, { signal, headers: { accept: 'application/json' } })
  if (!res.ok) throw new DockerError(res.status, `Docker Hub 回了 HTTP ${res.status}`)
  const body = (await res.json()) as { results?: HubTag[] }
  const entries = body.results ?? []
  const meta = new Map<string, HubTag>()
  for (const entry of entries) if (entry.name) meta.set(entry.name, entry)
  return { tags: entries.map((e) => e.name ?? '').filter(Boolean), meta }
}

/**
 * 通道二：registry 的 `/v2/<repo>/tags/list`（**镜像加速器代理的就是这个**）。
 *
 * 认证是标准的 Bearer 流程：先拿 401 的 `WWW-Authenticate`，按它给的 realm / service / scope
 * 去换一个 token，再带着 token 重发。有些站点（如 docker.1ms.run）压根不要求认证，直接给数据。
 *
 * **有的加速器会禁掉 tags 列表**（实测 `docker.m.daocloud.io` 回
 * `{"name":"disable-list-tags","tags":[]}`）—— 那种情况当成失败，好让上层回退，
 * 而不是拿一个空列表骗用户说「没有版本」。
 */
async function fetchFromRegistry(base: string, repository: string, doFetch: typeof fetch, signal: AbortSignal): Promise<string[]> {
  const root = base.replace(/\/+$/, '')
  // registry 的官方镜像都在 `library/` 命名空间下：`/v2/postgres/tags/list` 是 404/403，
  // 必须写 `/v2/library/postgres/tags/list`。这里踩过一次 —— 少了前缀整条通道静默失败。
  const name = repository.includes('/') ? repository : `library/${repository}`
  const tagsUrl = `${root}/v2/${name}/tags/list?n=1000`

  const first = await doFetch(tagsUrl, { signal })
  if (first.ok) {
    const body = (await first.json()) as { tags?: string[]; name?: string }
    if (body.name === 'disable-list-tags') {
      throw new DockerError(403, '这个镜像站点不提供版本列表（它只代理拉取）')
    }
    return body.tags ?? []
  }
  if (first.status !== 401) throw new DockerError(first.status, `镜像站点回了 HTTP ${first.status}`)

  // 401：按 challenge 换 token
  const challenge = first.headers.get('www-authenticate') ?? ''
  const realm = /realm="([^"]+)"/.exec(challenge)?.[1]
  if (!realm) throw new DockerError(401, '镜像站点要求认证，但没有给 realm')

  const service = /service="([^"]+)"/.exec(challenge)?.[1]
  const scope = /scope="([^"]+)"/.exec(challenge)?.[1]
  const tokenUrl = new URL(realm)
  if (service) tokenUrl.searchParams.set('service', service)
  if (scope) tokenUrl.searchParams.set('scope', scope)

  const tokenRes = await doFetch(tokenUrl.toString(), { signal })
  if (!tokenRes.ok) throw new DockerError(tokenRes.status, `换 token 失败（HTTP ${tokenRes.status}）`)
  const tokenBody = (await tokenRes.json()) as { token?: string; access_token?: string }
  const token = tokenBody.token ?? tokenBody.access_token
  if (!token) throw new DockerError(401, '镜像站点没给 token')

  const authed = await doFetch(tagsUrl, { signal, headers: { authorization: `Bearer ${token}` } })
  if (!authed.ok) throw new DockerError(authed.status, `带 token 再查仍然失败（HTTP ${authed.status}）`)
  const body = (await authed.json()) as { tags?: string[]; name?: string }
  if (body.name === 'disable-list-tags') {
    throw new DockerError(403, '这个镜像站点不提供版本列表（它只代理拉取）')
  }
  return body.tags ?? []
}

/** 把用户填的镜像站点归一成一个 base URL（允许只填域名、允许带不带 scheme）。 */
export function normalizeRegistry(value: string | undefined): string {
  const trimmed = (value ?? '').trim()
  if (!trimmed) return ''
  // 只填域名时补上 https（镜像站点基本都是 https）
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`
  return withScheme.replace(/\/+$/, '')
}

/**
 * 拉一个镜像的版本列表。
 *
 * 依次尝试：配置的镜像站点 → Docker Hub 的 web API → 内置兜底列表。
 * **永远不会抛**，也**永远不会回空列表**（除非内置列表也空），所以界面总能让人选一个。
 *
 * 返回里的 `source` 说明这些版本是从哪来的，界面据此给一句不同的话。
 */
export async function listVersions(
  engine: DbEngine,
  options: { timeoutMs?: number; fetchImpl?: typeof fetch; registry?: string } = {},
): Promise<VersionList> {
  const template = templates[engine]
  const repository = repositoryOf(engine)
  const base: VersionList = {
    engine,
    repository,
    versions: [],
    defaultImage: template.image,
    source: 'builtin',
  }

  const doFetch = options.fetchImpl ?? fetch
  const registry = normalizeRegistry(options.registry)
  const failures: string[] = []

  /** 跑一个通道，成功就返回版本，失败记下原因继续。 */
  const attempt = async (label: string, run: (signal: AbortSignal) => Promise<ImageVersion[]>): Promise<ImageVersion[] | undefined> => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 8_000)
    try {
      const versions = await run(controller.signal)
      return versions.length > 0 ? versions : undefined
    } catch (error) {
      failures.push(`${label}：${describeFetchError(error)}`)
      return undefined
    } finally {
      clearTimeout(timer)
    }
  }

  // 1) 配了镜像站点就先试它（这是唯一在国内网络下通常能通的路）
  if (registry) {
    const fromRegistry = await attempt(`镜像站点 ${registry}`, async (signal) => {
      const tags = await fetchFromRegistry(registry, repository, doFetch, signal)
      return selectVersions(engine, tags)
    })
    if (fromRegistry) return { ...base, versions: fromRegistry, source: 'registry' }
  }

  // 2) Docker Hub 的 web API（带镜像大小与更新时间）
  const fromHub = await attempt('Docker Hub', async (signal) => {
    const { tags, meta } = await fetchFromHubApi(repository, doFetch, signal)
    return selectVersions(engine, tags).map((version) => {
      const entry = meta.get(version.tag)
      const amd64 = entry?.images?.find((image) => image.architecture === 'amd64') ?? entry?.images?.[0]
      return {
        ...version,
        ...(entry?.last_updated ? { updatedAt: entry.last_updated } : {}),
        ...(amd64?.size ? { size: amd64.size } : {}),
      }
    })
  })
  if (fromHub) return { ...base, versions: fromHub, source: 'hub' }

  // 3) 都不通：用内置的常用版本，并把失败原因如实带出去
  return {
    ...base,
    versions: builtinVersions(engine),
    source: 'builtin',
    error: failures.join('；'),
  }
}

/**
 * 把 fetch 的失败原因说清楚。
 *
 * **`fetch` 抛出来的永远只是一句 `fetch failed`**，真正的原因（DNS 解析不了、连不上、
 * TLS 被拦、证书过期）全在 `error.cause` 里。只显示 `error.message` 的话，
 * 用户看到的是一句等于没说的话 —— 这里逐层剥出 cause 链。
 */
export function describeFetchError(error: unknown): string {
  const err = error as Error & { cause?: unknown }
  if (err?.name === 'AbortError') return '查版本超时（NAS 连不上 Docker Hub？）'

  const parts: string[] = []
  let cursor: unknown = err
  // cause 链可能有两三层（undici 的 TypeError → 系统错误 → …），全剥出来
  for (let depth = 0; depth < 4 && cursor; depth += 1) {
    const current = cursor as { message?: string; code?: string; cause?: unknown; errno?: number }
    const text = [current.code, current.message].filter(Boolean).join(' ')
    if (text && !parts.includes(text)) parts.push(text)
    cursor = current.cause
  }

  const detail = parts.filter((p) => p && p !== 'fetch failed').join(' → ') || parts[0] || '未知原因'
  return `NAS 上的 kura-server 连不上 Docker Hub：${detail}`
}

/**
 * 校验用户选定的镜像名。
 *
 * **不能把任意字符串塞进 compose** —— `image:` 那一行最终会交给 docker，一个带换行或
 * 空格的字符串能在 compose 文件里造出额外的行（等价于注入）。
 * 这里只接受「仓库名:tag」这个形状，且 tag 必须是版本化的（或用户在界面上原样选中的）。
 */
export function assertImageName(engine: DbEngine, image: string): void {
  if (!/^[a-z0-9][a-z0-9._/-]*(:[a-zA-Z0-9][a-zA-Z0-9._-]{0,127})?$/.test(image)) {
    throw new DockerError(400, `镜像名不合法：${JSON.stringify(image)}`)
  }
  const repository = repositoryOf(engine)
  // 只允许这个引擎自己的官方仓库：换仓库等于换一个我们没验过的镜像
  if (!image.startsWith(`${repository}:`) && image !== repository) {
    throw new DockerError(400, `只支持官方镜像 ${repository}，收到的是 ${image}`)
  }
}
