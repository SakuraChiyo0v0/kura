import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import type { AddressInfo, Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WebSocket } from 'ws'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ComposeAction, ComposeRun, ComposeTarget } from '../src/docker/compose.js'
import { DockerEngine } from '../src/docker/engine.js'
import { ProjectFileStore, backupDir, type FileValidator } from '../src/docker/files.js'
import { createDockerHandler } from '../src/docker/handler.js'
import { DockerService } from '../src/docker/service.js'
import type { AuditEntry } from '../src/shell/audit.js'
import { FakeDocker } from './fake-docker.js'

/** 假校验：内容里出现 `BROKEN` 就报错（真机上是 docker compose config -q）。也记下它看到的文件。 */
let validated: Array<{ files: string[]; env: string | undefined }> = []
const fakeValidator: FileValidator = async (_dir, files, env) => {
  validated.push({ files, env })
  for (const f of files) if (readFileSync(f, 'utf8').includes('BROKEN')) return `${f.split('/').pop()}: yaml: line 1: did not find expected key`
  if (env && readFileSync(env, 'utf8').includes('BROKEN')) return 'bad env'
  return ''
}

let root = ''
let store: ProjectFileStore

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'kura-files-')).replace(/\\/g, '/')
  store = new ProjectFileStore(root, fakeValidator)
  validated = []
  mkdirSync(`${root}/app`)
  writeFileSync(`${root}/app/docker-compose.yaml`, 'services:\n  app:\n    image: app:1\n')
  writeFileSync(`${root}/app/.env`, 'TZ=Asia/Shanghai\n')
  mkdirSync(`${root}/app/data`)
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

const files = () => [`${root}/app/docker-compose.yaml`]

describe('ProjectFileStore', () => {
  it('读：compose 与 .env 的内容', () => {
    const r = store.read(`${root}/app`, files())
    expect(r.compose).toEqual([{ path: `${root}/app/docker-compose.yaml`, content: 'services:\n  app:\n    image: app:1\n' }])
    expect(r.env).toMatchObject({ content: 'TZ=Asia/Shanghai\n', exists: true })
    expect(r.backups).toEqual([])
  })

  it('写：校验通过才落盘，旧版本进备份', async () => {
    const r = await store.write(`${root}/app`, files(), { compose: [{ path: files()[0]!, content: 'services:\n  app:\n    image: app:2\n' }], env: 'TZ=UTC\n' })
    expect(readFileSync(`${root}/app/docker-compose.yaml`, 'utf8')).toContain('app:2')
    expect(readFileSync(`${root}/app/.env`, 'utf8')).toBe('TZ=UTC\n')
    expect(r.backups).toHaveLength(1)
    const bak = `${root}/app/${backupDir}/${r.backups[0]}`
    expect(readFileSync(`${bak}/docker-compose.yaml`, 'utf8')).toContain('app:1')
    expect(readFileSync(`${bak}/.env`, 'utf8')).toBe('TZ=Asia/Shanghai\n')
    // 校验看到的是改后的临时副本，而且临时文件都清掉了
    expect(validated[0]!.files[0]).toMatch(/\.kura-check-/)
    expect(readdirSync(`${root}/app`).filter((n) => n.startsWith('.kura-'))).toEqual(['.kura-bak'])
  })

  it('改坏了存不进去：原文件一个字节都不动、不留备份、不留临时文件', async () => {
    await expect(store.write(`${root}/app`, files(), { compose: [{ path: files()[0]!, content: 'BROKEN' }] })).rejects.toThrow(/校验没通过/)
    expect(readFileSync(`${root}/app/docker-compose.yaml`, 'utf8')).toContain('app:1')
    expect(existsSync(`${root}/app/${backupDir}`)).toBe(false)
    expect(readdirSync(`${root}/app`).filter((n) => n.startsWith('.kura-'))).toEqual([])
  })

  it('错误信息里不露临时文件名', async () => {
    const error = await store.write(`${root}/app`, files(), { compose: [{ path: files()[0]!, content: 'BROKEN' }] }).catch((e: Error) => e)
    expect(String(error)).toContain('docker-compose.yaml')
    expect(String(error)).not.toContain('.kura-check-')
  })

  it('只能写这个项目自己的 compose 文件；目录必须是项目目录下的一层', async () => {
    await expect(store.write(`${root}/app`, files(), { compose: [{ path: `${root}/app/other.yaml`, content: 'x' }] })).rejects.toThrow(/不能写/)
    await expect(store.write(`${root}/app`, [`${root}/elsewhere/c.yaml`], { compose: [] })).rejects.toThrow(/不在项目目录/)
    expect(() => store.read(`${root}/app/data`, files())).toThrow(/只能修改项目目录/)
    expect(() => store.read(`${root}/../etc`, files())).toThrow(/只能修改项目目录/)
    expect(() => store.read('/tmp/envtest', ['/tmp/envtest/c.yml'])).toThrow(/只能修改项目目录/)
  })

  it('备份只留最近 10 份', async () => {
    for (let i = 0; i < 12; i++) {
      await store.write(`${root}/app`, files(), { compose: [{ path: files()[0]!, content: `services:\n  app:\n    image: app:${i}\n` }] })
      await new Promise((r) => setTimeout(r, 5)) // 备份目录名是毫秒时间戳
    }
    expect(store.listBackups(`${root}/app`)).toHaveLength(10)
  })

  it('新建：建目录、写文件；已存在就拒绝；校验失败不留东西', async () => {
    const created = await store.create('new-app', 'services:\n  x:\n    image: x\n', 'A=1\n')
    expect(created.configFiles).toEqual([`${root}/new-app/docker-compose.yaml`])
    expect(readFileSync(`${root}/new-app/.env`, 'utf8')).toBe('A=1\n')
    await expect(store.create('new-app', 'services: {}', '')).rejects.toThrow(/已经存在/)
    await expect(store.create('broken-app', 'BROKEN', '')).rejects.toThrow(/校验没通过/)
    expect(existsSync(`${root}/broken-app`)).toBe(false)
    await expect(store.create('Bad Name', 'x', '')).rejects.toThrow(/项目名/)
  })

  it('删文件：只删 compose / .env / 备份；目录里有数据就整个留着', async () => {
    await store.write(`${root}/app`, files(), { compose: [{ path: files()[0]!, content: 'services: {}\n' }] })
    const r = store.removeFiles(`${root}/app`, files())
    expect(r.removed.map((p) => p.split('/').pop())).toEqual(['docker-compose.yaml', '.env', backupDir])
    expect(r.kept).toEqual(['data'])
    expect(existsSync(`${root}/app/data`)).toBe(true)
  })
})

// ---------------------------------------------------------------- 经 HTTP

describe('docker 内置服务：项目文件与删除', () => {
  let docker: FakeDocker
  let server: http.Server
  let base = ''
  let audit: AuditEntry[]
  let composeCalls: string[]
  /** 设了就让假 compose 一直不结束，直到它 resolve */
  let hold: Promise<number> | undefined

  beforeEach(async () => {
    docker = await new FakeDocker().start()
    audit = []
    composeCalls = []
    const engine = new DockerEngine({ socketPath: docker.socketPath })
    const handler = createDockerHandler({
      engine,
      service: new DockerService({ engine, projectRoot: root }),
      files: store,
      audit: (e) => audit.push({ ...e, at: '', id: '', user: 'kura' }),
      activity: () => audit,
      compose: (t: ComposeTarget, action: ComposeAction): ComposeRun => {
        composeCalls.push(`${t.name}:${action}`)
        return { onOutput: () => {}, done: hold ?? Promise.resolve(0), kill: () => {} }
      },
    })
    server = http.createServer((req, res) => void handler.handle(req, res))
    server.on('upgrade', (req, socket, head) => handler.upgrade(req, socket as Socket, head))
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    docker.addContainer('app-1', { project: 'app', dir: `${root}/app`, files: `${root}/app/docker-compose.yaml` })
  })
  afterEach(async () => {
    server.closeAllConnections()
    await new Promise<void>((r) => server.close(() => r()))
    await docker.stop()
  })

  const send = (method: string, path: string, body?: unknown) =>
    fetch(base + path, { method, headers: { 'x-kura-docker': '1', 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })

  const ws = (path: string) =>
    new Promise<{ text: string; code?: number }>((resolve) => {
      const s = new WebSocket(base.replace('http', 'ws') + path, { headers: { 'x-kura-docker': '1' } })
      let text = ''
      let code: number | undefined
      s.on('message', (d) => {
        const t = d.toString()
        if (t.startsWith('{"type":"exit"')) code = JSON.parse(t).code
        else text += t
      })
      s.on('close', () => resolve({ text, code }))
    })

  it('GET / PUT 文件；坏的 compose 回 422 并说清原因；进审计', async () => {
    const got = await (await fetch(`${base}/api/projects/app/files`)).json()
    expect(got.env.content).toBe('TZ=Asia/Shanghai\n')
    const bad = await send('PUT', '/api/projects/app/files', { compose: [{ path: files()[0], content: 'BROKEN' }] })
    expect(bad.status).toBe(422)
    expect((await bad.json()).error).toMatch(/did not find expected key/)
    const ok = await send('PUT', '/api/projects/app/files', { compose: [{ path: files()[0], content: 'services: {}\n' }], env: 'X=1\n' })
    expect(ok.status).toBe(200)
    expect(audit.map((a) => a.action)).toEqual(['docker-files-save'])
    expect(audit[0]!.detail).toBe('app：docker-compose.yaml、.env')
  })

  it('目录外的项目、Kura 自己：不给读写文件', async () => {
    docker.addContainer('t', { project: 'envtest', dir: '/tmp/envtest', files: '/tmp/envtest/c.yml' })
    docker.addContainer('kura-server', { project: 'kura-server', dir: `${root}/kura-server` })
    expect((await fetch(`${base}/api/projects/envtest/files`)).status).toBe(403)
    expect((await fetch(`${base}/api/projects/kura-server/files`)).status).toBe(403)
  })

  it('新建项目', async () => {
    const r = await send('POST', '/api/projects', { name: 'fresh', compose: 'services: {}\n' })
    expect(r.status).toBe(200)
    expect(existsSync(`${root}/fresh/docker-compose.yaml`)).toBe(true)
    expect(audit.at(-1)).toMatchObject({ action: 'docker-project-create', detail: 'fresh' })
  })

  it('删除项目：默认只 down（不带 -v、不删文件）', async () => {
    const r = await ws('/api/projects/app/remove')
    expect(r.code).toBe(0)
    expect(composeCalls).toEqual(['app:down'])
    expect(existsSync(`${root}/app/docker-compose.yaml`)).toBe(true)
  })

  it('删除项目：勾了才删卷、删文件；数据目录留着', async () => {
    const r = await ws('/api/projects/app/remove?volumes=1&files=1')
    expect(r.code).toBe(0)
    expect(composeCalls).toEqual(['app:down-volumes'])
    expect(existsSync(`${root}/app/docker-compose.yaml`)).toBe(false)
    expect(existsSync(`${root}/app/data`)).toBe(true)
    expect(r.text).toMatch(/整个目录保留/)
    expect(audit.at(-1)).toMatchObject({ action: 'docker-project-remove', detail: 'app · 删卷 · 删文件' })
  })

  it('down-volumes 不能直接调（只能经删除项目、显式勾选）', async () => {
    const r = await new Promise<number | undefined>((resolve) => {
      const s = new WebSocket(base.replace('http', 'ws') + '/api/projects/app/down-volumes', { headers: { 'x-kura-docker': '1' } })
      s.on('unexpected-response', (_q, res) => resolve(res.statusCode))
      s.on('open', () => resolve(101))
    })
    expect(r).toBe(404)
    expect(composeCalls).toEqual([])
  })

  it('同一个项目两个 compose 不能叠着跑；前一个结束后占位放掉', async () => {
    let release!: (code: number) => void
    hold = new Promise((r) => (release = r))
    const first = ws('/api/projects/app/restart')
    await new Promise((r) => setTimeout(r, 100))
    const second = await ws('/api/projects/app/up')
    expect(second.code).toBe(1)
    expect(second.text).toMatch(/正在执行别的操作/)
    release(0)
    expect((await first).code).toBe(0)
    hold = undefined
    expect((await ws('/api/projects/app/up')).code).toBe(0)
    expect(composeCalls).toEqual(['app:restart', 'app:up'])
  })
})
