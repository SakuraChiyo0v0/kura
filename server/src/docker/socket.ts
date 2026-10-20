import http from 'node:http'
import { statSync } from 'node:fs'

/**
 * Docker socket 的自动发现。
 *
 * **为什么需要它**：以前只有 `KURA_DOCKER_SOCKET` 配了才开 Docker 页（`main.ts` 里一个
 * `existsSync(process.env.KURA_DOCKER_SOCKET)`）。没配就整个功能不开，用户得去 NAS 上改
 * compose 再 `up -d` —— 一个「自动检测得到的东西」被做成了「手工配置项」。
 *
 * 而 kura-server **本来就**把宿主根挂进来了（`/:/host`，WebDAV 的根就是它，拆不掉），
 * 宿主的 `/run/docker.sock` 自然也在 `/host/run/docker.sock`。2026-10-20 真机实测：
 *
 *   stat -c '%d:%i' /var/run/docker.sock /host/run/docker.sock  →  25:1633  25:1633

 *   经 /host/run/docker.sock 调 /v1.43/info                     →  29.6.2 Debian 12
 *
 * 同一个 inode、能正常应答。所以功能一直在，只是没人告诉程序去那儿看看。
 *
 * **只发起出站请求、只连本机 socket**（AGENTS.md §四.1/2）：socketPath 是本机文件系统路径，
 * 不开任何监听。这里也不新增权限面 —— `/:/host` 已经是读写全宿主，socket 是同一宿主的另一个入口。
 */

export interface DockerSocket {
  /** 容器里连 Docker API 用的路径 */
  path: string
  /**
   * 这个 socket 在**宿主**上的路径。
   * 自更新要起一个短命兄弟容器（`selfupdate.ts`），那边得按宿主路径挂进去 ——
   * 容器内路径（如 `/host/run/docker.sock`）在宿主上不存在，照它挂会挂出一个空目录。
   */
  hostPath: string
  /** 怎么找到的：界面要如实说，让人知道自己开了什么 */
  source: 'env' | 'mounted' | 'host-root'
}

/** 容器里的宿主根（compose 里 `/:/host`，与 webdavDefaults.root 同一个）。 */
export const hostRoot = '/host'

export interface FindOptions {
  /** `KURA_DOCKER_SOCKET` 的值（可能没配） */
  env?: string
  /** 容器里的宿主根，默认 `/host`（测试可换） */
  hostRoot?: string
  /** 判断是不是一个真实存在的 socket 文件（默认 statSync().isSocket()） */
  isSocket?: (path: string) => boolean
  /** 真发一次 `GET /_ping`，确认 daemon 活着。默认走真请求 */
  ping?: (path: string) => Promise<boolean>
  log?: (message: string, fields?: Record<string, unknown>) => void
}

/** 按优先级排候选。配了环境变量就只认它 —— 显式配置优先，别让自动探测把用户的选择盖掉。 */
export function socketCandidates(env: string | undefined, root = hostRoot): DockerSocket[] {
  const configured = env?.trim()
  if (configured) {
    // 显式配的：宿主路径当同路径挂载处理（compose 里一般就写成同一路径）
    return [{ path: configured, hostPath: configured, source: 'env' }]
  }
  return [
    // 有人单独挂进来的（compose 里 `/var/run/docker.sock:/var/run/docker.sock`）
    { path: '/var/run/docker.sock', hostPath: '/var/run/docker.sock', source: 'mounted' },
    { path: '/run/docker.sock', hostPath: '/run/docker.sock', source: 'mounted' },
    // 经 `/:/host` 顺带看到的：容器内路径在宿主上是去掉 hostRoot 前缀的那个
    { path: `${root}/run/docker.sock`, hostPath: '/run/docker.sock', source: 'host-root' },
    { path: `${root}/var/run/docker.sock`, hostPath: '/var/run/docker.sock', source: 'host-root' },
  ]
}

/**
 * 这个路径上有没有一个 socket。
 *
 * **Windows 上这个问题的答案是「看不出来」，而且有四种不同的错法**
 * （2026-10-20 实测，CI 的接线测试先红的，下面每条都真撞到了）：
 *
 *   1. `statSync('\\\\.\\pipe\\xxx')` **有时抛 `EBUSY`**；
 *   2. 有时不抛、正常返回，但 `isSocket()` / `isFIFO()` **都是 false**；
 *   3. 有时返回 **`isFile() === true`** —— 把命名管道当成普通文件（这就是最后抓到的那个）；
 *   4. 探过一次之后，同一路径的 `existsSync` **变 false 且永久如此**，
 *      而那个管道其实还活着、`http.request` 照样连得上。
 *
 * 第 4 条还废掉了「先 existsSync 再 stat，失败回退」这种写法：第一版就这么写，
 * 第一次找成功、第二次起全是 undefined。
 *
 * **结论：文件系统在 Windows 上给不出可信答案，判定只认 ping。**
 * 这个函数因此退化成「只在 Unix 上做一次廉价预筛」：只在**明确是 Unix socket 之外的
 * 普通文件 / 目录**时否决，并且只在非 Windows 上这么做。
 *
 * 为什么这个 bug 只在 Windows 上出现：Node 的 unix socket 在 Windows 上就是命名管道，
 * 而 Docker 跑在 NAS（Linux）上，日常开发碰不到 —— 除非用假 dockerd（CI 就是这么干的）。
 */
function defaultIsSocket(path: string): boolean {
  // Windows：文件系统说什么都不信，全部交给 ping（它没副作用，可以反复问）。
  if (process.platform === 'win32') return true
  // 不用 existsSync：见上面第 4 条。
  try {
    const stat = statSync(path)
    // 普通文件 / 目录肯定不是 socket，省一次没意义的连接
    return !(stat.isFile() || stat.isDirectory())
  } catch (error) {
    // ENOENT 之外的情况说不准，留给 ping
    return (error as NodeJS.ErrnoException).code !== 'ENOENT'
  }
}

/** `GET /_ping` 是最轻的活体检查（返回体就一个 OK）。超时短：探不到就当没有。 */
function defaultPing(path: string, timeoutMs = 3_000): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.request({ socketPath: path, path: '/_ping', method: 'GET', timeout: timeoutMs }, (res) => {
      res.resume()
      resolve((res.statusCode ?? 0) === 200)
    })
    req.on('timeout', () => req.destroy(new Error('超时')))
    req.on('error', () => resolve(false))
    req.end()
  })
}

/**
 * 找到第一个**真能应答**的 socket。找不到返回 undefined（没开 Docker 功能）。
 *
 * 为什么除了 `isSocket` 还要 ping：文件在、dockerd 死了的情况（升级中、宿主重启中）很常见，
 * 只判类型会让 Docker 页显示成「已启用但一用就报连不上」。
 *
 * **ping 会重试**：Windows 命名管道上连续连接会**交替失败**（实测 200 / socket hang up /
 * 200 / socket hang up，同一个服务端、同一个路径）。一次不通不代表它不通 —— 直接判死会让
 * 「同一个 socket 第二次找就说没有」这种烂状态出现。连两次都不通才算真的不通。
 */
export async function findDockerSocket(options: FindOptions = {}): Promise<DockerSocket | undefined> {
  const isSocket = options.isSocket ?? defaultIsSocket
  const ping = options.ping ?? ((path: string) => defaultPing(path))
  const candidates = socketCandidates(options.env, options.hostRoot ?? hostRoot)
  for (const candidate of candidates) {
    if (!isSocket(candidate.path)) continue
    if (!(await answered(ping, candidate.path))) {
      options.log?.('发现 docker socket 但没应答，跳过', { 路径: candidate.path })
      continue
    }
    return candidate
  }
  return undefined
}

/** 连两次都失败才算没应答（原因见上面的注释）。 */
async function answered(ping: (path: string) => Promise<boolean>, path: string): Promise<boolean> {
  for (let attempt = 0; attempt < 2; attempt++) {
    if (await ping(path)) return true
  }
  return false
}
