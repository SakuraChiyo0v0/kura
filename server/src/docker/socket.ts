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
  /** 每轮之间等多久（默认 1 秒）。测试传 0 */
  delayMs?: number
  /** 等多久的注入点，测试换掉真 sleep */
  sleep?: (ms: number) => Promise<void>
  /** 最多探几轮（默认 3）。1 = 只探一轮，旧行为 */
  rounds?: number
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

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * 找到第一个**真能应答**的 socket。找不到返回 undefined（没开 Docker 功能）。
 *
 * 为什么除了 `isSocket` 还要 ping：文件在、dockerd 死了的情况（升级中、宿主重启中）很常见，
 * 只判类型会让 Docker 页显示成「已启用但一用就报连不上」。
 *
 * **会轮询，不是探一次就走**（`rounds`，默认 3 轮、每轮间隔 1 秒）。
 * 2026-10-25 真机踩到：宿主重启后容器跟着起来，那一刻 dockerd 还没 listening，
 * 几秒内没应答就判死，**之后整个进程生命周期都不再重探** —— 容器好好跑着，
 * 但 Docker 页永久不可用，只能人工重启容器。socket 其实几秒后就恢复了，没人再去问它。
 *
 * 探测本身没有副作用（一个 `GET /_ping`），多问几次的代价远小于「一次没问到就永久关掉」。
 */
export async function findDockerSocket(options: FindOptions = {}): Promise<DockerSocket | undefined> {
  const isSocket = options.isSocket ?? defaultIsSocket
  const ping = options.ping ?? ((path: string) => defaultPing(path))
  const sleep = options.sleep ?? defaultSleep
  const delayMs = options.delayMs ?? 1_000
  const rounds = Math.max(1, options.rounds ?? 3)
  const candidates = socketCandidates(options.env, options.hostRoot ?? hostRoot)

  for (let round = 0; round < rounds; round++) {
    if (round > 0) {
      await sleep(delayMs)
      options.log?.('再探一次 Docker socket', { 第几轮: round + 1, 共几轮: rounds })
    }
    for (const candidate of candidates) {
      if (!isSocket(candidate.path)) continue
      if (!(await answered(ping, candidate.path))) {
        options.log?.('发现 docker socket 但没应答，跳过', { 路径: candidate.path })
        continue
      }
      return candidate
    }
  }
  return undefined
}

/**
 * 一个**能自愈**的 socket 解析器。
 *
 * 为什么不在启动时探一次就定死：容器跟着宿主重启时，dockerd 往往比容器慢一拍。
 * 2026-10-25 真机就是这个样子 —— 启动那一刻探不到，然后整个进程再也不问，
 * Docker 页永久显示「镜像太旧」（其实镜像是最新的，socket 也早就好了）。
 *
 * 现在的规则：
 *  - 探到了就用，并且缓存（不会每次请求都 ping）；
 *  - 没探到也不判死，**下一次有人要用的时侯再探**（带一点冷却，别让一串失败请求把 socket 打爆）；
 *  - 已经探到、但实际调用失败（daemon 重启换了 socket）时 `invalidate()`，下次重新探。
 *
 * 探测本身只发一个 `GET /_ping`，没有副作用。
 */
export class DockerSocketResolver {
  private found: DockerSocket | undefined
  private pending: Promise<DockerSocket | undefined> | undefined
  private lastMissAt = 0

  constructor(
    private readonly options: FindOptions = {},
    /** 冷却：探不到之后多久内不再重探（默认 10 秒） */
    private readonly cooldownMs = 10_000,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** 已经确认能用的 socket（没有就是 undefined，不触发探测）。 */
  current(): DockerSocket | undefined {
    return this.found
  }

  /** 拿 socket；没有就（按冷却）再探一次。并发调用共用同一次探测。 */
  async get(): Promise<DockerSocket | undefined> {
    if (this.found) return this.found
    if (this.pending) return this.pending
    if (this.now() - this.lastMissAt < this.cooldownMs) return undefined
    this.pending = (async () => {
      try {
        const found = await findDockerSocket(this.options)
        if (found) this.found = found
        else this.lastMissAt = this.now()
        return found
      } finally {
        this.pending = undefined
      }
    })()
    return this.pending
  }

  /**
   * 同步取**已经探到**的那个；没有就抛。
   *
   * 给 engine 的 socketPath getter 用（那两处是同步的）。没探到时先 `get()` 一下把探测
   * 启起来，再抛出 —— 这一次请求失败，但下一轮就有了。
   */
  require(): DockerSocket {
    if (!this.found) {
      void this.get()
      throw new Error('Docker socket 暂时不可用（还连不上 NAS 上的 Docker，再试一次会自动重连）')
    }
    return this.found
  }

  /** 调用方发现 socket 不能用了：丢掉缓存，下次重新探。 */
  invalidate(): void {
    this.found = undefined
    this.lastMissAt = 0
  }
}

/** 连两次都失败才算没应答（原因见上面的注释）。 */
async function answered(ping: (path: string) => Promise<boolean>, path: string): Promise<boolean> {
  for (let attempt = 0; attempt < 2; attempt++) {
    if (await ping(path)) return true
  }
  return false
}
