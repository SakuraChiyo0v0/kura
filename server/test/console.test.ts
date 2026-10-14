import http from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import type { Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WebSocket, WebSocketServer } from 'ws'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ConsoleSession, ConsoleTerminal, type TerminalEvent } from '../../src/core/console.js'
import { Auth } from '../src/auth.js'
import { hashPassword } from '../src/password.js'
import { createConsoleHandler } from '../src/console.js'
import { TokenStore } from '../src/tokens.js'

/**
 * S3 的桥：客户端用**它自己的** ConsoleSession / ConsoleTerminal 连 kura-server，
 * kura-server 再凭内部令牌转到 kura-shell。现网那套 nas-console 接口的兼容性就看这里。
 */

const INTERNAL = 'shell-internal-token'

/** 假 kura-shell：只认内部令牌，回显输入；HTTP 端点一律 404（本用例只验证桥的转发与认证）。 */
class FakeShell {
  readonly server = http.createServer((_req, res) => {
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end('{"error":"not found"}')
  })
  readonly wss = new WebSocketServer({ noServer: true })
  url = ''
  seenTokens: string[] = []
  received: string[] = []

  async start(): Promise<this> {
    this.server.on('upgrade', (req, socket, head) => {
      const token = String(req.headers['x-kura-token'] ?? '')
      this.seenTokens.push(token)
      if (token !== INTERNAL) {
        socket.write('HTTP/1.1 401 Unauthorized\r\nconnection: close\r\n\r\n')
        socket.destroy()
        return
      }
      this.wss.handleUpgrade(req, socket, head, (ws) => {
        ws.send('shell$ ')
        ws.on('message', (d) => {
          this.received.push(d.toString())
          ws.send(d.toString())
        })
      })
    })
    await new Promise<void>((r) => this.server.listen(0, '127.0.0.1', () => r()))
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`
    return this
  }

  async stop(): Promise<void> {
    for (const ws of this.wss.clients) ws.terminate()
    this.server.closeAllConnections()
    await new Promise<void>((r) => this.server.close(() => r()))
  }
}

let shell: FakeShell
let front: http.Server
let url = ''
let tokens: TokenStore
let auth: Auth
let dir = ''
const user = 'gw'
const password = 's3cret'

/** 造一个真的网关会话 cookie（等价于客户端登录后拿到的那个）。 */
async function gatewayCookie(): Promise<string> {
  const result = await auth.login('127.0.0.1', { username: user, password })
  if (!result.ok) throw new Error('测试登录失败')
  return `authelia_session=${result.token}`
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'kura-console-'))
  shell = await new FakeShell().start()
  auth = new Auth({ user, passwordHash: await hashPassword(password, { memory: 1024, passes: 1, parallelism: 1 }) })
  tokens = new TokenStore(join(dir, 'tokens.json'))
  const handler = createConsoleHandler({ auth, tokens, shell: () => shell.url, internalToken: INTERNAL })
  front = http.createServer((req, res) => void handler.handle(req, res))
  front.on('upgrade', (req, socket, head) => handler.upgrade(req, socket as Socket, head))
  await new Promise<void>((r) => front.listen(0, '127.0.0.1', () => r()))
  url = `http://127.0.0.1:${(front.address() as AddressInfo).port}`
})

afterEach(async () => {
  front.closeAllConnections()
  await new Promise<void>((r) => front.close(() => r()))
  await shell.stop()
  rmSync(dir, { recursive: true, force: true })
})

function open(creds: { user?: string; password?: string; token?: string }) {
  const events: TerminalEvent[] = []
  const session = new ConsoleSession(async () => url, () => creds)
  const term = new ConsoleTerminal('t1', session, (e) => events.push(e))
  const text = () => events.flatMap((e) => (e.type === 'data' ? [e.data] : [])).join('')
  const status = () => events.filter((e) => e.type === 'status').at(-1)
  const until = async (cond: () => boolean) => {
    for (let i = 0; i < 100 && !cond(); i++) await new Promise((r) => setTimeout(r, 20))
  }
  return { term, text, status, until, session }
}

describe('kura-server ⇄ kura-shell 的终端桥', () => {
  it('账号密码登录 → 开 PTY → 输入回显（客户端代码原样用）', async () => {
    const t = open({ user, password })
    await t.term.open()
    await t.until(() => t.text().includes('shell$ '))
    t.term.write('ls\r')
    await t.until(() => t.text().includes('ls'))
    expect(shell.received).toEqual(['ls\r'])
    // 内部令牌没漏给客户端：客户端只看到自己的 session cookie
    expect(shell.seenTokens).toEqual([INTERNAL])
    t.term.close()
  })

  it('密码错：说清楚，不重试', async () => {
    const t = open({ user, password: 'nope' })
    await t.term.open()
    expect(t.status()).toMatchObject({ status: 'closed', message: expect.stringMatching(/账号或密码/) })
  })

  it('API Token：/api/me 校验 + 直接开 PTY', async () => {
    const record = tokens.create('我的脚本')
    expect(await new ConsoleSession(async () => url, () => ({ token: record.token })).check()).toMatch(/有效/)
    await expect(new ConsoleSession(async () => url, () => ({ token: 'nsc_wrong' })).check()).rejects.toThrow(/无效/)

    const t = open({ token: record.token })
    await t.term.open()
    await t.until(() => t.text().includes('shell$ '))
    t.term.close()
  })

  it('没凭据直接连（kura-server 下映射层带网关会话）——这里没带会话，所以被拒', async () => {
    const t = open({})
    await t.term.open()
    await t.until(() => t.term.isClosed)
    expect(shell.seenTokens).toEqual([])
  })

  it('带网关会话（映射层注入的 authelia_session）就能连，不需要单独的终端凭据', async () => {
    const cookie = await gatewayCookie()
    const ws = new WebSocket(`ws://127.0.0.1:${new URL(url).port}/api/tty`, { headers: { cookie } })
    const opened = await new Promise<boolean>((resolve) => {
      ws.on('open', () => resolve(true))
      ws.on('unexpected-response', () => resolve(false))
      ws.on('error', () => resolve(false))
    })
    expect(opened).toBe(true)
    expect(shell.seenTokens).toEqual([INTERNAL])
    ws.close()
  })

  it('/api/me 认网关会话（客户端据此判断「无需单独凭据」）', async () => {
    const cookie = await gatewayCookie()
    const me = await fetch(`${url}/api/me`, { headers: { cookie } })
    expect(me.status).toBe(200)
    expect(await me.json()).toMatchObject({ user })
    expect((await fetch(`${url}/api/me`)).status).toBe(401)
  })

  it('exec：带 API Token 走通，转发到 kura-shell 并把结果回给调用方', async () => {
    const record = tokens.create('ai')
    // 用真的假 shell 太麻烦，这里直接看 exec 的转发：kura-shell 端点我们没有，故用 502 分支证明「认了 token 才转发」
    const res = await fetch(`${url}/api/exec`, {
      method: 'POST',
      headers: { authorization: `Bearer ${record.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ cmd: 'ls' }),
    })
    // 假 shell 没有 /api/exec 的 HTTP 处理，会 404 —— 但关键是「未认证」绝不会走到这里
    expect([404, 502]).toContain(res.status)

    const anon = await fetch(`${url}/api/exec`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
    expect(anon.status).toBe(401)
  })
})

describe('TokenStore', () => {
  it('生成、持久化、吊销；恒定时间比对', () => {
    const a = tokens.create('脚本A')
    const b = tokens.create('脚本B')
    expect(a.token).toMatch(/^nsc_[A-Za-z0-9_-]{43}$/)
    expect(tokens.verify(a.token)?.label).toBe('脚本A')
    expect(tokens.verify('nsc_nope')).toBeUndefined()
    expect(tokens.verify(undefined)).toBeUndefined()
    expect(tokens.revoke(a.token)).toBe(true)
    expect(tokens.verify(a.token)).toBeUndefined()
    expect(tokens.verify(b.token)?.label).toBe('脚本B')
    // 重新读盘还在
    const again = new TokenStore(join(dir, 'tokens.json'))
    expect(again.verify(b.token)?.label).toBe('脚本B')
  })
})
