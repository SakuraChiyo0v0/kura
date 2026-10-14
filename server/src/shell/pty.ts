import { createRequire } from 'node:module'

/**
 * PTY 的创建。**唯一**用到 node-pty 的地方，抽出来是为了两件事：
 * 1. 能在没装 node-pty 的机器上跑测试（测试注入假实现，不会 import 到 node-pty）；
 * 2. 「装不上 node-pty」的报错集中在一处，说清楚它在特权容器里。
 *
 * node-pty 是原生模块（要编译），只在 kura-shell 容器里用，且**打包进镜像** ——
 * 不要在容器里跑 `npm i` 现场编译，UGOS 的内核与 glibc 版本不可控。
 * 所以这里用 `createRequire` 惰性加载：模块本身不 import node-pty，只有真要起 PTY 时才加载。
 */
export interface PtySession {
  readonly pid: number
  onData(listener: (data: string) => void): void
  onExit(listener: (event: { exitCode: number; signal?: number }) => void): void
  write(data: string): void
  resize(cols: number, rows: number): void
  kill(): void
}

export interface PtyOptions {
  file: string
  args: string[]
  cols: number
  rows: number
  cwd: string
  env: NodeJS.ProcessEnv
}

export type PtySpawner = (options: PtyOptions) => PtySession

/** node-pty 里我们用到的那一小部分（不 import 它的类型：它只在容器里装，本机没有）。 */
interface NodePty {
  spawn(file: string, args: string[], options: { name: string; cols: number; rows: number; cwd: string; env: NodeJS.ProcessEnv }): {
    pid: number
    onData(listener: (data: string) => void): void
    onExit(listener: (event: { exitCode: number; signal?: number }) => void): void
    write(data: string): void
    resize(cols: number, rows: number): void
    kill(): void
  }
}

/** nsenter 进宿主 PID 1 的各个命名空间，再开登录 shell —— 沿用 nas-console 的执行机制。 */
export function nsenterInvocation(shell = '/bin/bash'): { file: string; args: string[] } {
  return { file: 'nsenter', args: ['-t', '1', '-m', '-u', '-i', '-n', '-p', '--', shell, '-l'] }
}

/** 惰性加载 node-pty 并起 PTY。加载不到时给一条能看懂的报错。 */
export const nodePtySpawner: PtySpawner = (options) => {
  const require = createRequire(import.meta.url)
  let pty: NodePty
  try {
    pty = require('node-pty') as NodePty
  } catch (error) {
    throw new Error(`node-pty 没装上（${(error as Error).message}）。它只在 kura-shell 容器里用，应该随镜像打包。`)
  }
  const proc = pty.spawn(options.file, options.args, {
    name: 'xterm-256color',
    cols: options.cols,
    rows: options.rows,
    cwd: options.cwd,
    env: options.env,
  })
  return {
    pid: proc.pid,
    onData: (listener) => proc.onData(listener),
    onExit: (listener) => proc.onExit(({ exitCode, signal }) => listener({ exitCode, signal })),
    write: (data) => proc.write(data),
    resize: (cols, rows) => proc.resize(cols, rows),
    kill: () => proc.kill(),
  }
}
