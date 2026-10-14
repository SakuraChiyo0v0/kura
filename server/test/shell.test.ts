import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import http from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WebSocket } from 'ws'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AuditLog } from '../src/shell/audit.js'
import { createShellServer, internalToken } from '../src/shell/server.js'
import { nsenterInvocation, type PtyOptions, type PtySession } from '../src/shell/pty.js'

/**
 * S3 判据：终端可用且 resize 生效；特权容器**只认内部令牌**（拿错令牌必须 401）。
 * 这里注入一个假 PTY（本机没装 node-pty），真 PTY 由容器里的 node-pty 提供。
 */

class FakePty implements PtySession {
  static last: FakePty | undefined
  readonly pid = 4242
  written: string[] = []
  sizes: Array<[number, number]> = []
  killed = false
  private dataListener?: (d: string) => void
  private exitListener?: (e: { exitCode: number }) => void

  constructor(readonly options: PtyOptions) {
    FakePty.last = this
  }

  onData(l: (d: string) => void): void {
    this.dataListener = l
  }
  onExit(l: (e: { exitCode: number }) => void): void {
    this.exitListener = l
  }
  write(data: string): void {
    this.written.push(data)
  }
  resize(cols: number, rows: number): void {
    this.sizes.push([cols, rows])
  }
  kill(): void {
    this.killed = true
  }
  emit(data: string): void {
    this.dataListener?.(data)
  }
  exit(code = 0): void {
    this.exitListener?.({ exitCode: code })
  }
}

const TOKEN = 'internal-token-abc'

let dir = ''
let audit: AuditLog
let server: http.Server
let port = 0
let execCalls: Array<{ cmd: string; cwd: string; timeoutMs: number }> = []

beforeEach(async () => {
  FakePty.last = undefined
  execCalls = []
  dir = mkdtempSync(join(tmpdir(), 'kura-shell-'))
  audit = new AuditLog(join(dir, 'audit.log'))
  server = createShellServer({
    token: TOKEN,
    audit,
    maxSessions: 2,
    spawnPty: (options) => new FakePty(options),
    runExec: async (cmd, cwd, timeoutMs) => {
      execCalls.push({ cmd, cwd, timeoutMs })
      return { exitCode: 0, stdout: `ran:${cmd}`, stderr: '' }
    },
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  port = (server.address() as { port: number }).port
})

afterEach(async () => {
  server.closeAllConnections()
  await new Promise<void>((r) => server.close(() => r()))
  rmSync(dir, { recursive: true, force: true })
})

function wsConnect(path: string, headers: Record<string, string>): Promise<WebSocket> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`, { headers })
  return new Promise((resolve, reject) => {
    ws.on('open', () => resolve(ws))
    ws.on('unexpected-response', (_req, res) => reject(Object.assign(new Error('rejected'), { status: res.statusCode })))
    ws.on('error', reject)
  })
}

describe('kura-shell：只认内部令牌', () => {
  it('令牌对：开 PTY、输入、resize 真的改尺寸', async () => {
    const ws = await wsConnect('/api/tty', { 'x-kura-token': TOKEN, 'x-kura-user': 'gw' })
    expect(FakePty.last?.options.args).toEqual(nsenterInvocation('/bin/bash').args)
    // 下行：PTY 输出原样发
    const got = new Promise<string>((resolve) => ws.on('message', (d) => resolve(d.toString())))
    FakePty.last!.emit('hello')
    expect(await got).toBe('hello')

    ws.send('ls\r')
    ws.send(JSON.stringify({ type: 'resize', cols: 120, rows: 40 }))
    await new Promise((r) => setTimeout(r, 50))
    expect(FakePty.last!.written).toEqual(['ls\r']) // resize 没被当成输入
    expect(FakePty.last!.sizes).toContainEqual([120, 40])
    ws.close()
  })

  it('令牌错 / 没令牌：握手 401', async () => {
    await expect(wsConnect('/api/tty', { 'x-kura-token': 'wrong' })).rejects.toMatchObject({ status: 401 })
    await expect(wsConnect('/api/tty', {})).rejects.toMatchObject({ status: 401 })
    await expect(wsConnect('/api/tty', { authorization: 'Bearer wrong' })).rejects.toMatchObject({ status: 401 })
  })

  it('并发上限：超过就 429', async () => {
    const a = await wsConnect('/api/tty', { 'x-kura-token': TOKEN })
    const b = await wsConnect('/api/tty', { 'x-kura-token': TOKEN })
    await expect(wsConnect('/api/tty', { 'x-kura-token': TOKEN })).rejects.toMatchObject({ status: 429 })
    a.close()
    b.close()
  })

  it('health 不用令牌（kura-server 拿它判活）', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`)
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ app: 'kura-shell' })
  })
})

describe('kura-shell：exec 与审计', () => {
  it('exec 认证后执行并返回结果', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/exec`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-kura-token': TOKEN, 'x-kura-user': 'gw' },
      body: JSON.stringify({ cmd: 'ls -la', cwd: '/volume1', timeout: 5000 }),
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ exitCode: 0, stdout: 'ran:ls -la' })
    expect(execCalls).toEqual([{ cmd: 'ls -la', cwd: '/volume1', timeoutMs: 5000 }])
  })

  it('exec 令牌错：401，且不执行', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/exec`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-kura-token': 'wrong' },
      body: JSON.stringify({ cmd: 'rm -rf /' }),
    })
    expect(res.status).toBe(401)
    expect(execCalls).toHaveLength(0)
  })

  it('审计记下会话开关与 exec（谁、何时、命令、退出码）', async () => {
    await fetch(`http://127.0.0.1:${port}/api/exec`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-kura-token': TOKEN, 'x-kura-user': 'alice' },
      body: JSON.stringify({ cmd: 'whoami' }),
    })
    const ws = await wsConnect('/api/tty', { 'x-kura-token': TOKEN, 'x-kura-user': 'bob' })
    ws.close()
    await new Promise((r) => setTimeout(r, 50))
    const lines = readFileSync(join(dir, 'audit.log'), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
    const exec = lines.find((l) => l.action === 'exec')
    expect(exec).toMatchObject({ user: 'alice', detail: 'whoami', exitCode: 0 })
    expect(lines.some((l) => l.action === 'pty-open' && l.user === 'bob')).toBe(true)
    expect(lines.some((l) => l.action === 'pty-close' && l.user === 'bob')).toBe(true)
  })
})
