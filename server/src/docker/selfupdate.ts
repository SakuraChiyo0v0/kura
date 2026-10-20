import { spawn } from 'node:child_process'
import { checkProjectName } from './compose.js'

/**
 * Kura 更新自己。
 *
 * **为什么不能直接跑 compose**：`docker compose -p kura-server up -d` 会先把 kura-server 停掉再重建，
 * 而执行这条命令的进程就住在这个容器里 —— 容器一停，进程跟着没了，操作吊在半路。
 * 这不是推测：上一次经 kura-shell 试过，compose 先停掉 kura-shell、执行它的进程立刻死，8898 整个挂掉，
 * 最后靠 NAS 上留着的旧独立容器才救回来（`docs/归档/2026-10-15 容器管理 D0–D3.md`）。
 *
 * **办法**：把 compose 交给一个**不属于 kura-server 这个 compose 项目**的短命兄弟容器去跑。
 * 它由 `docker run` 起（没打 compose 的项目标签），所以 compose 重建 kura-server / kura-shell 时
 * 不在被停之列，能把这件事做完，然后 `--rm` 自己消失。它不是一个常驻部署物，
 * 镜像直接用 kura-server 自己那个（Dockerfile 里本来就装了 docker-cli + compose）。
 */

export interface SelfUpdateTarget {
  /** compose 的项目名（kura-server） */
  name: string
  /** 项目目录（宿主原路径）：compose 文件与 .env 在这里 */
  dir: string
  configFiles: string[]
  /** 跑这个兄弟容器用的镜像 —— 就是 kura-server 自己那个 */
  image: string
  /**
   * docker.sock 在**宿主**上的路径（如 `/var/run/docker.sock`）。
   * 不是容器内看到的那条 —— 自动发现可能给的是 `/host/run/docker.sock`，那个路径在宿主上不存在。
   */
  socketPath: string
}

export interface SelfUpdateRun {
  /** 起了哪个容器（审计里记下来） */
  container: string
  onOutput(listener: (text: string) => void): void
  /** 兄弟容器起来了吗：0 = 起来了，非 0 = 起不来 */
  done: Promise<number>
}

/**
 * 兄弟容器里跑的脚本。参数走位置变量进来，**脚本正文里不拼任何外部输入** ——
 * 与 compose.ts 同一个规矩：路径进不了 shell，拼不出注入。
 *
 *   $1 = 项目名，shift 之后 "$@" = `-f <文件> [-f <文件>...]`
 */
const script = 'sleep 3; n="$1"; shift; docker compose -p "$n" "$@" pull && docker compose -p "$n" "$@" up -d'

/** 开头的 sleep：等发起方那条 `docker run` 的 API 调用返回。不然它可能还没返回，compose 就把发起它的容器停了。 */
export function selfUpdateArgs(target: SelfUpdateTarget, container: string): string[] {
  const name = checkProjectName(target.name)
  const files = target.configFiles.flatMap((file) => ['-f', file])
  return [
    'run',
    '--rm',
    // -d：脱离发起方。它必须活过 kura-server 被停的那一刻
    '-d',
    '--name',
    container,
    // 只用本地已有的镜像：这一趟可能本来就在没网的时候跑，别在这上面卡住
    '--pull=never',
    // 左 = **宿主**路径，右 = 兄弟容器里的路径。两边不能写同一个：
    // 自动发现可能找到的是 `/host/run/docker.sock`（经 `/:/host` 顺带看见的那份），
    // 那个路径在宿主上不存在，照它挂会挂出一个空目录，docker CLI 找不到 socket ——
    // 自更新会**静默失效**（`docker run` 起得来，compose 在里面连不上 daemon）。
    '-v',
    `${target.socketPath}:/var/run/docker.sock`,
    // 项目目录只要读得到 compose 文件与 .env 就够了。compose 里的相对路径（./state）
    // 是按这个目录解析成绝对路径后交给 dockerd 的，dockerd 在**宿主**上建目录，不在这里写
    '-v',
    `${target.dir}:${target.dir}:ro`,
    '-w',
    target.dir,
    '--entrypoint',
    'sh',
    target.image,
    '-c',
    script,
    'kura-self-update',
    name,
    ...files,
  ]
}

export function runSelfUpdate(target: SelfUpdateTarget, bin = 'docker'): SelfUpdateRun {
  const container = `kura-self-update-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`
  const listeners: Array<(text: string) => void> = []
  const emit = (text: string): void => {
    for (const listener of listeners) listener(text)
  }
  const child = spawn(bin, selfUpdateArgs(target, container), { env: { ...process.env } })
  child.stdout?.on('data', (d: Buffer) => emit(d.toString('utf8')))
  child.stderr?.on('data', (d: Buffer) => emit(d.toString('utf8')))
  const done = new Promise<number>((resolve) => {
    child.on('error', (error) => {
      emit(`\n无法执行 ${bin} run：${error.message}\n`)
      resolve(-1)
    })
    // `-d` 一起手就返回：这个退出码是「兄弟容器**起来了**」，不是「更新成功了」——
    // 更新成不成在几秒之后，那时候 Kura 自己已经被重建，看不到结果了
    child.on('close', (code) => resolve(code ?? -1))
  })
  return { container, onOutput: (listener) => listeners.push(listener), done }
}
