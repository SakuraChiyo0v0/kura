import http from 'node:http'
import net from 'node:net'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { ServiceListener, assertLoopback } from './listener.js'

const handlers = {
  request: (_req: http.IncomingMessage, res: http.ServerResponse) => res.end('ok'),
  upgrade: (_req: http.IncomingMessage, socket: net.Socket) => socket.destroy(),
}

const toClose: ServiceListener[] = []
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

async function portIsFree(port: number): Promise<boolean> {
  const server = net.createServer()
  return new Promise((resolve) => {
    server.once('error', () => resolve(false))
    server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)))
  })
}

function get(port: number): Promise<string> {
  return new Promise((resolve, reject) => {
    http
      .get(`http://127.0.0.1:${port}/`, (res) => {
        let body = ''
        res.on('data', (c) => (body += c))
        res.on('end', () => resolve(body))
      })
      .on('error', reject)
  })
}

function listener(port: number, enabled: boolean) {
  const l = new ServiceListener({ port, enabled, handlers })
  toClose.push(l)
  return l
}

describe('ServiceListener', () => {
  it('开 → 真的能连上；关 → 端口真的释放', async () => {
    const port = await freePort()
    const l = listener(port, false)
    expect(l.status()).toMatchObject({ enabled: false, running: false })
    expect(await portIsFree(port)).toBe(true)

    await l.setEnabled(true)
    expect(l.status()).toMatchObject({ enabled: true, running: true, port })
    expect(await get(port)).toBe('ok')

    await l.setEnabled(false)
    expect(l.status()).toMatchObject({ enabled: false, running: false })
    expect(await portIsFree(port)).toBe(true)
  })

  it('改端口时新端口被占：报错并退回原端口；改到空端口则旧端口释放', async () => {
    const portA = await freePort()
    const blocker = net.createServer()
    await new Promise<void>((resolve) => blocker.listen(0, '127.0.0.1', resolve))
    const portB = (blocker.address() as AddressInfo).port

    const l = listener(portA, true)
    await l.setEnabled(true)
    await expect(l.setPort(portB)).rejects.toThrow(/已退回/)
    expect(l.status()).toMatchObject({ running: true, port: portA })
    expect(await get(portA)).toBe('ok')
    await new Promise<void>((resolve) => blocker.close(() => resolve()))

    const portC = await freePort()
    await l.setPort(portC)
    expect(l.status()).toMatchObject({ running: true, port: portC })
    expect(await portIsFree(portA)).toBe(true)
  })

  it('开关开着但端口被占：enabled=true / running=false，并记下原因', async () => {
    const blocker = net.createServer()
    await new Promise<void>((resolve) => blocker.listen(0, '127.0.0.1', resolve))
    const port = (blocker.address() as AddressInfo).port
    const l = listener(port, false)
    await expect(l.setEnabled(true)).rejects.toThrow(/绑定失败/)
    expect(l.status()).toMatchObject({ enabled: true, running: false })
    expect(l.status().lastError).toMatch(/EADDRINUSE/)

    // 界面上的处置就是「就地改端口」：改完应当直接在新端口起来，不用再拨一次开关
    const other = await freePort()
    await l.setPort(other)
    expect(l.status()).toMatchObject({ enabled: true, running: true, port: other, lastError: '' })
    expect(await get(other)).toBe('ok')
    await l.close()
    await new Promise<void>((resolve) => blocker.close(() => resolve()))
  })

  it('关着的服务不占端口；没运行时改端口只改记录', async () => {
    const port = await freePort()
    const l = listener(port, false)
    await l.setPort(port + 1)
    expect(l.status()).toMatchObject({ running: false, port: port + 1 })
    expect(await portIsFree(port)).toBe(true)
  })

  it('连点开关按顺序执行，最终状态与最后一次一致', async () => {
    const port = await freePort()
    const l = listener(port, false)
    await Promise.all([l.setEnabled(true), l.setEnabled(false), l.setEnabled(true)])
    expect(l.status()).toMatchObject({ enabled: true, running: true })
  })

  it('非回环地址直接拒绝（安全红线）', () => {
    expect(() => assertLoopback('0.0.0.0')).toThrow(/回环/)
    expect(() => assertLoopback('192.168.1.2')).toThrow(/回环/)
    expect(() => new ServiceListener({ host: '0.0.0.0', port: 1, enabled: false, handlers })).toThrow(/回环/)
    expect(() => assertLoopback('127.0.0.1')).not.toThrow()
    expect(() => assertLoopback('::1')).not.toThrow()
  })
})
