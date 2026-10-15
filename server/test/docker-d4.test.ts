import http from 'node:http'
import type { AddressInfo, Socket } from 'node:net'
import { WebSocket } from 'ws'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DockerEngine } from '../src/docker/engine.js'
import { createDockerHandler, shellCommand } from '../src/docker/handler.js'
import { DockerService } from '../src/docker/service.js'
import type { AuditEntry } from '../src/shell/audit.js'
import { FakeDocker } from './fake-docker.js'

/** D4：卷、网络、更新检查、进容器 shell。 */
let docker: FakeDocker
let server: http.Server
let base = ''
let audit: AuditEntry[] = []

beforeEach(async () => {
  docker = await new FakeDocker().start()
  audit = []
  const engine = new DockerEngine({ socketPath: docker.socketPath })
  const handler = createDockerHandler({
    engine,
    service: new DockerService({ engine, projectRoot: '/volume1/docker' }),
    audit: (e) => audit.push({ ...e, at: '', id: '', user: 'kura' }),
    activity: () => audit,
  })
  server = http.createServer((req, res) => void handler.handle(req, res))
  server.on('upgrade', (req, socket, head) => handler.upgrade(req, socket as Socket, head))
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})
afterEach(async () => {
  server.closeAllConnections()
  await new Promise<void>((r) => server.close(() => r()))
  await docker.stop()
})

describe('卷与网络', () => {
  it('卷：所属项目、谁在用；占用要显式要才查', async () => {
    docker.volumes = [
      { Name: 'kura-server_shell-token', Driver: 'local', Mountpoint: '/volume1/@docker/volumes/x', Labels: { 'com.docker.compose.project': 'kura-server' } },
      { Name: 'orphan', Driver: 'local', Mountpoint: '/volume1/@docker/volumes/y', Labels: null },
    ]
    const c = docker.addContainer('kura-shell', { project: 'kura-server' })
    ;(c as { Mounts?: unknown }).Mounts = [{ Type: 'volume', Name: 'kura-server_shell-token' }, { Type: 'bind', Source: '/x' }]
    const plain = (await (await fetch(`${base}/api/volumes`)).json()) as Array<{ name: string; project: string; usedBy: string[]; size: number }>
    expect(plain).toEqual([
      expect.objectContaining({ name: 'kura-server_shell-token', project: 'kura-server', usedBy: ['kura-shell'], size: -1 }),
      expect.objectContaining({ name: 'orphan', project: '', usedBy: [], size: -1 }),
    ])
    expect(docker.calls.some((x) => x.includes('/system/df'))).toBe(false)
    const sized = (await (await fetch(`${base}/api/volumes?size=1`)).json()) as Array<{ size: number }>
    expect(sized.map((v) => v.size)).toEqual([4096, 4096])
  })

  it('网络：子网、成员、Docker 自带的排后面', async () => {
    docker.networks = [
      { Id: 'n1', Name: 'bridge', Driver: 'bridge', Scope: 'local', IPAM: { Config: [{ Subnet: '172.17.0.0/16', Gateway: '172.17.0.1' }] }, Containers: {} },
      { Id: 'n2', Name: 'sso-net', Driver: 'bridge', Scope: 'local', Containers: { a: { Name: 'openlist', IPv4Address: '172.20.0.3/16' } }, IPAM: { Config: [{ Subnet: '172.20.0.0/16' }] } },
    ]
    const nets = (await (await fetch(`${base}/api/networks`)).json()) as Array<{ name: string; builtin: boolean; containers: unknown[]; subnet: string }>
    expect(nets.map((n) => [n.name, n.builtin])).toEqual([
      ['sso-net', false],
      ['bridge', true],
    ])
    expect(nets[0]).toMatchObject({ subnet: '172.20.0.0/16', containers: [{ name: 'openlist', ip: '172.20.0.3' }] })
  })
})

describe('更新检查', () => {
  const check = (images: string[]) =>
    fetch(`${base}/api/updates`, { method: 'POST', headers: { 'x-kura-docker': '1', 'content-type': 'application/json' }, body: JSON.stringify({ images }) }).then(
      (r) => r.json() as Promise<Array<{ image: string; status: string; reason: string }>>,
    )

  it('本地 digest 与仓库对比：有新版 / 已最新 / 查不了（各自说清原因）', async () => {
    docker.images = [
      { Id: 'sha256:a', RepoTags: ['openlist:latest'], Size: 1, Created: 1 },
      { Id: 'sha256:b', RepoTags: ['redis:7'], Size: 1, Created: 1 },
      { Id: 'sha256:c', RepoTags: ['local-build:dev'], Size: 1, Created: 1 },
      { Id: 'sha256:d', RepoTags: ['private/app:1'], Size: 1, Created: 1 },
    ]
    docker.repoDigests.set('openlist:latest', ['openlist@sha256:old'])
    docker.remoteDigests.set('openlist:latest', 'sha256:new')
    docker.repoDigests.set('redis:7', ['redis@sha256:same'])
    docker.remoteDigests.set('redis:7', 'sha256:same')
    docker.repoDigests.set('private/app:1', ['private/app@sha256:x'])
    const result = await check(['openlist:latest', 'redis:7', 'local-build:dev', 'private/app:1', 'openlist:latest'])
    expect(result.map((r) => [r.image, r.status])).toEqual([
      ['openlist:latest', 'update'],
      ['redis:7', 'current'],
      ['local-build:dev', 'unknown'],
      ['private/app:1', 'unknown'],
    ])
    expect(result[2]!.reason).toMatch(/本地构建/)
    expect(result[3]!.reason).toMatch(/仓库.*authentication/)
  })

  it('要写头（它会让 NAS 去连外网）；名字照样校验', async () => {
    const r = await fetch(`${base}/api/updates`, { method: 'POST', body: '{"images":["a"]}' })
    expect(r.status).toBe(403)
    const bad = await fetch(`${base}/api/updates`, { method: 'POST', headers: { 'x-kura-docker': '1' }, body: '{"images":["../x"]}' })
    expect(bad.status).toBe(400)
  })
})

describe('进容器 shell', () => {
  const open = (path: string) =>
    new Promise<{ ws: WebSocket; first: string }>((resolve, reject) => {
      const ws = new WebSocket(base.replace('http', 'ws') + path, { headers: { 'x-kura-docker': '1' } })
      ws.once('message', (d) => resolve({ ws, first: d.toString() }))
      ws.on('unexpected-response', (_q, res) => reject(new Error(`HTTP ${res.statusCode}`)))
      ws.on('error', reject)
    })

  it('交互：输入回显、resize 转成 exec resize、开关进审计', async () => {
    docker.addContainer('openlist', { project: 'openlist' })
    const { ws, first } = await open('/api/containers/openlist/shell?cols=120&rows=40')
    expect(first).toBe('openlist:/# ')
    const echoed = new Promise<string>((r) => ws.once('message', (d) => r(d.toString())))
    ws.send('ls\n')
    expect(await echoed).toBe('ls\n')
    ws.send(JSON.stringify({ type: 'resize', cols: 100, rows: 30 }))
    await new Promise((r) => setTimeout(r, 100))
    const exec = [...docker.execs.values()][0]!
    expect(exec.resized).toEqual(['120x40', '100x30'])
    // 没指定 shell：用写死的挑选脚本，不是外部输入
    expect(exec.cmd).toEqual(shellCommand(''))
    const closed = new Promise((r) => ws.once('close', r))
    ws.close()
    await closed
    await new Promise((r) => setTimeout(r, 50))
    expect(audit.map((a) => a.action)).toEqual(['docker-exec-open', 'docker-exec-close'])
  })

  it('shell 只能从白名单里选；Kura 自己的容器、停着的容器进不去', async () => {
    docker.addContainer('app', { project: 'app' })
    docker.addContainer('kura-shell', { project: 'kura-server' })
    docker.addContainer('stopped', { project: 'x', state: 'exited' })
    expect((await open('/api/containers/app/shell?shell=/usr/bin/python3')).first).toMatch(/只能用这些 shell/)
    expect((await open('/api/containers/kura-shell/shell')).first).toMatch(/Kura 自己/)
    expect((await open('/api/containers/stopped/shell')).first).toMatch(/没在运行/)
    expect(docker.execs.size).toBe(0)
  })

  it('不带写头连不上', async () => {
    docker.addContainer('app', { project: 'app' })
    const status = await new Promise<number | undefined>((resolve) => {
      const ws = new WebSocket(base.replace('http', 'ws') + '/api/containers/app/shell')
      ws.on('unexpected-response', (_q, res) => resolve(res.statusCode))
      ws.on('open', () => resolve(101))
    })
    expect(status).toBe(403)
  })
})
