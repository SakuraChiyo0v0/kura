import http from 'node:http'
import https from 'node:https'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { httpsProxyConfigured, proxiedHttpsAgent } from './http.js'

/** 只记下 CONNECT 目标、然后拒绝隧道的假代理：够证明「请求走没走代理」。 */
async function fakeProxy(): Promise<{ url: string; connects: string[]; close: () => Promise<void> }> {
  const connects: string[] = []
  const server = http.createServer((_req, res) => res.end())
  server.on('connect', (req, socket) => {
    connects.push(String(req.url))
    socket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return { url: `http://127.0.0.1:${port}`, connects, close: () => new Promise((resolve) => server.close(() => resolve())) }
}

function get(url: string, agent: https.Agent): Promise<string> {
  return new Promise((resolve) => {
    const req = https.request(url, { agent, timeout: 2_000 }, (res) => {
      res.resume()
      resolve(`HTTP ${res.statusCode}`)
    })
    req.on('error', (error) => resolve(`ERR ${error.message}`))
    req.on('timeout', () => req.destroy(new Error('timeout')))
    req.end()
  })
}

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!()
})

describe('出网代理', () => {
  it('配了 HTTPS_PROXY：https 上游经 CONNECT 隧道', async () => {
    const proxy = await fakeProxy()
    cleanups.push(proxy.close)
    const agent = proxiedHttpsAgent({}, { HTTPS_PROXY: proxy.url })
    const result = await get('https://relay.example.invalid/api', agent)
    expect(proxy.connects).toEqual(['relay.example.invalid:443'])
    expect(result).toMatch(/tunnel/)
  })

  it('NO_PROXY 命中的主机直连，不经代理', async () => {
    const proxy = await fakeProxy()
    cleanups.push(proxy.close)
    const agent = proxiedHttpsAgent({}, { HTTPS_PROXY: proxy.url, NO_PROXY: '127.0.0.1' })
    // 本机 1 号端口没人听：直连会被拒，关键是代理一次都没被问到
    await get('https://127.0.0.1:1/', agent)
    expect(proxy.connects).toEqual([])
  })

  it('没配代理时不走代理', async () => {
    const proxy = await fakeProxy()
    cleanups.push(proxy.close)
    const agent = proxiedHttpsAgent({}, {})
    await get('https://127.0.0.1:1/', agent)
    expect(proxy.connects).toEqual([])
    expect(httpsProxyConfigured({})).toBeUndefined()
    expect(httpsProxyConfigured({ https_proxy: 'http://p:8080' })).toBe('http://p:8080')
  })
})
