import { statSync } from 'node:fs'
import { posix } from 'node:path'

/**
 * 「这个宿主目录，真的按原路径挂进容器了吗？」
 *
 * **为什么必须问这一句**：compose 里的相对路径（`./state:/state`）是**按执行目录**解析成绝对路径
 * 再交给 dockerd 的。在 `/host/volume1/docker/x` 下执行，dockerd 会拿到 `/host/volume1/docker/x/state`
 * ——宿主上没有这个路径，dockerd 会**新建一个空目录挂进去**，应用看起来就像数据全丢了。
 * 这条在 `docs/容器管理 设计.md` §三 与 `compose.ts` 顶部都记着，真机验过。
 *
 * 以前 `DockerService.kindOf` 只做**字符串比较**（`within(dir, projectRoot)`）：`/volume1/docker`
 * 没挂进来时它照样说「能部署」，界面上按钮是亮的，点下去才在 `runCompose` 里抛错。
 * 更糟的是数据库快捷安装 —— 它直接往那个路径写文件，写进的是**容器自己的**文件系统，
 * 容器一重建就没了，而宿主上什么都没发生。
 *
 * **怎么判**：不做字符串猜，直接看**是不是同一个目录**。宿主根按 `/:/host` 挂在 `/host`
 * （WebDAV 的根就是它，必需项拆不掉），所以宿主上的 `/volume1/docker` 在容器里也能从
 * `/host/volume1/docker` 看到。同一个目录 → inode 相同。2026-10-20 真机实测：
 *
 *   stat -c '%d:%i' /volume1/docker /host/volume1/docker  →  64768:137101313  64768:137101313
 *
 * 反过来，没按原路径挂的目录（如宿主上的 `/volume1/@appstore`）只有 `/host` 下那一条，
 * 容器内原路径根本不存在 —— 判成「不可达」，与今天的实际行为一致（Kura 只把它当 external）。
 *
 * 失败方向是**安全的那一边**：判不清就当成不可达（只读），绝不冒险往错的路径上写。
 */

/** 一个文件的身份：设备号 + inode。跨不过去的两个东西 dev:ino 一定不同。 */
export type StatKey = (path: string) => string | undefined

export function statKey(path: string): string | undefined {
  try {
    const s = statSync(path)
    return `${s.dev}:${s.ino}`
  } catch {
    // 不存在 / 没权限 / 平台不支持（Windows 上 ino 对目录不可靠）都归到这里
    return undefined
  }
}

export interface MountCheckOptions {
  /** 容器里的宿主根；默认 `/host` */
  hostRoot?: string
  /** 取文件身份，默认 statSync（测试可换） */
  key?: StatKey
}

/**
 * 容器内路径 `path` 是否就是宿主上那个目录。
 *
 * 三种情况要分开：
 * - 宿主根不在（不在容器里跑、或是单测的临时目录）→ **没法比**，退回「它存在就算可达」。
 *   这时本来也没有「容器路径 / 宿主路径」两套坐标的问题。
 * - 两边都在且 dev:ino 相同 → 真的挂进来了。
 * - 宿主那边不在 → 容器里这个是自己造出来的目录，不是宿主的 → 不可达。
 */
export function isMounted(path: string, options: MountCheckOptions = {}): boolean {
  const key = options.key ?? statKey
  const hostRoot = options.hostRoot ?? '/host'
  const normalized = trimSlash(posix.normalize(path))
  const hostRootKey = key(hostRoot)
  if (!hostRootKey) return key(normalized) !== undefined
  const here = key(normalized)
  if (!here) return false
  const there = key(hostSide(normalized, hostRoot))
  return there !== undefined && there === here
}

/** 去掉尾斜杠（`/volume1/docker/` 与 `/volume1/docker` 是同一个目录，比较时要一样）。 */
function trimSlash(path: string): string {
  return path.replace(/\/+$/, '') || '/'
}

/** 宿主路径对应的容器内路径。 */
export function hostSide(path: string, hostRoot = '/host'): string {
  return trimSlash(posix.join(hostRoot, posix.normalize(path)))
}

/**
 * 项目目录的两套坐标。
 *
 * `scanRoot` 是**实际去 readdir 的地方**：原路径可达就扫原路径，不可达就扫 `/host` 下那份 ——
 * 这样目录没挂对时用户仍然**看得见**自己的项目（只是不能部署），而不是整个列表空掉。
 * 报给界面的 `dir` 一律是**宿主原路径**（用户在自己的 NAS 上要对得上）。
 */
export interface ProjectRoots {
  /** 宿主原路径，也是 compose 要用的执行目录 */
  projectRoot: string
  /** 去哪 readdir；与原路径不同就说明没挂对 */
  scanRoot: string
  /** 原路径可达 = 能部署、能编辑 */
  reachable: boolean
  /** 补救建议（不可达时给界面用）；可达时是空串 */
  hint: string
}

/**
 * 算出项目目录的两套坐标。
 *
 * 注意 `scanRoot` 只是**能读**的地方，不代表可以部署：绝对不能让 compose 在它下面执行
 * （相对路径会被解析成宿主上不存在的路径，dockerd 建个空目录挂进去）。所以
 * `scanRoot !== projectRoot` 时一律 `reachable: false`，界面上只读。
 */
export function resolveProjectRoots(projectRoot: string, options: MountCheckOptions = {}): ProjectRoots {
  const root = trimSlash(posix.normalize(projectRoot))
  if (isMounted(root, options)) return { projectRoot: root, scanRoot: root, reachable: true, hint: '' }
  const hostRoot = options.hostRoot ?? '/host'
  const key = options.key ?? statKey
  const fallback = hostSide(root, hostRoot)
  if (key(fallback)) {
    return {
      projectRoot: root,
      scanRoot: fallback,
      reachable: false,
      hint: `项目目录 ${root} 没有按原路径挂进 kura-server（现在只能从 ${fallback} 看到它）。要能在 Kura 里部署，compose 里加一行 ${root}:${root} 再 up -d。`,
    }
  }
  return {
    projectRoot: root,
    scanRoot: root,
    reachable: false,
    hint: `项目目录 ${root} 在 NAS 上不存在，或者没挂进 kura-server。`,
  }
}

/** 扫出来的路径（可能是 `/host/...`）换回宿主原路径。 */
export function toOriginalPath(path: string, roots: ProjectRoots): string {
  const normalized = trimSlash(posix.normalize(path))
  if (roots.scanRoot === roots.projectRoot) return normalized
  const prefix = trimSlash(posix.normalize(roots.scanRoot))
  if (normalized === prefix) return roots.projectRoot
  if (!normalized.startsWith(`${prefix}/`)) return normalized
  return trimSlash(posix.normalize(posix.join(roots.projectRoot, normalized.slice(prefix.length))))
}
