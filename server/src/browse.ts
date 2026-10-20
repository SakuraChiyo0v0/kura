import { readdir, realpath, stat } from 'node:fs/promises'
import { join, sep } from 'node:path'
import { normalizeDavPath } from '../../src/core/dav-scope.js'

/**
 * 给客户端的「暴露范围」页提供**目录树**（`GET /_kura/api/browse?path=`）。
 *
 * 为什么必须有这个接口：范围是白名单，没放行的目录在 WebDAV 视图里根本不存在。
 * 想新放行一个范围之外的目录（比如只放行了 /home，现在要加 /volume2），
 * 用文件页浏览是列不出 /volume2 的 —— 于是用户只能靠手输路径，拼错一个字符就静默不生效。
 *
 * 三条边界：
 * 1. **只列目录，不读文件名**：界面上要选的是目录；列出文件名等于凭空多一个「看 NAS 上有什么」的窗口，
 *    而这接口在范围之外。
 * 2. **不能靠 `..` 或符号链接跑出根**：NAS 路径先规范化（`normalizeDavPath` 拒绝 `.` / `..`），
 *    拼到根上之后再 `realpath` 校验一次 —— rclone 带 `-L` 跟着符号链接走，浏览这一层不能比它松。
 * 3. **有上限**：一个目录几万个子目录时不能把服务端拖住，超了就截断并如实说。
 */

export interface BrowseEntry {
  name: string
  /** NAS 上的路径（不是容器里的 /host/...） */
  path: string
}

export interface BrowseResult {
  path: string
  entries: BrowseEntry[]
  /** 目录项超过上限被截断了：界面要说「只显示前 N 个」 */
  truncated: boolean
}

export const browseMaxEntries = 500

/** 根自己就是 `/`；其余按段拼。根是容器里的宿主挂载点（默认 /host）。 */
function hostPath(root: string, nasPath: string): string {
  return nasPath === '/' ? root : join(root, ...nasPath.split('/').filter(Boolean))
}

/** 在根之内（按路径段比，/host2 不算在 /host 之内）。 */
function isUnderRoot(target: string, root: string): boolean {
  return target === root || target.startsWith(root.endsWith(sep) ? root : root + sep)
}

/**
 * 把 NAS 路径解析成容器里**真实**的目录路径。
 * `..` 由 `normalizeDavPath` 挡掉；这里是第二道：符号链接指到根外面也要拒绝。
 */
export async function resolveDirectory(root: string, nasPath: string): Promise<{ nasPath: string; realPath: string }> {
  const normalized = normalizeDavPath(nasPath)
  const realRoot = await realpath(root)
  const target = hostPath(realRoot, normalized)
  let realTarget: string
  try {
    realTarget = await realpath(target)
  } catch {
    throw new Error(`NAS 上没有这个目录：${normalized}`)
  }
  if (!isUnderRoot(realTarget, realRoot)) throw new Error(`路径跑到挂载根外面了：${normalized}`)
  const info = await stat(realTarget)
  if (!info.isDirectory()) throw new Error(`不是目录：${normalized}`)
  return { nasPath: normalized, realPath: realTarget }
}

/** 列一个 NAS 目录下的**子目录**（不含文件），名字排序。 */
export async function listDirectories(root: string, nasPath: string, max = browseMaxEntries): Promise<BrowseResult> {
  const { nasPath: normalized, realPath } = await resolveDirectory(root, nasPath)
  const items = await readdir(realPath, { withFileTypes: true })
  const entries: BrowseEntry[] = []
  for (const item of items) {
    // 符号链接要跟过去看一眼：rclone 是 -L，界面上该显示成目录的不该显示成文件
    let isDir = item.isDirectory()
    if (!isDir && item.isSymbolicLink()) {
      try {
        isDir = (await stat(join(realPath, item.name))).isDirectory()
      } catch {
        isDir = false // 断链：跳过，别让一个坏链接把整次列目录拖垮
      }
    }
    if (!isDir) continue
    entries.push({ name: item.name, path: normalized === '/' ? `/${item.name}` : `${normalized}/${item.name}` })
  }
  entries.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN', { numeric: true }))
  return { path: normalized, entries: entries.slice(0, max), truncated: entries.length > max }
}
