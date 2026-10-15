import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { WebSocketServer } from 'ws'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DbApiError, DbClient } from './db-client.js'

/**
 * 假 kura-server 的 `/api/db/*`：够验「隧道 WS 开完才返回」这一条。
 *
 * 这条回归是真机上会静默丢字节的坑：`ws.send()` 在 CONNECTING 状态下**不发送**，
 * 只调用回调报错；而隧道的泵按 `readyState === OPEN` 过滤 —— 早返回会让本地客户端
 * 先到的那几个字节无声消失（psql 头几条消息很短，正好落在这个窗口）。
 * 冒烟里表现为「隧道连上了但一个字节都过不去」。
 */
class FakeDbServer {
  readonly server = http.createServer((_req, res) => {
    res.statusCode = 404
    res.end()
  })
  readonly wss = new WebSocketServer({ noServer: true })
  url = ''
  /** 收到一个字节日就回一个大小写翻转的（内容不重要，重要的是「字节没丢」） */
  readonly received: Buffer[] = []
  /** 故意拖慢握手：不拖的话客户端可能第一帧就已经 OPEN，测不出早返回的坑 */
  handshakeDelayMs = 120

  async start(): Promise<this> {
    this.server.on('upgrade', (req, socket, head) => {
      setTimeout(() => {
        this.wss.handleUpgrade(req, socket, head, (ws) => {
          ws.on('message', (data: Buffer) => {
            this.received.push(data)
            ws.send(Buffer.from(data))
          })
        })
      }, this.handshakeDelayMs)
    })
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve))
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`
    return this
  }

  async stop(): Promise<void> {
    for (const ws of this.wss.clients) ws.terminate()
    this.server.closeAllConnections()
    await new Promise<void>((resolve) => this.server.close(() => resolve()))
  }
}

let fake: FakeDbServer
beforeEach(async () => {
  fake = await new FakeDbServer().start()
})
afterEach(() => fake.stop())

const client = () => new DbClient(async () => fake.url)

describe('DbClient.tunnel', () => {
  it('返回时已经是 OPEN（否则调用方一上来发的字节会被静默丢掉）', async () => {
    const ws = await client().tunnel('smoke-pg')
    // 1 = OPEN。早返回的话这里会是 0（CONNECTING），`ws.send()` 于是什么也不做
    expect(ws.readyState).toBe(WebSocket.OPEN)
    ws.close()
  })

  it('返回后立刻发字节，服务端真的收到了（不是只开了条空连接）', async () => {
    const ws = await client().tunnel('smoke-pg')
    // 手握手那 120ms 里泵已经在搬字节了；这里模拟「本地客户端连上就先发一条」
    const echoed = new Promise<Buffer>((resolve) => ws.once('message', (data: Buffer) => resolve(data)))
    ws.send(Buffer.from('kura-probe', 'utf8'))
    expect((await echoed).toString('utf8')).toBe('kura-probe')
    expect(fake.received).toHaveLength(1)
    ws.close()
  })

  it('服务端拒绝握手时抛 DbApiError（带上状态码，好让界面说清原因）', async () => {
    const rejecting = http.createServer()
    rejecting.on('upgrade', (_req, socket) => {
      socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n')
      socket.destroy()
    })
    await new Promise<void>((resolve) => rejecting.listen(0, '127.0.0.1', resolve))
    const url = `http://127.0.0.1:${(rejecting.address() as AddressInfo).port}`
    try {
      const error = await new DbClient(async () => url)
        .tunnel('nope')
        .then(() => undefined)
        .catch((caught: unknown) => caught)
      expect(error).toBeInstanceOf(DbApiError)
      expect((error as DbApiError).status).toBe(404)
    } finally {
      rejecting.closeAllConnections()
      await new Promise<void>((resolve) => rejecting.close(() => resolve()))
    }
  })
})
