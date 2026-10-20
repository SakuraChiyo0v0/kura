import http from 'node:http'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import type { AddressInfo, Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WebSocket } from 'ws'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { maskEnv, projectStatus } from '../../src/core/docker-types.js'
import { composeArgs, runCompose, scanProjectRoot, within, type ComposeAction, type ComposeRun, type ComposeTarget } from '../src/docker/compose.js'
import { DockerEngine, checkRef, createLogDemuxer } from '../src/docker/engine.js'
import { createDockerHandler, type AuditSink } from '../src/docker/handler.js'
import { resolveProjectRoots, toOriginalPath } from '../src/docker/mounts.js'
import { DockerService, toStats } from '../src/docker/service.js'
import type { AuditEntry } from '../src/shell/audit.js'
import { FakeDocker, frame } from './fake-docker.js'

/** 假文件身份：路径 → dev:ino。用来模拟「挂进来了 / 没挂进来」两种机器（见 mounts.ts）。 */
function fakeFs(entries: Record<string, string>): (path: string) => string | undefined {
  const normalize = (p: string): string => p.replace(/\/+/g, '/').replace(/\/$/, '') || '/'
  const map = new Map(Object.entries(entries).map(([k, v]) => [normalize(k), v]))
  return (path) => map.get(normalize(path))
}

let docker: FakeDocker
let server: http.Server
let base = ''
let root = ''
let audit: AuditEntry[] = []
let composeCalls: Array<{ target: ComposeTarget; action: ComposeAction }> = []
let composeExit = 0

function fakeCompose(target: ComposeTarget, action: ComposeAction): ComposeRun {
  composeCalls.push({ target, action })
  const listeners: Array<(t: string) => void> = []
  const done = new Promise<number>((resolve) =>
    setTimeout(() => {
      for (const l of listeners) l(` Container ${target.name}-app-1  Started\n`)
      resolve(composeExit)
    }, 20),
  )
  return { onOutput: (l) => listeners.push(l), done, kill: () => {} }
}

beforeEach(async () => {
  docker = await new FakeDocker().start()
  root = mkdtempSync(join(tmpdir(), 'kura-projects-'))
  audit = []
  composeCalls = []
  composeExit = 0
  const engine = new DockerEngine({ socketPath: docker.socketPath, timeoutMs: 5_000 })
  const sink: AuditSink = (e) => audit.push({ ...e, at: new Date().toISOString(), id: String(audit.length), user: 'kura' })
  // 单测里没有容器的挂载结构：`/host` 不存在 → mounts.ts 退回「存在就算可达」，
  // 也就是「原路径就是本地路径」的普通文件系统。这正是临时目录这个形状，行为等同于真机上挂对了。
  const handler = createDockerHandler({
    engine,
    service: new DockerService({ engine, projectRoot: root.replace(/\\/g, '/') }),
    audit: sink,
    activity: (n) => audit.slice(-n),
    compose: fakeCompose,
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
  rmSync(root, { recursive: true, force: true })
})

async function call(method: string, path: string, write = method !== 'GET'): Promise<{ status: number; body: any }> {
  const res = await fetch(base + path, { method, headers: write ? { 'x-kura-docker': '1' } : {} })
  const text = await res.text()
  let body: unknown = text
  try {
    body = JSON.parse(text)
  } catch {
    // 纯文本
  }
  return { status: res.status, body }
}

/** 连一个流式接口，收集所有文本帧，直到 exit 帧。 */
function stream(path: string, write = true): Promise<{ text: string; code: number | undefined; status?: number }> {
  return new Promise((resolve) => {
    const ws = new WebSocket(base.replace('http', 'ws') + path, { headers: write ? { 'x-kura-docker': '1' } : {} })
    let text = ''
    let code: number | undefined
    ws.on('message', (data) => {
      const s = data.toString()
      try {
        const msg = JSON.parse(s) as { type?: string; code?: number }
        if (msg.type === 'exit') {
          code = msg.code
          return
        }
      } catch {
        // 普通输出
      }
      text += s
    })
    ws.on('close', () => resolve({ text, code }))
    ws.on('unexpected-response', (_req, res) => resolve({ text: '', code: undefined, status: res.statusCode }))
    ws.on('error', () => resolve({ text, code }))
  })
}

describe('engine：白名单与解帧', () => {
  it('名字只认 Docker 的字符集，挡路径穿越与查询串', () => {
    expect(checkRef('openlist')).toBe('openlist')
    expect(checkRef('ghcr.io/sakura/kura-server:latest')).toBe('ghcr.io/sakura/kura-server:latest')
    for (const bad of ['../etc', 'a?all=1', 'a#b', 'a b', '', '/x', 'a/../b']) expect(() => checkRef(bad), bad).toThrow()
  })

  it('解 Docker 日志帧：跨块的半帧留到下一次', () => {
    const demux = createLogDemuxer()
    const whole = Buffer.concat([frame(1, 'hello\n'), frame(2, 'boom\n')])
    expect(demux(whole.subarray(0, 5)) + demux(whole.subarray(5, 17)) + demux(whole.subarray(17))).toBe('hello\nboom\n')
  })

  it('开了 TTY 的容器没有帧头：原样输出', () => {
    expect(createLogDemuxer()(Buffer.from('plain tty output\n'))).toBe('plain tty output\n')
  })

  it('stats 按 docker stats 的算法：CPU 用采样差，内存去掉页缓存', () => {
    expect(
      toStats({
        cpu_stats: { cpu_usage: { total_usage: 2000 }, system_cpu_usage: 20000, online_cpus: 4 },
        precpu_stats: { cpu_usage: { total_usage: 1000 }, system_cpu_usage: 10000 },
        memory_stats: { usage: 300, limit: 1000, stats: { inactive_file: 100 } },
      }),
    ).toEqual({ cpuPercent: 40, memoryUsage: 200, memoryLimit: 1000 })
  })
})

describe('compose：发现与参数', () => {
  it('扫项目目录：有 compose 文件的子目录才算，项目名按 compose 的规则', () => {
    mkdirSync(join(root, 'openlist'))
    writeFileSync(join(root, 'openlist', 'docker-compose.yaml'), 'services: {}\n')
    mkdirSync(join(root, 'Empty-Dir'))
    mkdirSync(join(root, 'Astra.Hub'))
    writeFileSync(join(root, 'Astra.Hub', 'compose.yaml'), 'services: {}\n')
    const found = scanProjectRoot(root)
    expect(found.map((f) => f.name)).toEqual(['astrahub', 'openlist'])
    expect(found[1]!.configFiles[0]).toMatch(/openlist\/docker-compose\.yaml$/)
  })

  it('runCompose：不经 shell、参数原样到进程、在项目目录里跑', async () => {
    const script = join(root, 'argv.cjs')
    writeFileSync(script, 'console.log(JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), progress: process.env.COMPOSE_PROGRESS }))\n')
    // node 冒充 docker：prefix 把脚本放在 compose 前面
    const run = runCompose({ name: 'x-y', dir: root, configFiles: ['a b.yaml', '$(whoami).yml'] }, 'up', process.execPath, [script])
    let out = ''
    run.onOutput((t) => (out += t))
    expect(await run.done).toBe(0)
    const seen = JSON.parse(out) as { argv: string[]; cwd: string; progress: string }
    expect(seen.argv).toEqual(['compose', '-p', 'x-y', '-f', 'a b.yaml', '-f', '$(whoami).yml', 'up', '-d', '--remove-orphans'])
    expect(seen.cwd.toLowerCase()).toBe(root.toLowerCase())
    expect(seen.progress).toBe('plain')
    expect(() => runCompose({ name: 'Bad Name', dir: root, configFiles: [] }, 'up')).toThrow(/项目名/)
  })

  it('runCompose：项目目录没挂进来时 down 只按项目名跑，别的动作直接说清原因', async () => {
    const script = join(root, 'argv.cjs')
    writeFileSync(script, 'console.log(JSON.stringify({ argv: process.argv.slice(2) }))\n')
    const missing = join(root, 'not-mounted', 'envtest')
    const run = runCompose({ name: 'envtest', dir: missing, configFiles: [`${missing}/docker-compose.yaml`] }, 'down', process.execPath, [script])
    let out = ''
    run.onOutput((t) => (out += t))
    expect(await run.done).toBe(0)
    expect((JSON.parse(out) as { argv: string[] }).argv).toEqual(['compose', '-p', 'envtest', 'down'])
    expect(() => runCompose({ name: 'envtest', dir: missing, configFiles: [] }, 'up', process.execPath, [script])).toThrow(/没有挂进/)
  })

  it('down 不带 -v：卷默认保留', () => {
    expect(composeArgs('down')).toEqual(['down'])
    expect(composeArgs('up')).toEqual(['up', '-d', '--remove-orphans'])
  })

  it('within：按路径段判断，不按字符串前缀', () => {
    expect(within('/volume1/docker/a', '/volume1/docker')).toBe(true)
    expect(within('/volume1/docker-other/a', '/volume1/docker')).toBe(false)
    expect(within('/volume1/docker/../etc', '/volume1/docker')).toBe(false)
  })

  /**
   * 「能不能部署」现在由**目录真实可达性**决定（mounts.ts 比 inode），不再是名字匹配上了就算。
   * 这里喂一对假身份模拟两种机器，比真去挂文件系统可靠，也正是真机上的那两种形状。
   */
  it('目录按原路径挂进来了：项目目录下的是 managed，绿联商店的仍是 external', () => {
    const key = fakeFs({
      '/host': '1:1',
      '/volume1/docker': '64768:1',
      '/host/volume1/docker': '64768:1',
    })
    const svc = new DockerService({ engine: new DockerEngine({ socketPath: docker.socketPath }), projectRoot: '/volume1/docker', key })
    expect(svc.kindOf('openlist', '/volume1/docker/openlist')).toBe('managed')
    expect(svc.kindOf('kura-server', '/volume1/docker/kura-server')).toBe('self')
    // /volume1/@appstore 没挂进来（真机就是这样）：即使挂载方式改了也不该突然放行
    expect(svc.kindOf('music-tag-web', '/volume1/@appstore/com.ugreen.docker.musictagweb')).toBe('external')
  })

  it('目录没按原路径挂进来：路径长得对也不算 managed，并且给出补救建议', async () => {
    // 容器里那个 /volume1/docker 是 overlay 层自己造的（ino 99:7），宿主的在 /host 下
    const key = fakeFs({
      '/host': '1:1',
      '/volume1/docker': '99:7',
      '/host/volume1/docker': '64768:1',
    })
    const svc = new DockerService({ engine: new DockerEngine({ socketPath: docker.socketPath }), projectRoot: '/volume1/docker', key })
    // 以前这里返回 managed：界面给「部署」按钮，点了才在 runCompose 里抛错
    expect(svc.kindOf('openlist', '/volume1/docker/openlist')).toBe('external')
    expect(svc.projectRootHint()).toContain('/volume1/docker:/volume1/docker')
    // 扫的是 /host 下那份 —— 项目照样看得见
    expect(svc.roots).toMatchObject({ scanRoot: '/host/volume1/docker', reachable: false })
  })

  it('没挂对时扫 /host 下的项目：报出去的 dir 仍是宿主原路径，kind 是 external', async () => {
    // 关键因果：scanRoot 是 /host 下那份 → 绝不能让 compose 拿着 /host/... 去跑
    // （dockerd 会在宿主上建一个空目录挂进去，应用看着像数据全丢）。
    // 真机上 /volume1/docker 现在挂对了，但 /volume1/@appstore 正是这个形状。
    const key = fakeFs({
      '/host': '1:1',
      '/host/volume1/docker': '64768:1',
      '/host/volume1/docker/openlist': '64768:2',
      '/host/volume1/docker/openlist/docker-compose.yaml': '3:3',
    })
    // 扫描用真的目录树（scan 只看文件系统），身份判定用假的图
    const dir = join(root, 'openlist')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'docker-compose.yaml'), 'services: {}\n')
    const roots = resolveProjectRoots('/volume1/docker', { key })
    expect(roots.reachable).toBe(false)
    // 换回原路径这件事单独验：扫到 /host 下的路径，报出去要是修过的形状
    expect(toOriginalPath(`${roots.scanRoot}/openlist`, roots)).toBe('/volume1/docker/openlist')
    expect(toOriginalPath(`${roots.scanRoot}/openlist/docker-compose.yaml`, roots)).toBe('/volume1/docker/openlist/docker-compose.yaml')
  })

  it('环境变量里像密码的值遮住，其余照给', () => {
    expect(maskEnv(['TZ=Asia/Shanghai', 'DB_PASSWORD=hunter2', 'API_TOKEN=x', 'EMPTY'])).toEqual([
      { name: 'TZ', value: 'Asia/Shanghai', masked: false },
      { name: 'DB_PASSWORD', value: '', masked: true },
      { name: 'API_TOKEN', value: '', masked: true },
      { name: 'EMPTY', value: '', masked: false },
    ])
    expect([projectStatus(2, 2), projectStatus(1, 2), projectStatus(0, 2), projectStatus(0, 0)]).toEqual(['running', 'partial', 'stopped', 'stopped'])
  })
})

describe('docker 内置服务：只读', () => {
  it('overview：容器按项目归组，项目目录里没起过的也列出来，Kura 自己标成 self', async () => {
    const r = root.replace(/\\/g, '/')
    docker.addContainer('openlist', { project: 'openlist', dir: `${r}/openlist`, ports: [{ PrivatePort: 5244, PublicPort: 5244, Type: 'tcp' }, { PrivatePort: 5244, PublicPort: 5244, Type: 'tcp', IP: '::' }] })
    docker.addContainer('ap-web', { project: 'account-panel', service: 'web', dir: `${r}/account-panel` })
    docker.addContainer('ap-proxy', { project: 'account-panel', service: 'proxy', dir: `${r}/account-panel`, state: 'exited' })
    docker.addContainer('kura-server', { project: 'kura-server', dir: `${r}/kura-server` })
    docker.addContainer('music', { project: 'music-tag-web', dir: '/volume1/@appstore/com.ugreen.docker.musictagweb' })
    docker.addContainer('t-1', { project: 'envtest', dir: '/tmp/envtest', state: 'exited' })
    docker.addContainer('lonely')
    mkdirSync(join(root, 'navidrome'))
    writeFileSync(join(root, 'navidrome', 'docker-compose.yaml'), 'services: {}\n')

    const { status, body } = await call('GET', '/api/overview')
    expect(status).toBe(200)
    const byName = Object.fromEntries(body.projects.map((p: any) => [p.name, p]))
    expect(byName['account-panel']).toMatchObject({ status: 'partial', kind: 'managed', containers: 2, running: 1, services: ['proxy', 'web'] })
    expect(byName['openlist']).toMatchObject({ status: 'running', kind: 'managed' })
    expect(byName['kura-server'].kind).toBe('self')
    // 绿联商店目录现在按**真实可达性**判：没挂进来就是 external（真机现状，compose 里没挂它）
    expect(byName['music-tag-web'].kind).toBe('external')
    expect(byName['envtest'].kind).toBe('external')
    expect(byName['navidrome']).toMatchObject({ status: 'stopped', containers: 0, kind: 'managed' })
    // 单独起的容器不算项目，但在容器列表里
    expect(body.containers.find((c: any) => c.name === 'lonely').project).toBe('')
    const ol = body.containers.find((c: any) => c.name === 'openlist')
    expect(ol.ports).toEqual([{ private: 5244, public: 5244, type: 'tcp' }]) // IPv4/IPv6 两条并成一条
    expect(ol.health).toBe('healthy')
    expect(body.containers.find((c: any) => c.name === 'kura-server').protected).toBe(true)
  })

  it('详情里密码类环境变量的值不出 NAS', async () => {
    docker.addContainer('pg', { project: 'postgres', env: ['POSTGRES_PASSWORD=secret', 'PGDATA=/data'] })
    const { body } = await call('GET', '/api/containers/pg')
    expect(body.env).toContainEqual({ name: 'POSTGRES_PASSWORD', value: '', masked: true })
    expect(body.env).toContainEqual({ name: 'PGDATA', value: '/data', masked: false })
    expect(JSON.stringify(body)).not.toContain('secret')
    expect(body).toMatchObject({ restartPolicy: 'unless-stopped', networks: ['sso-net'], command: '/bin/app serve' })
  })

  it('镜像：被用着的计数、悬空标记', async () => {
    docker.addContainer('openlist')
    docker.images = [
      { Id: 'sha256:openlist', RepoTags: ['openlist:latest'], Size: 100, Created: 1 },
      { Id: 'sha256:old', RepoTags: ['<none>:<none>'], Size: 50, Created: 1 },
    ]
    const { body } = await call('GET', '/api/images')
    expect(body).toEqual([
      expect.objectContaining({ id: 'sha256:openlist', usedBy: 1, dangling: false }),
      expect.objectContaining({ id: 'sha256:old', usedBy: 0, dangling: true, tags: [] }),
    ])
  })

  it('下载日志：解开帧、纯文本', async () => {
    docker.addContainer('app')
    docker.logs.set('app', Buffer.concat([frame(1, 'line one\n'), frame(2, 'line two\n')]))
    const { body } = await call('GET', '/api/containers/app/logs')
    expect(body).toBe('line one\nline two\n')
  })

  it('实时日志走 WebSocket，不要求写头', async () => {
    docker.addContainer('app')
    docker.logs.set('app', frame(1, 'streaming\n'))
    const ws = new WebSocket(base.replace('http', 'ws') + '/api/containers/app/logs?tail=10')
    const first = await new Promise<string>((resolve) => ws.on('message', (d) => resolve(d.toString())))
    ws.close()
    expect(first).toBe('streaming\n')
  })

  it('不存在的容器回 404，不是 500', async () => {
    expect((await call('GET', '/api/containers/nope')).status).toBe(404)
  })
})

describe('docker 内置服务：写', () => {
  it('写操作必须带 x-kura-docker 头（挡浏览器里的跨站表单）', async () => {
    docker.addContainer('app', { project: 'app' })
    expect((await call('POST', '/api/containers/app/stop', false)).status).toBe(403)
    expect(docker.calls.some((c) => c.includes('/stop'))).toBe(false)
  })

  it('启停重启：真的调了、进了审计', async () => {
    docker.addContainer('app', { project: 'app' })
    expect((await call('POST', '/api/containers/app/stop')).status).toBe(200)
    expect(docker.containers[0]!.State).toBe('exited')
    expect((await call('POST', '/api/containers/app/start')).status).toBe(200)
    expect(audit.map((a) => [a.action, a.detail, a.exitCode])).toEqual([
      ['docker-stop', 'app', 0],
      ['docker-start', 'app', 0],
    ])
  })

  it('Kura 自己的容器：所有写操作都拒绝，一个请求都不发给 dockerd', async () => {
    docker.addContainer('kura-server', { project: 'kura-server' })
    for (const [m, p] of [['POST', '/api/containers/kura-server/stop'], ['POST', '/api/containers/kura-server/restart'], ['DELETE', '/api/containers/kura-server?force=1']] as const) {
      const r = await call(m, p)
      expect(r.status, p).toBe(403)
    }
    expect(docker.calls.filter((c) => !c.startsWith('GET'))).toEqual([])
  })

  it('删除运行中的容器要显式强制', async () => {
    docker.addContainer('app', { project: 'app' })
    const r = await call('DELETE', '/api/containers/app')
    expect(r.status).toBe(409)
    expect(r.body.error).toMatch(/强制/)
    expect((await call('DELETE', '/api/containers/app?force=1')).status).toBe(200)
    expect(docker.containers).toEqual([])
  })

  it('被用着的镜像删不掉（Docker 的 409 原样带回）', async () => {
    docker.addContainer('openlist')
    docker.images = [{ Id: 'sha256:openlist', RepoTags: ['openlist:latest'], Size: 1, Created: 1 }]
    const r = await call('DELETE', '/api/images/openlist:latest')
    expect(r.status).toBe(409)
    expect(audit).toEqual([])
  })

  it('compose：在项目自己的目录、按标签里的文件执行；输出与退出码流回；进审计', async () => {
    const r = root.replace(/\\/g, '/')
    docker.addContainer('ap', { project: 'account-panel', dir: `${r}/account-panel`, files: `${r}/account-panel/docker-compose.yaml` })
    const result = await stream('/api/projects/account-panel/up')
    expect(result.code).toBe(0)
    expect(result.text).toContain('Started')
    expect(composeCalls).toEqual([{ action: 'up', target: { name: 'account-panel', dir: `${r}/account-panel`, configFiles: [`${r}/account-panel/docker-compose.yaml`] } }])
    expect(audit[0]).toMatchObject({ action: 'docker-compose-up', detail: 'account-panel', exitCode: 0 })
  })

  it('compose 失败：退出码如实带回，审计记失败', async () => {
    docker.addContainer('ap', { project: 'ap', dir: `${root.replace(/\\/g, '/')}/ap` })
    composeExit = 1
    const result = await stream('/api/projects/ap/restart')
    expect(result.code).toBe(1)
    expect(audit[0]).toMatchObject({ action: 'docker-compose-restart', exitCode: 1 })
  })

  it('kura-server 项目、项目目录外的项目：compose 被拒（外面的只允许 down）', async () => {
    docker.addContainer('kura-server', { project: 'kura-server' })
    docker.addContainer('t', { project: 'envtest', dir: '/tmp/envtest' })
    expect((await stream('/api/projects/kura-server/restart')).text).toMatch(/Kura 自己/)
    expect((await stream('/api/projects/envtest/up')).text).toMatch(/只能停止/)
    expect((await stream('/api/projects/envtest/down')).code).toBe(0)
    expect(composeCalls.map((c) => `${c.target.name}:${c.action}`)).toEqual(['envtest:down'])
  })

  it('compose 流也要写头', async () => {
    docker.addContainer('ap', { project: 'ap', dir: `${root.replace(/\\/g, '/')}/ap` })
    expect((await stream('/api/projects/ap/up', false)).status).toBe(403)
    expect(composeCalls).toEqual([])
  })

  it('拉镜像：进度逐行流回；仓库报错时退出码为 1', async () => {
    docker.pullLines = [JSON.stringify({ status: 'Pulling from library/redis', id: 'latest' }), JSON.stringify({ status: 'Download complete', id: 'abc' })]
    const ok = await stream('/api/images/pull?image=redis:7')
    expect(ok.code).toBe(0)
    expect(ok.text).toContain('Download complete')
    expect(docker.calls).toContain('POST /images/create?fromImage=redis&tag=7')
    docker.pullLines = [JSON.stringify({ error: 'manifest unknown' })]
    const bad = await stream('/api/images/pull?image=redis:nope')
    expect(bad.code).toBe(1)
    expect(audit.at(-1)).toMatchObject({ action: 'docker-image-pull', exitCode: 1 })
  })

  it('清理镜像走流式：回收多少写在输出里，结束时退出码 0 并进审计', async () => {
    const { text, code } = await stream('/api/images/prune')
    expect(code).toBe(0)
    expect(text).toContain('悬空镜像')
    expect(text).toContain('1.2 KiB') // fake-docker 固定回 SpaceReclaimed: 1234
    expect(docker.calls.some((c) => c.startsWith('POST /images/prune'))).toBe(true)
    expect(audit.at(-1)).toMatchObject({ action: 'docker-image-prune', exitCode: 0 })
  })

  it('清理镜像也要写头：没写头连不上', async () => {
    expect((await stream('/api/images/prune', false)).status).toBe(403)
    expect(docker.calls.some((c) => c.startsWith('POST /images/prune'))).toBe(false)
  })

  it('all=1 是清所有未使用的（filters 里 dangling=false）', async () => {
    const { code } = await stream('/api/images/prune?all=1')
    expect(code).toBe(0)
    const call = docker.calls.find((c) => c.startsWith('POST /images/prune'))
    expect(decodeURIComponent(call ?? '')).toContain('"dangling":["false"]')
  })

  /**
   * 真机看到的那一幕：点「清理悬空镜像」跑完，绿色的「完成」配着「回收 0 B」，
   * 用户以为清出了空间，去看磁盘一点没变。
   *
   * 0 本身是正常的（悬空镜像只算没有标签的），但**不能把它说成成功**——
   * 得明说「没有可清理」，并指到真正能清旧版本的那一档。
   */
  it('一个都没清到：明说没有可清理，不写「回收 0 B」', async () => {
    docker.pruneReclaims = 0
    const { text, code } = await stream('/api/images/prune')
    expect(code).toBe(0)
    expect(text).toContain('没有可清理的悬空镜像')
    expect(text).toContain('磁盘占用没有变化')
    // 指路：旧版本有标签，`dangling` 这档清不到
    expect(text).toContain('清理未使用镜像')
    // 别再出现「回收 0 B」这种既像成功又没信息量的说法
    expect(text).not.toContain('回收 0 B')
  })

  it('真清到了：输出里写回收了多少', async () => {
    const { text, code } = await stream('/api/images/prune')
    expect(code).toBe(0)
    expect(text).toContain('清理完成，回收')
    expect(text).not.toContain('没有可清理')
  })

  it('最近记录只给 docker-* 的，新的在前', async () => {
    docker.addContainer('app', { project: 'app' })
    await call('POST', '/api/containers/app/restart')
    await call('POST', '/api/containers/app/stop')
    const { body } = await call('GET', '/api/activity')
    expect(body.map((a: AuditEntry) => a.action)).toEqual(['docker-stop', 'docker-restart'])
  })
})
