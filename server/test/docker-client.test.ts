import http from 'node:http'
import type { AddressInfo, Socket } from 'node:net'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DockerApiError, DockerClient } from '../../src/core/docker-client.js'
import type { ComposeAction, ComposeTarget } from '../src/docker/compose.js'
import { DockerEngine } from '../src/docker/engine.js'
import { createDockerHandler } from '../src/docker/handler.js'
import { DockerService } from '../src/docker/service.js'
import type { AuditEntry } from '../src/shell/audit.js'
import { FakeDocker, frame } from './fake-docker.js'

/**
 * 客户端的 DockerClient 连**真的** kura-server docker 处理器（后面是假 dockerd）：
 * 证明两边对接口形状、写头、流的结束帧理解一致。
 */
let docker: FakeDocker
let server: http.Server
let client: DockerClient
const audit: AuditEntry[] = []

beforeEach(async () => {
  docker = await new FakeDocker().start()
  audit.length = 0
  const engine = new DockerEngine({ socketPath: docker.socketPath })
  const handler = createDockerHandler({
    engine,
    service: new DockerService({ engine, projectRoot: '/volume1/docker' }),
    audit: (e) => audit.push({ ...e, at: new Date().toISOString(), id: String(audit.length), user: 'kura' }),
    activity: (n) => audit.slice(-n),
    compose: (_t: ComposeTarget, action: ComposeAction) => {
      const ls: Array<(t: string) => void> = []
      return {
        onOutput: (l) => ls.push(l),
        // 输出里故意带一行 JSON：结束帧的识别不能把它吃掉
        done: new Promise((r) => setTimeout(() => (ls.forEach((l) => l(`{"level":"info"}\n${action} ok\n`)), r(0)), 10)),
        kill: () => {},
      }
    },
  })
  server = http.createServer((req, res) => void handler.handle(req, res))
  server.on('upgrade', (req, socket, head) => handler.upgrade(req, socket as Socket, head))
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  client = new DockerClient(async () => `http://127.0.0.1:${(server.address() as AddressInfo).port}`)
})

afterEach(async () => {
  server.closeAllConnections()
  await new Promise<void>((r) => server.close(() => r()))
  await docker.stop()
})

describe('DockerClient ↔ kura-server', () => {
  it('读：overview / 详情 / 镜像 / 日志文本', async () => {
    docker.addContainer('openlist', { project: 'openlist' })
    docker.logs.set('openlist', frame(1, 'hello\n'))
    expect((await client.overview()).containers.map((c) => c.name)).toEqual(['openlist'])
    expect((await client.container('openlist')).restartPolicy).toBe('unless-stopped')
    expect(await client.images()).toEqual([])
    expect(await client.logsText('openlist')).toBe('hello\n')
  })

  it('写：自动带上写头；服务端的错误原样变成异常', async () => {
    docker.addContainer('app', { project: 'app' })
    await client.containerAction('app', 'stop')
    expect(docker.containers[0]!.State).toBe('exited')
    docker.addContainer('kura-server', { project: 'kura-server' })
    await expect(client.containerAction('kura-server', 'stop')).rejects.toThrow(/Kura 自己/)
    await expect(client.containerAction('kura-server', 'stop')).rejects.toBeInstanceOf(DockerApiError)
  })

  it('流：输出里的 JSON 行照常给出，只有精确的结束帧被当成退出码', async () => {
    docker.addContainer('app', { project: 'app', dir: '/volume1/docker/app' })
    const stream = await client.project('app', 'restart')
    let text = ''
    stream.onData((t) => (text += t))
    expect(await stream.done).toBe(0)
    expect(text).toBe('{"level":"info"}\nrestart ok\n')
  })

  it('清理镜像：走流式，回收字节数在输出里，退出码 0', async () => {
    const stream = await client.pruneImagesStream(false)
    let text = ''
    stream.onData((t) => (text += t))
    expect(await stream.done).toBe(0)
    expect(text).toContain('1.2 KiB')
    expect(docker.calls.some((c) => c.startsWith('POST /images/prune'))).toBe(true)
  })

  it('旧镜像（没有 docker 服务）：说清是镜像太旧，不是一句 JSON 解析失败', async () => {
    const old = http.createServer((_req, res) => {
      res.writeHead(404, { 'content-type': 'text/plain' })
      res.end('Not found')
    })
    await new Promise<void>((r) => old.listen(0, '127.0.0.1', () => r()))
    const c = new DockerClient(async () => `http://127.0.0.1:${(old.address() as AddressInfo).port}`)
    await expect(c.overview()).rejects.toThrow(/镜像太旧/)
    await new Promise<void>((r) => old.close(() => r()))
  })
})
