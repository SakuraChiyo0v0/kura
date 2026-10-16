import { spawn } from 'node:child_process'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { join, posix } from 'node:path'

/**
 * compose 项目的发现与执行。
 *
 * 项目从两处来，按名字合并（设计 §三）：
 * 1. 容器上 Docker Compose 自己打的标签（`com.docker.compose.project*`）—— 跑过的项目都有；
 * 2. 项目目录（默认 /volume1/docker）下带 compose 文件的子目录 —— 停掉、从没起过的也能列出来。
 * 绿联自己的 SQLite 只是登记，不存 compose 内容，Kura 不读它（D0 实测，路径还会过时）。
 *
 * **compose 必须在宿主原路径下执行**：compose 里的相对路径（`./state:/state`）是按执行目录解析后交给 dockerd 的；
 * 在 /host/volume1/... 下跑，dockerd 拿到的是宿主上不存在的路径，会**建一个空目录挂进去**，应用看着像数据全丢了。
 * 所以项目目录要按原路径挂进容器（compose 里 `/volume1/docker:/volume1/docker`），这里只认原路径。
 */

export const composeFileNames = ['compose.yaml', 'compose.yml', 'docker-compose.yaml', 'docker-compose.yml']

/** 项目名：compose 自己的规则（小写字母数字、`-`、`_`，字母数字开头）。 */
const projectRe = /^[a-z0-9][a-z0-9_-]{0,62}$/

export function checkProjectName(name: string): string {
  if (!projectRe.test(name)) throw new Error(`不合法的项目名：${JSON.stringify(name)}`)
  return name
}

export interface DiscoveredDir {
  name: string
  dir: string
  configFiles: string[]
}

/** 扫一层项目目录：每个子目录里有 compose 文件就算一个项目（不递归，和 /volume1/docker/<名字>/ 的约定一致）。 */
export function scanProjectRoot(root: string): DiscoveredDir[] {
  if (!root || !existsSync(root)) return []
  const out: DiscoveredDir[] = []
  let entries: string[]
  try {
    entries = readdirSync(root)
  } catch {
    return []
  }
  for (const entry of entries.sort()) {
    const dir = posix.join(root, entry)
    try {
      if (!statSync(dir).isDirectory()) continue
    } catch {
      continue
    }
    const files = composeFileNames.filter((f) => existsSync(join(dir, f)))
    if (files.length === 0) continue
    // compose 默认的项目名 = 目录名小写、去掉不合法字符
    const name = entry.toLowerCase().replace(/[^a-z0-9_-]/g, '')
    if (!projectRe.test(name)) continue
    out.push({ name, dir, configFiles: files.map((f) => posix.join(dir, f)) })
  }
  return out
}

/** 路径是否在某个根目录下（都是宿主上的 posix 路径）。 */
export function within(path: string, root: string): boolean {
  if (!root) return false
  const p = posix.normalize(path)
  const r = posix.normalize(root).replace(/\/+$/, '')
  return p === r || p.startsWith(`${r}/`)
}

/** `down-volumes` 只在「删除项目」且显式勾选「同时删除卷」时用，界面上不单独露出。 */
export type ComposeAction = 'up' | 'down' | 'restart' | 'pull' | 'down-volumes'

/** 每个动作对应的 compose 参数。只有这几个，不接受调用方传任意参数。 */
export function composeArgs(action: ComposeAction): string[] {
  switch (action) {
    case 'up':
      return ['up', '-d', '--remove-orphans']
    case 'down':
      // 不带 -v：卷默认保留
      return ['down']
    case 'down-volumes':
      // 会丢数据：只有删除项目时勾了「同时删除卷」才走这里
      return ['down', '-v']
    case 'restart':
      return ['restart']
    case 'pull':
      return ['pull']
  }
}

export interface ComposeRun {
  /** 输出（stdout 与 stderr 合在一起，和终端里看到的一样） */
  onOutput(listener: (text: string) => void): void
  /** 结束：退出码；进程起不来时是 -1 */
  done: Promise<number>
  kill(): void
}

export interface ComposeTarget {
  name: string
  dir: string
  configFiles: string[]
}

/**
 * 跑一次 `docker compose`。命令与参数都是数组，不经 shell —— 项目名、路径不可能拼出注入。
 * `bin` 可替换，测试里换成假的。
 */
export function runCompose(target: ComposeTarget, action: ComposeAction, bin = 'docker', prefix: string[] = []): ComposeRun {
  const args = [...prefix, 'compose', '-p', checkProjectName(target.name)]
  // 项目目录外的项目（如 /tmp/xxx）没挂进容器：目录在这里不存在，spawn 会报一个误导人的 `spawn docker ENOENT`。
  // down 只靠项目名就够（compose 按标签找容器、网络），不需要 compose 文件，也不需要在那个目录里跑
  const reachable = existsSync(target.dir)
  if (!reachable && action !== 'down') {
    throw new Error(`项目目录 ${target.dir} 没有挂进 kura-server，无法执行 compose ${action}`)
  }
  if (reachable) for (const file of target.configFiles) args.push('-f', file)
  args.push(...composeArgs(action))
  const listeners: Array<(text: string) => void> = []
  const emit = (text: string) => {
    for (const l of listeners) l(text)
  }
  const child = spawn(bin, args, { cwd: reachable ? target.dir : '/', env: { ...process.env, COMPOSE_PROGRESS: 'plain', COMPOSE_ANSI: 'never' } })
  child.stdout?.on('data', (d: Buffer) => emit(d.toString('utf8')))
  child.stderr?.on('data', (d: Buffer) => emit(d.toString('utf8')))
  const done = new Promise<number>((resolve) => {
    child.on('error', (error) => {
      emit(`\n无法执行 ${bin} compose：${error.message}\n`)
      resolve(-1)
    })
    child.on('close', (code) => resolve(code ?? -1))
  })
  return {
    onOutput: (listener) => listeners.push(listener),
    done,
    kill: () => child.kill('SIGTERM'),
  }
}
