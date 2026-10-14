import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { WebSocketServer } from 'ws'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ConsoleSession, ConsoleTerminal, type ConsoleCredentials, type TerminalEvent } from './console.js'

/** 按 nas-console server.ts 的样子：/api/login 发 session cookie，/api/tty 握手阶段验 cookie 或 ?token=。 */
class FakeConsole {
  readonly server = http.createServer((req, res) => void this.handle(req, res))
  readonly wss = new WebSocketServer({ noServer: true })
  url = ''
  sessions = new Set<string>()
  logins = 0
  received: string[] = []
  maxSessions = 4
  active = 0

  async start(): Promise<this> {
    this.server.on('upgrade', (req, socket, head) => {
      const url = new URL(req.url ?? '/', 'http://x')
      const cookie = /session=([^;]+)/.exec(req.headers.cookie ?? '')?.[1]
      const ok = (cookie && this.sessions.has(cookie)) || url.searchParams.get('token') === 'nsc_good'
      if (!ok) {
        socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n')
        socket.destroy()
        return
      }
      if (this.active >= this.maxSessions) {
        socket.write('HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\n\r\n')
        socket.destroy()
        return
      }
      this.wss.handleUpgrade(req, socket, head, (ws) => {
        this.active += 1
        ws.send('welcome$ ')
        ws.on('message', (data) => {
          const text = data.toString()
          this.received.push(text)
          if (text === 'exit\r') ws.close()
          else ws.send(text) // 回显
        })
        ws.on('close', () => (this.active -= 1))
      })
    })
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve))
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`
    return this
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse) {
    let body = ''
    for await (const chunk of req) body += chunk
    if (req.url === '/api/login') {
      this.logins += 1
      const { username, password } = JSON.parse(body || '{}')
      if (username !== 'admin' || password !== 'pw') {
        res.statusCode = 401
        return res.end('{"error":"bad"}')
      }
      const id = `S${this.logins}`
      this.sessions.add(id)
      res.setHeader('set-cookie', `session=${id}; Path=/; HttpOnly; SameSite=Lax`)
      return res.end('{"ok":true}')
    }
    if (req.url === '/api/me') {
      res.statusCode = req.headers.authorization === 'Bearer nsc_good' ? 200 : 401
      return res.end('{}')
    }
    res.statusCode = 404
    res.end()
  }

  async stop() {
    for (const ws of this.wss.clients) ws.terminate()
    this.server.closeAllConnections()
    await new Promise<void>((resolve) => this.server.close(() => resolve()))
  }
}

let fake: FakeConsole
beforeEach(async () => {
  fake = await new FakeConsole().start()
})
afterEach(() => fake.stop())

function open(creds: ConsoleCredentials, session = new ConsoleSession(async () => fake.url, () => creds)) {
  const events: TerminalEvent[] = []
  const term = new ConsoleTerminal('t1', session, (e) => events.push(e))
  const text = () => events.flatMap((e) => (e.type === 'data' ? [e.data] : [])).join('')
  const status = () => events.filter((e) => e.type === 'status').at(-1)
  const until = async (cond: () => boolean) => {
    for (let i = 0; i < 100 && !cond(); i++) await new Promise((r) => setTimeout(r, 20))
  }
  return { term, events, text, status, until, session }
}

describe('ConsoleTerminal', () => {
  it('账号密码登录 → 开 PTY → 输入回显', async () => {
    const t = open({ user: 'admin', password: 'pw' })
    await t.term.open()
    await t.until(() => t.text().includes('welcome'))
    t.term.write('ls\r')
    await t.until(() => t.text().includes('ls'))
    expect(t.text()).toBe('welcome$ ls\r')
    expect(fake.received).toEqual(['ls\r'])
    t.term.close()
  })

  it('也认 API Token', async () => {
    const t = open({ token: 'nsc_good' })
    await t.term.open()
    await t.until(() => t.text().includes('welcome'))
    expect(fake.logins).toBe(0)
    t.term.close()
  })

  it('session 在服务端失效：握手 401 后自动重登一次', async () => {
    const creds = { user: 'admin', password: 'pw' }
    const session = new ConsoleSession(async () => fake.url, () => creds)
    const first = open(creds, session)
    await first.term.open()
    await first.until(() => first.text().includes('welcome'))
    first.term.close()
    fake.sessions.clear() // 服务端重启、session 过期
    const second = open(creds, session)
    await second.term.open()
    await second.until(() => second.text().includes('welcome'))
    expect(fake.logins).toBe(2)
    second.term.close()
  })

  it('密码错：说清楚，不反复重试', async () => {
    const t = open({ user: 'admin', password: 'nope' })
    await t.term.open()
    expect(t.status()).toMatchObject({ status: 'closed', message: expect.stringMatching(/账号或密码/) })
    expect(fake.logins).toBe(1)
  })

  it('并发上限：429 说明原因', async () => {
    fake.maxSessions = 0
    const t = open({ token: 'nsc_good' })
    await t.term.open()
    await t.until(() => t.status()?.type === 'status' && (t.status() as { status: string }).status === 'closed')
    expect(t.status()).toMatchObject({ status: 'closed', message: expect.stringMatching(/上限/) })
  })

  it('shell 退出：标签显示会话已结束', async () => {
    const t = open({ token: 'nsc_good' })
    await t.term.open()
    await t.until(() => t.text().includes('welcome'))
    t.term.write('exit\r')
    await t.until(() => t.term.isClosed)
    expect(t.status()).toMatchObject({ status: 'closed', message: '会话已结束' })
  })

  it('没填凭据也照连（kura-server 下映射层会带网关会话）；服务端拒绝时说清楚', async () => {
    // 这个假 nas-console 不认网关会话，握手 401 —— 于是提示去设置填凭据
    const t = open({})
    await t.term.open()
    await t.until(() => t.term.isClosed)
    expect(t.status()).toMatchObject({ status: 'closed', message: expect.stringMatching(/账号、密码或 Token/) })
  })

  it('resize：发的是 JSON 控制帧，不是输入', async () => {
    const t = open({ token: 'nsc_good' })
    await t.term.open()
    await t.until(() => t.text().includes('welcome'))
    t.term.resize(120, 40)
    await t.until(() => fake.received.some((m) => m.includes('resize')))
    expect(JSON.parse(fake.received.find((m) => m.includes('resize'))!)).toEqual({ type: 'resize', cols: 120, rows: 40 })
    t.term.close()
  })

  it('check：Token 与账号密码都能测', async () => {
    expect(await new ConsoleSession(async () => fake.url, () => ({ token: 'nsc_good' })).check()).toMatch(/有效/)
    await expect(new ConsoleSession(async () => fake.url, () => ({ token: 'nsc_bad' })).check()).rejects.toThrow(/无效/)
    expect(await new ConsoleSession(async () => fake.url, () => ({ user: 'admin', password: 'pw' })).check()).toMatch(/成功/)
  })
})
