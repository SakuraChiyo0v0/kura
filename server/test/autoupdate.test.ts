import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AutoUpdate } from '../src/docker/autoupdate.js'
import type { ComposeAction, ComposeRun, ComposeTarget } from '../src/docker/compose.js'
import { DockerEngine } from '../src/docker/engine.js'
import { ProjectLocks } from '../src/docker/locks.js'
import { DockerService } from '../src/docker/service.js'
import { FakeDocker } from './fake-docker.js'

let docker: FakeDocker
let root = ''
let file = ''
let composeCalls: Array<{ target: ComposeTarget; action: ComposeAction }> = []
let composeExit = 0
let composeThrows = ''

function fakeCompose(target: ComposeTarget, action: ComposeAction): ComposeRun {
  if (composeThrows) throw new Error(composeThrows)
  composeCalls.push({ target, action })
  const listeners: Array<(t: string) => void> = []
  const done = Promise.resolve().then(() => {
    const text = composeExit === 0 ? ` Container ${target.name}-app-1  Started\n` : `Error response from daemon: pull failed for ${target.name}\n`
    for (const l of listeners) l(text)
    return composeExit
  })
  return { onOutput: (l) => listeners.push(l), done, kill: () => {} }
}

function make(): AutoUpdate {
  const engine = new DockerEngine({ socketPath: docker.socketPath, timeoutMs: 5_000 })
  const service = new DockerService({ engine, projectRoot: root.replace(/\\/g, '/'), appstoreMounted: true })
  return new AutoUpdate({ engine, service, file: file.replace(/\\/g, '/'), intervalMs: 0, compose: fakeCompose })
}

/** 镜像要有本地 digest 可读（checkUpdate 靠 inspectImage 拿本地 RepoDigests）。 */
function registerImage(image: string, remote = 'sha256:new'): void {
  docker.images.push({ Id: `sha256:${image}`, RepoTags: [image], Size: 1024, Created: 1_700_000_000 })
  docker.repoDigests.set(image, [`${image.replace(/:[^/:]+$/, '')}@sha256:old`])
  docker.remoteDigests.set(image, remote)
}

/** 一个在项目目录下、镜像有新版的项目。 */
function manageable(name: string, image = `${name}:latest`): void {
  docker.addContainer(`${name}-app-1`, { project: name, dir: `${root.replace(/\\/g, '/')}/${name}`, image })
  registerImage(image)
}

beforeEach(async () => {
  docker = await new FakeDocker().start()
  root = mkdtempSync(join(tmpdir(), 'kura-auto-'))
  file = join(root, 'autoupdate.json')
  composeCalls = []
  composeExit = 0
  composeThrows = ''
})

afterEach(async () => {
  await docker.stop()
  rmSync(root, { recursive: true, force: true })
})

describe('自动更新的开关', () => {
  it('默认什么都没开，一轮跑下来一个 compose 都不调', async () => {
    manageable('openlist')
    const auto = make()
    expect(auto.status().projects).toEqual([])

    const results = await auto.tick()

    expect(results).toEqual([])
    expect(composeCalls).toEqual([])
  })

  it('开了开关的项目：有新版才 pull + up（顺序不能反）', async () => {
    manageable('openlist')
    const auto = make()
    auto.set('openlist', true)

    const results = await auto.tick()

    expect(composeCalls.map((c) => c.action)).toEqual(['pull', 'up'])
    expect(composeCalls[0]!.target.name).toBe('openlist')
    expect(results).toEqual([expect.objectContaining({ project: 'openlist', images: ['openlist:latest'], ok: true })])
  })

  it('已经是最新版就不拉：checkUpdate 没变化时一个 compose 都不调', async () => {
    manageable('openlist')
    // 本地 digest 和仓库一样 = 没有新版
    registerImage('openlist:latest', 'sha256:old')
    const auto = make()
    auto.set('openlist', true)

    const results = await auto.tick()

    expect(composeCalls).toEqual([])
    // 没变化不进结果 —— 否则每轮都堆一堆「没变」，界面上一片噪音
    expect(results).toEqual([])
  })

  it('kura-server 自己开不了：set 直接拒绝', () => {
    const auto = make()
    expect(() => auto.set('kura-server', true)).toThrow(/watchtower/)
    expect(auto.status().projects).toEqual([])
  })

  it('状态文件被人手改塞进 kura-server：跑的时候也拦下来，绝不动它', async () => {
    docker.addContainer('kura-server-app-1', { project: 'kura-server', dir: `${root.replace(/\\/g, '/')}/kura-server`, image: 'ghcr.io/x/kura-server:latest' })
    registerImage('ghcr.io/x/kura-server:latest')
    // 绕过 set() 的拦截，直接写状态文件（手改的情形）
    writeFileSync(file, JSON.stringify({ version: 1, projects: ['kura-server'] }))

    const results = await make().tick()

    expect(composeCalls).toEqual([])
    expect(results).toEqual([expect.objectContaining({ project: 'kura-server', ok: false, reason: expect.stringMatching(/watchtower/) })])
  })

  it('不在项目目录里的项目（external）：说清动不了，不硬跑', async () => {
    // 目录在项目根之外（/tmp 那种）：compose 文件根本读不到
    docker.addContainer('envtest-app-1', { project: 'envtest', dir: '/tmp/envtest', image: 'envtest:latest' })
    registerImage('envtest:latest')
    const auto = make()
    auto.set('envtest', true)

    const results = await auto.tick()

    expect(composeCalls).toEqual([])
    expect(results).toEqual([expect.objectContaining({ project: 'envtest', ok: false, reason: expect.stringMatching(/不在项目目录/) })])
  })

  it('pull 失败：不动在跑的那些，结果里带上最后一行报错', async () => {
    manageable('openlist')
    composeExit = 1
    const auto = make()
    auto.set('openlist', true)

    const results = await auto.tick()

    // 只有 pull 被调了 —— up 不该在 pull 失败后还跑
    expect(composeCalls.map((c) => c.action)).toEqual(['pull'])
    expect(results).toEqual([expect.objectContaining({ project: 'openlist', ok: false, reason: expect.stringMatching(/pull failed/) })])
  })

  it('开关落盘再读回来：状态文件是真相来源', () => {
    const auto = make()
    auto.set('openlist', true)
    auto.set('bili23-web', true)
    auto.set('openlist', false)

    expect(auto.status().projects).toEqual(['bili23-web'])
    // 新实例从同一个文件读
    expect(make().status().projects).toEqual(['bili23-web'])
    expect(make().isOn('bili23-web')).toBe(true)
  })

  it('一个项目 compose 起不来，不该把同一轮里别的项目带倒', async () => {
    // 两个都有新版：第一个的 compose 同步抛（真机上就是目录不可达那种）
    manageable('openlist')
    manageable('bili23-web')
    composeThrows = '项目目录没挂进来'
    const auto = make()
    auto.set('bili23-web', true)
    auto.set('openlist', true)

    const results = await auto.tick()

    expect(results).toHaveLength(2)
    expect(results.every((r) => r.ok === false)).toBe(true)
    expect(results.every((r) => /起不来/.test(r.reason))).toBe(true)
  })

  it('仓库问不到（unknown）不算「都是最新的」：如实报出来', async () => {
    manageable('openlist')
    // 把仓库那条路掐掉：inspectImage 拿得到（有本地 digest），但问不到远端
    docker.remoteDigests.delete('openlist:latest')
    const auto = make()
    auto.set('openlist', true)

    const results = await auto.tick()

    expect(composeCalls).toEqual([])
    expect(results).toEqual([expect.objectContaining({ project: 'openlist', ok: false, reason: expect.stringMatching(/问不到仓库/) })])
  })

  it('用户正在手动操作这个项目：这一轮跳过它，不算失败', async () => {
    manageable('openlist')
    const locks = new ProjectLocks()
    const engine = new DockerEngine({ socketPath: docker.socketPath, timeoutMs: 5_000 })
    const service = new DockerService({ engine, projectRoot: root.replace(/\\/g, '/'), appstoreMounted: true })
    const auto = new AutoUpdate({ engine, service, file: file.replace(/\\/g, '/'), intervalMs: 0, compose: fakeCompose, locks })
    auto.set('openlist', true)
    // 模拟界面上正占着这个项目（例如用户在点「重启」）
    let release = () => {}
    const holding = locks.run('openlist', () => new Promise<void>((r) => (release = r)))

    const results = await auto.tick()

    expect(composeCalls).toEqual([])
    expect(results).toEqual([expect.objectContaining({ project: 'openlist', ok: false, reason: expect.stringMatching(/手动操作/) })])
    release()
    await holding
  })

  it('锁是共用的：自动更新占着的时候，界面那条路径拿不到（反向也一样）', async () => {
    const locks = new ProjectLocks()
    let release = () => {}
    const holding = locks.run('openlist', () => new Promise<void>((r) => (release = r)))
    await expect(locks.run('openlist', async () => 1)).rejects.toThrow(/正在执行别的操作/)
    release()
    await holding
    // 放掉之后又能拿了
    await expect(locks.run('openlist', async () => 1)).resolves.toBe(1)
  })

  it('项目根本没起过容器（目录里有 compose 文件）：跳过，不去猜镜像', async () => {
    // 项目目录下建一个空项目：能被 scanProjectRoot 发现，但一个容器都没有
    mkdirSync(join(root, 'never-started'), { recursive: true })
    writeFileSync(join(root, 'never-started', 'compose.yaml'), 'services: {}\n')
    const auto = make()
    auto.set('never-started', true)

    const results = await auto.tick()

    expect(composeCalls).toEqual([])
    expect(results).toEqual([])
  })
})
