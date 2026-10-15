import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { FakeDocker } from './fake-docker.js'

/**
 * 打包后的 kura-server（dist/server/main.mjs）真起一个进程，挂假 dockerd：
 * 证明 main.ts 的接线是对的 —— 清单里出现 docker、`X-Nas-Service: docker` 分流到处理器、写头生效。
 * 单测覆盖的是处理器本身；这里只管「装没装上」。没构建过就跳过（npm run server:build）。
 */
const bundle = join(process.cwd(), 'dist', 'server', 'main.mjs')

async function freePort(): Promise<number> {
  const s = net.createServer()
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()))
  const port = (s.address() as net.AddressInfo).port
  await new Promise<void>((r) => s.close(() => r()))
  return port
}

describe.skipIf(!existsSync(bundle))('kura-server 进程：docker 内置服务的接线', () => {
  let docker: FakeDocker
  let child: ChildProcess
  let state: string
  let base = ''

  beforeAll(async () => {
    docker = await new FakeDocker().start()
    docker.addContainer('openlist', { project: 'openlist' })
    state = mkdtempSync(join(tmpdir(), 'kura-state-'))
    const port = await freePort()
    base = `http://127.0.0.1:${port}`
    child = spawn(process.execPath, [bundle, 'serve'], {
      env: { ...process.env, KURA_STATE: state, KURA_PORT: String(port), KURA_DOCKER_SOCKET: docker.socketPath, KURA_PROJECT_ROOT: '/volume1/docker' },
      stdio: 'ignore',
    })
    for (let i = 0; i < 100; i++) {
      try {
        if ((await fetch(`${base}/api/health`)).ok) return
      } catch {
        // 还没起来
      }
      await new Promise((r) => setTimeout(r, 100))
    }
    throw new Error('kura-server 没起来')
  })

  afterAll(async () => {
    child?.kill()
    await docker?.stop()
    rmSync(state, { recursive: true, force: true })
  })

  it('清单里有 docker；经 X-Nas-Service 拿到 overview；写操作缺头被拒', async () => {
    const services = (await (await fetch(`${base}/__services`)).json()) as { services: Array<{ name: string }> }
    expect(services.services.map((s) => s.name)).toContain('docker')
    const overview = (await (await fetch(`${base}/api/overview`, { headers: { 'x-nas-service': 'docker' } })).json()) as { containers: Array<{ name: string }> }
    expect(overview.containers.map((c) => c.name)).toEqual(['openlist'])
    const denied = await fetch(`${base}/api/containers/openlist/stop`, { method: 'POST', headers: { 'x-nas-service': 'docker' } })
    expect(denied.status).toBe(403)
    const ok = await fetch(`${base}/api/containers/openlist/stop`, { method: 'POST', headers: { 'x-nas-service': 'docker', 'x-kura-docker': '1' } })
    expect(ok.status).toBe(200)
    expect(docker.containers[0]!.State).toBe('exited')
  })
})
