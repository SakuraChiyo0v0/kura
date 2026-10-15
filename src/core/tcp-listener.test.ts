import net from 'node:net'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { TcpListener } from './tcp-listener.js'

const toClose: TcpListener[] = []
afterEach(async () => {
  while (toClose.length) await toClose.pop()!.close()
})

async function freePort(): Promise<number> {
  const server = net.createServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return port
}

function listener(port: number, enabled: boolean, onConnection = () => {}) {
  const l = new TcpListener({ port, enabled, handlers: { connection: onConnection } })
  toClose.push(l)
  return l
}

/** 拨一次本机端口，拿回伺服端给的 socket。 */
function dial(port: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ port, host: '127.0.0.1' })
    socket.once('connect', () => resolve(socket))
    socket.once('error', reject)
  })
}

describe('TcpListener', () => {
  it('安全红线：非回环地址直接抛错', () => {
    expect(() => new TcpListener({ host: '0.0.0.0', port: 1, enabled: false, handlers: { connection: () => {} } })).toThrow(/回环/)
    expect(() => new TcpListener({ host: '192.168.1.5', port: 1, enabled: false, handlers: { connection: () => {} } })).toThrow(/回环/)
  })

  it('端口 0 让系统分配，并把真实端口记下来', async () => {
    const l = listener(0, true)
    await l.applyIntent()
    expect(l.status().running).toBe(true)
    expect(l.status().port).toBeGreaterThan(0)
  })

  it('来连接时回调，状态里的连接数跟着涨', async () => {
    let seen = 0
    const l = listener(0, true, () => {
      seen += 1
    })
    await l.applyIntent()
    const socket = await dial(l.status().port)
    await new Promise((r) => setTimeout(r, 30))
    expect(seen).toBe(1)
    expect(l.status().connections).toBe(1)
    socket.destroy()
  })

  it('端口被占用：开着但 running=false，lastError 说原因（与 ServiceListener 同语义）', async () => {
    const port = await freePort()
    const squatter = net.createServer()
    await new Promise<void>((resolve) => squatter.listen(port, '127.0.0.1', resolve))
    const l = listener(port, true)
    await expect(l.applyIntent()).rejects.toThrow(/绑定失败/)
    const status = l.status()
    expect(status.enabled).toBe(true)
    expect(status.running).toBe(false)
    expect(status.lastError).not.toBe('')
    await new Promise<void>((resolve) => squatter.close(() => resolve()))
  })

  it('改端口失败要退回原端口（不是把用户丢在半路）', async () => {
    const l = listener(0, true)
    await l.applyIntent()
    const original = l.status().port

    const taken = await freePort()
    const squatter = net.createServer()
    await new Promise<void>((resolve) => squatter.listen(taken, '127.0.0.1', resolve))
    await expect(l.setPort(taken)).rejects.toThrow(/已退回/)
    expect(l.status().port).toBe(original)
    expect(l.status().running).toBe(true)
    await new Promise<void>((resolve) => squatter.close(() => resolve()))
  })

  it('关掉监听后端口真的释放', async () => {
    const l = listener(0, true)
    await l.applyIntent()
    const port = l.status().port
    await l.setEnabled(false)
    expect(l.status().running).toBe(false)
    const again = await freePort()
    expect(again).toBeGreaterThan(0)
    // 端口应当又能绑上
    const probe = net.createServer()
    await new Promise<void>((resolve, reject) => {
      probe.once('error', reject)
      probe.listen(port, '127.0.0.1', () => probe.close(() => resolve()))
    })
  })
})
