import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { WebSocketServer } from 'ws'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ConsoleSession, ConsoleTerminal, type ConsoleCredentials, type TerminalEvent } from './console.js'

/** 假终端服务：照 kura-server 的行为 —— 不认证，直接开 PTY；`?token=` 只是归属标签。 */
class FakeConsole {
  readonly server = http.createServer((req, res) => void this.handle(req, res))
  readonly wss = new WebSocketServer({ noServer: true })
  url = ''
  received: string[] = []
  maxSessions = 4
  active = 0

  async start(): Promise<this> {
    this.server.on('upgrade', (req, socket, head) => {
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
    for await (const _chunk of req) {
      // 请求体用不上，读完就行
    }
    if (req.url === '/api/me') {
      res.statusCode = 200
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
  it('不需要凭据 → 开 PTY → 输入回显', async () => {
    const t = open({})
    await t.term.open()
    await t.until(() => t.text().includes('welcome'))
    t.term.write('ls\r')
    await t.until(() => t.text().includes('ls'))
    expect(t.text()).toBe('welcome$ ls\r')
    expect(fake.received).toEqual(['ls\r'])
    t.term.close()
  })

  it('也可以带 API Token（`?token=` 只作归属标签）', async () => {
    const t = open({ token: 'nsc_good' })
    await t.term.open()
    await t.until(() => t.text().includes('welcome'))
    t.term.close()
  })

  it('并发上限：429 说明原因', async () => {
    fake.maxSessions = 0
    const t = open({})
    await t.term.open()
    await t.until(() => t.status()?.type === 'status' && (t.status() as { status: string }).status === 'closed')
    expect(t.status()).toMatchObject({ status: 'closed', message: expect.stringMatching(/上限/) })
  })

  it('shell 退出：标签提示会话已结束', async () => {
    const t = open({})
    await t.term.open()
    await t.until(() => t.text().includes('welcome'))
    t.term.write('exit\r')
    await t.until(() => t.term.isClosed)
    expect(t.status()).toMatchObject({ status: 'closed', message: '会话已结束' })
  })

  it('resize：发 JSON 控制帧，不当作输入', async () => {
    const t = open({})
    await t.term.open()
    await t.until(() => t.text().includes('welcome'))
    t.term.resize(120, 40)
    await t.until(() => fake.received.some((m) => m.includes('resize')))
    expect(JSON.parse(fake.received.find((m) => m.includes('resize'))!)).toEqual({ type: 'resize', cols: 120, rows: 40 })
    t.term.close()
  })

  it('握手完成前报的尺寸不丢：连上后补发', async () => {
    const t = open({})
    const opening = t.term.open()
    // 界面开标签后下一帧就报尺寸，这时 ws 还在 CONNECTING
    t.term.resize(100, 30)
    await opening
    await t.until(() => fake.received.some((m) => m.includes('resize')))
    expect(fake.received.filter((m) => m.includes('resize')).map((m) => JSON.parse(m))).toEqual([{ type: 'resize', cols: 100, rows: 30 }])
    t.term.close()
  })

  it('check：服务在就可用（带不带 Token 都一样）', async () => {
    expect(await new ConsoleSession(async () => fake.url, () => ({} as ConsoleCredentials)).check()).toMatch(/可达/)
    expect(await new ConsoleSession(async () => fake.url, () => ({ token: 'nsc_good' })).check()).toMatch(/有效/)
  })
})
