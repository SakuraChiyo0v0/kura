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
  /** 当前模板的默认镜像（查不到时界面上回退到这个） */
  defaultImage: string
  /** 查失败了的原因；空的表示查成功 */
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
 * 拉一个镜像的版本列表。
 *
 * `timeoutMs` 默认 8 秒 —— 这是个「锦上添花」的查询，慢到影响安装就不值了。
 * 失败**不抛**，回 `error` 让界面回退到默认镜像。
 */
export async function listVersions(engine: DbEngine, options: { timeoutMs?: number; fetchImpl?: typeof fetch } = {}): Promise<VersionList> {
  const template = templates[engine]
  const repository = repositoryOf(engine)
  const base: VersionList = {
    engine,
    repository,
    versions: [],
    defaultImage: template.image,
  }

  const doFetch = options.fetchImpl ?? fetch
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 8_000)

  try {
    // page_size 给大一点：Hub 的排序是「最近推送」，而我们要的是「版本从新到旧」，
    // 所以多拿一些再在本地筛、排序。60 对这几个官方镜像足够覆盖最近十几个大版本。
    const url = `${hubApi}/${encodeURIComponent(repository)}/tags?page_size=100&ordering=last_updated`
    const res = await doFetch(url, {
      signal: controller.signal,
      headers: { accept: 'application/json' },
    })
    if (!res.ok) {
      return { ...base, error: `Docker Hub 回了 HTTP ${res.status}（${res.statusText || '查不到版本'}）` }
    }
    const body = (await res.json()) as { results?: HubTag[] }
    const tags = body.results ?? []

    const allowed = new Set(template.variants)
    const seen = new Set<string>()
    const versions: ImageVersion[] = []

    for (const entry of tags) {
      const tag = entry.name ?? ''
      const split = splitTag(tag)
      if (!split) continue
      if (!isListable(split.version, split.variant)) continue
      // 只留这个引擎支持的变体（比如 MySQL 不会出现 alpine）
      if (!allowed.has(split.variant)) continue
      if (seen.has(tag)) continue
      seen.add(tag)

      // 多架构镜像取 amd64 那个的大小（NAS 是 amd64）
      const amd64 = entry.images?.find((image) => image.architecture === 'amd64') ?? entry.images?.[0]
      versions.push({
        tag,
        version: split.version,
        variant: split.variant,
        ...(entry.last_updated ? { updatedAt: entry.last_updated } : {}),
        ...(amd64?.size ? { size: amd64.size } : {}),
      })
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

    return { ...base, versions: versions.slice(0, maxVersions) }
  } catch (error) {
    const message = (error as Error).name === 'AbortError' ? '查版本超时（NAS 连不上 Docker Hub？）' : (error as Error).message
    return { ...base, error: message }
  } finally {
    clearTimeout(timer)
  }
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
