/**
 * 挂载缓存体检：找出「本机缓存和 NAS 上不一样」的文件，并尽量少地补齐。
 *
 * ## 为什么需要
 *
 * rclone 的 VFS 判断「远程文件变没变」**只比大小**（WebDAV 后端拿不到内容哈希，
 * `vfsMeta` 里的 `Fingerprint` 就是字节数）。实测：原地覆盖成同样大小的新内容、
 * mtime 明明变新了，挂载盘读到的仍是旧内容；差 1 个字节才会重新下载。
 *
 * 而给音乐改个标签（`年轮` → `花海`，都是 6 字节 UTF-8）正好是等字节长度的改名 ——
 * 文件大小纹丝不动，用户在挂载盘上就永远看到旧标签，刷新重启都不管用。
 * 2026-10 线上踩过两次：一次改标题、一次加年份和歌词，都是这个成因。
 *
 * ## 怎么判、怎么补
 *
 * 「远程和缓存不一样」有两类，代价相差两个数量级，必须分开处理：
 *
 * - **只改了标签**：音频流一个字节没动。只把远程的文件头（ID3 区 / FLAC 的
 *   元数据块）抄回来，几 MB 的文件只要传几十 KB。
 * - **音频真的变了**：只能整份重下。
 *
 * 判据（顺序不能换）：
 * 1. 大小不同 → 音频必然变了，整份重下
 * 2. 大小相同 → 比文件头和末尾各一段的哈希
 * 3. 头不同 + 尾相同 → 只补头（标签）
 * 4. 其余 → 整份重下
 *
 * 第 3 步的「尾相同」是关键：只比头会把「头和音频都变了、偏偏头也变了」的文件
 * 误判成「只改了标签」，补完头就是个坏文件。
 *
 * ## 孤儿：改名 / 删除留下的缓存
 *
 * 目录整个改名后，旧路径下的缓存条目还留着（NAS 上早已 404），白占空间。
 * 这类必须**先确认远端 404** 再删 —— 判断标准是「远端读不到」，不是「列目录时没看到」
 * （列目录可能因为权限、范围裁剪而漏项）。
 */
import { existsSync, readdirSync, statSync, unlinkSync, writeFileSync, readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join, basename, dirname } from 'node:path'
import { createHash } from 'node:crypto'
import type { DavClient } from '../core/dav-client.js'

/** 比对一个文件要抓多少字节。ID3 区实测最大 ~1.1MB（大封面），留出余量。 */
const HEAD_BYTES = 400 * 1024
/** 末尾抓多少字节当作「音频还是原来那段」的证据。 */
const TAIL_BYTES = 64 * 1024
/** 单个文件头部的硬上限：超过这个还没读完 ID3 就放弃精细判断，退回整份重下。 */
const MAX_HEAD_BYTES = 4 * 1024 * 1024
/** 并发数：走中继时开太多会把链路拖垮，也会让 NAS 的 WebDAV 排队。 */
const CONCURRENCY = 4

export interface CacheEntry {
  /** 缓存里的文件名（不含目录） */
  name: string
  /** 相对缓存根的路径，用于拼 vfs / vfsMeta 两个位置 */
  relative: string
  size: number
}

export interface StaleEntry {
  name: string
  relative: string
  size: number
  /** tag = 只改了标签，补文件头即可；audio = 音频变了，必须整份重下 */
  kind: 'tag' | 'audio'
  /** 远端读到的东西和本地不一样的原因，给用户看的 */
  reason: string
}

export interface OrphanEntry {
  name: string
  relative: string
  size: number
}

export interface CacheScanResult {
  /** 扫过的目录数 */
  directories: number
  /** 缓存里一共多少条目 */
  total: number
  intact: number
  stale: StaleEntry[]
  orphans: OrphanEntry[]
  /** 读失败、跳过的条目（不当作问题，只是没检查到） */
  skipped: { name: string; reason: string }[]
  bytes: {
    /** 缓存总共占多少 */
    total: number
    /** 过期条目占多少 */
    stale: number
    /** 孤儿占多少 */
    orphans: number
    /** 只补标签需要下载的量 */
    needDownload: number
    /** 全部整份重下要多少（对照用，让用户看到省了多少） */
    fullRedownload: number
  }
}

export interface RepairResult {
  retagged: number
  redownloaded: number
  removed: number
  failed: { name: string; reason: string }[]
  /** 实际从 NAS 下载的字节数 */
  downloaded: number
}

export interface CacheDoctorOptions {
  /** rclone 的 --cache-dir */
  cacheDir: string
  /** 走本机 WebDAV（和挂载同一条路，范围裁剪、认证都一样） */
  dav: DavClient
  /** 缓存里的 NAS 路径前缀 → 远端 DAV 路径。默认原样。 */
  toDavPath?: (relative: string) => string
  /** 进度回调：扫描 / 修复时给界面用 */
  onProgress?: (done: number, total: number, phase: string) => void
  signal?: AbortSignal
}

// ---------------------------------------------------------------- 磁盘布局

/**
 * rclone 的 VFS 把远端路径原样映射到 `<cache>/vfs/<remote>/<路径>`。
 * `remote` 这一层形如 `：webdav{8w5b1}`（全角冒号 + 连接串指纹），每次挂载都可能变，
 * 所以不能写死 —— 得从缓存目录里现找。
 */
export function findRemoteRoots(cacheDir: string): { vfs: string; vfsMeta: string }[] {
  const roots: { vfs: string; vfsMeta: string }[] = []
  for (const [top, key] of [['vfs', 'vfs'], ['vfsMeta', 'vfsMeta']] as const) {
    const dir = join(cacheDir, top)
    if (!existsSync(dir)) continue
    for (const remote of readdirSync(dir)) {
      const root = join(dir, remote)
      if (!statSync(root).isDirectory()) continue
      const found = roots.find((r) => basename(r.vfs) === remote)
      if (found) found[key] = root
      else roots.push({ vfs: key === 'vfs' ? root : '', vfsMeta: key === 'vfsMeta' ? root : '' })
    }
  }
  return roots.filter((r) => r.vfs && r.vfsMeta)
}

/** 递归列出某个 vfs 根下所有的缓存文件（相对路径）。 */
function walkCachedFiles(root: string): { relative: string; size: number }[] {
  const out: { relative: string; size: number }[] = []
  const read = (dir: string, prefix: string): void => {
    let entries: string[]
    try {
      entries = readdirSync(dir)
    } catch {
      return
    }
    for (const name of entries) {
      const full = join(dir, name)
      let st
      try {
        st = statSync(full)
      } catch {
        continue // 正在被 rclone 改，跳过
      }
      const rel = prefix ? `${prefix}/${name}` : name
      if (st.isDirectory()) read(full, rel)
      else out.push({ relative: rel, size: st.size })
    }
  }
  read(root, '')
  return out
}

// ---------------------------------------------------------------- ID3 / FLAC 头长度

/**
 * 一个音频文件的「标签区」有多长 —— 只有这部分变了才允许只补头。
 *
 * mp3：ID3v2 头里写着长度（syncsafe，7 位一字节）。没有 ID3 就返回 0，
 * 调用方据此退回整份重下（没标签的文件，「只改了标签」无从谈起）。
 *
 * 认不出的格式一律返回 0，走整份重下 —— 宁可多下，不能补出坏文件。
 */
export function tagRegionLength(head: Buffer): number {
  if (head.length < 10) return 0
  if (head.subarray(0, 3).toString('latin1') === 'ID3') {
    const size = (head[6]! << 21) | (head[7]! << 14) | (head[8]! << 7) | head[9]!
    return 10 + size + ((head[5]! & 0x10) ? 10 : 0) // footer 标志位
  }
  // FLAC（含 "fLaC" 可能在前面若干字节的 ID3 之后的情况这里不处理，退回整份重下）
  return 0
}

// ---------------------------------------------------------------- 扫描

function sha(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex')
}

interface CompareContext {
  dav: DavClient
  toDavPath: (relative: string) => string
  signal?: AbortSignal
}

/** 把缓存里的一个文件跟远端比一遍，给出「没事 / 只改标签 / 音频变了」。 */
async function compareOne(
  ctx: CompareContext,
  entry: { relative: string; size: number },
  cacheFile: string,
): Promise<{ kind: 'intact' | 'tag' | 'audio'; reason: string } | { skip: string }> {
  const remotePath = ctx.toDavPath(entry.relative)
  const remote = await ctx.dav.stat(remotePath)
  if (!remote) return { skip: '远端已不存在' }
  if (remote.size !== entry.size) {
    return { kind: 'audio', reason: `大小变了（本地 ${entry.size} → 远端 ${remote.size}）` }
  }
  const size = entry.size
  if (size === 0) return { kind: 'intact', reason: '' }

  const local = await readFile(cacheFile)
  const headLen = Math.min(HEAD_BYTES, size)
  const tailLen = Math.min(TAIL_BYTES, size)

  let remoteHead: Buffer
  try {
    remoteHead = await ctx.dav.readRange(remotePath, 0, headLen - 1, { maxBytes: headLen })
  } catch (error) {
    return { skip: `读远端失败：${(error as Error).message}` }
  }
  if (remoteHead.length < headLen) return { skip: '远端返回的头太短' }

  // 标签区可能比 HEAD_BYTES 还大（封面大）—— 再抓一次够了
  let region = tagRegionLength(remoteHead)
  if (region > remoteHead.length && region <= MAX_HEAD_BYTES && region <= size) {
    try {
      remoteHead = await ctx.dav.readRange(remotePath, 0, region - 1, { maxBytes: region })
      region = tagRegionLength(remoteHead)
    } catch {
      return { skip: '读远端标签区失败' }
    }
  }

  const headSame = sha(remoteHead.subarray(0, headLen)) === sha(local.subarray(0, headLen))
  if (headSame && headLen >= size) return { kind: 'intact', reason: '' }

  const tailStart = size - tailLen
  // 头就覆盖了整份文件时不用再比尾
  const tailSame =
    headLen >= size
      ? true
      : sha(await ctx.dav.readRange(remotePath, tailStart, size - 1, { maxBytes: tailLen })) ===
        sha(local.subarray(tailStart, size))

  if (headSame && tailSame) return { kind: 'intact', reason: '' }
  // 头变了、尾没变，且标签区完整落在头部范围内 → 只动了标签
  if (!headSame && tailSame && region > 0 && region <= headLen) {
    return { kind: 'tag', reason: '只改了标签，音频没动' }
  }
  return { kind: 'audio', reason: tailSame ? '音频区有变化' : '音频内容变了' }
}

export async function scanCache(options: CacheDoctorOptions): Promise<CacheScanResult> {
  const roots = findRemoteRoots(options.cacheDir)
  const ctx: CompareContext = {
    dav: options.dav,
    toDavPath: options.toDavPath ?? ((rel) => `/${rel}`),
    signal: options.signal,
  }
  const result: CacheScanResult = {
    directories: 0,
    total: 0,
    intact: 0,
    stale: [],
    orphans: [],
    skipped: [],
    bytes: { total: 0, stale: 0, orphans: 0, needDownload: 0, fullRedownload: 0 },
  }

  for (const root of roots) {
    const files = walkCachedFiles(root.vfs)
    result.directories += 1
    result.total += files.length
    let done = 0
    let index = 0

    const worker = async (): Promise<void> => {
      while (index < files.length) {
        const entry = files[index++]!
        if (options.signal?.aborted) return
        const cacheFile = join(root.vfs, entry.relative)
        result.bytes.total += entry.size
        try {
          const verdict = await compareOne(ctx, entry, cacheFile)
          if ('skip' in verdict) {
            result.skipped.push({ name: basename(entry.relative), reason: verdict.skip })
            // 远端 404 = 孤儿（改名或删除留下的），单独归类
            if (verdict.skip === '远端已不存在') {
              result.orphans.push({ name: basename(entry.relative), relative: entry.relative, size: entry.size })
              result.bytes.orphans += entry.size
            }
          } else if (verdict.kind === 'intact') {
            result.intact += 1
          } else {
            result.stale.push({ name: basename(entry.relative), relative: entry.relative, size: entry.size, kind: verdict.kind, reason: verdict.reason })
            result.bytes.stale += entry.size
            result.bytes.fullRedownload += entry.size
            result.bytes.needDownload += verdict.kind === 'tag' ? Math.min(HEAD_BYTES, entry.size) : entry.size
          }
        } catch (error) {
          result.skipped.push({ name: basename(entry.relative), reason: (error as Error).message })
        }
        done += 1
        options.onProgress?.(done, files.length, 'scan')
      }
    }
    await Promise.all(Array.from({ length: CONCURRENCY }, worker))
  }
  return result
}

// ---------------------------------------------------------------- 修复

/** 把 vfsMeta 里的 ModTime 改成远端那份，让 rclone 认为「已经同步过」。 */
function touchMeta(metaPath: string, remoteModified: number): void {
  if (!existsSync(metaPath) || !remoteModified) return
  try {
    const meta = JSON.parse(readFileSync(metaPath, 'utf8')) as Record<string, unknown>
    meta.ModTime = new Date(remoteModified).toISOString()
    writeFileSync(metaPath, JSON.stringify(meta, null, '\t'))
  } catch {
    // 元数据写不动不影响文件内容，rclone 下次自己会校正
  }
}

export async function repairCache(
  scan: CacheScanResult,
  options: CacheDoctorOptions,
): Promise<RepairResult> {
  const roots = findRemoteRoots(options.cacheDir)
  const out: RepairResult = { retagged: 0, redownloaded: 0, removed: 0, failed: [], downloaded: 0 }
  if (!roots.length) return out
  const root = roots[0]!
  const toDavPath = options.toDavPath ?? ((rel: string) => `/${rel}`)

  const tasks = [...scan.stale.map((s) => ({ entry: s, orphan: false })), ...scan.orphans.map((o) => ({ entry: { ...o, kind: 'audio' as const, reason: '孤儿' }, orphan: true }))]
  let index = 0
  let done = 0

  const worker = async (): Promise<void> => {
    while (index < tasks.length) {
      const task = tasks[index++]!
      if (options.signal?.aborted) return
      const cacheFile = join(root.vfs, task.entry.relative)
      const metaFile = join(root.vfsMeta, task.entry.relative)
      const remotePath = toDavPath(task.entry.relative)
      try {
        if (task.orphan) {
          if (existsSync(cacheFile)) unlinkSync(cacheFile)
          if (existsSync(metaFile)) unlinkSync(metaFile)
          out.removed += 1
        } else if (task.entry.kind === 'tag') {
          // 只补标签区：写回后 rclone 会认为缓存是最新的
          const head = await options.dav.readRange(remotePath, 0, undefined, { maxBytes: MAX_HEAD_BYTES })
          const region = tagRegionLength(head)
          if (region <= 0 || region > head.length) throw new Error('标签区长度异常，跳过')
          const local = await readFile(cacheFile)
          if (region > local.length) throw new Error('标签区比本地文件还长，跳过')
          const patched = Buffer.concat([head.subarray(0, region), local.subarray(region)])
          writeFileSync(cacheFile, patched)
          const remote = await options.dav.stat(remotePath)
          touchMeta(metaFile, remote?.modified ?? 0)
          out.retagged += 1
          out.downloaded += region
        } else {
          // 整份重下：范围不限，拿全文件
          const remote = await options.dav.stat(remotePath)
          if (!remote) throw new Error('远端已不存在')
          const data = await options.dav.readRange(remotePath, 0, undefined, { maxBytes: remote.size })
          if (data.length !== remote.size) throw new Error(`下载不完整（${data.length}/${remote.size}）`)
          writeFileSync(cacheFile, data)
          touchMeta(metaFile, remote.modified)
          out.redownloaded += 1
          out.downloaded += data.length
        }
      } catch (error) {
        out.failed.push({ name: task.entry.name, reason: (error as Error).message })
      }
      done += 1
      options.onProgress?.(done, tasks.length, 'repair')
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker))
  return out
}
