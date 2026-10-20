import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AutoUpdate, type AutoUpdateOptions } from '../src/docker/autoupdate.js'
import type { ComposeAction, ComposeRun, ComposeTarget } from '../src/docker/compose.js'
import { DockerEngine } from '../src/docker/engine.js'
import { selfUpdateArgs } from '../src/docker/selfupdate.js'
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

/** 从状态文件的当前内容造一个实例（不重置它）。 */
function load(options: Partial<AutoUpdateOptions> = {}): AutoUpdate {
  const engine = new DockerEngine({ socketPath: docker.socketPath, timeoutMs: 5_000 })
  // 没有 `/host` → mounts.ts 退回「存在就算可达」，即原路径就是本地路径（临时目录这个形状）
  const service = new DockerService({ engine, projectRoot: root.replace(/\\/g, '/') })
  return new AutoUpdate({ engine, service, file: file.replace(/\\/g, '/'), intervalMs: 0, compose: fakeCompose, ...options })
}

/** 从「一个都没开」起步（写一个空状态文件），免得每轮都被默认列表里的 kura-server 带偏。 */
function make(options: Partial<AutoUpdateOptions> = {}): AutoUpdate {
  writeFileSync(file, JSON.stringify({ version: 1, projects: [] }))
  return load(options)
}

/** 自更新的假执行器：记下收到的 target，返回一个可指定退出码的结果。 */
function fakeSelfUpdate(sink: Array<{ name: string; image: string; dir: string; configFiles: string[]; socketPath: string }>, code = 0) {
  return (target: { name: string; image: string; dir: string; configFiles: string[]; socketPath: string }) => {
    sink.push(target)
    const listeners: Array<(t: string) => void> = []
    const done = Promise.resolve().then(() => {
      if (code !== 0) for (const l of listeners) l('Cannot connect to the Docker daemon\n')
      return code
    })
    return { container: 'kura-self-update-test', onOutput: (l: (t: string) => void) => listeners.push(l), done }
  }
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

  it('kura-server 自己也能开（用户要的：不再依赖 watchtower）', () => {
    const auto = make()
    expect(auto.set('kura-server', true).projects).toEqual(['kura-server'])
  })

  it('没状态文件时默认就开着 Kura 自己（别的项目仍然默认关）', () => {
    rmSync(file, { force: true })
    // 不经过 make()：它会把空状态文件写下去
    const engine = new DockerEngine({ socketPath: docker.socketPath, timeoutMs: 5_000 })
    // 没有 `/host` → mounts.ts 退回「存在就算可达」，即原路径就是本地路径（临时目录这个形状）
  const service = new DockerService({ engine, projectRoot: root.replace(/\\/g, '/') })
    const auto = new AutoUpdate({ engine, service, file: file.replace(/\\/g, '/'), intervalMs: 0, compose: fakeCompose })

    expect(auto.status().projects).toEqual(['kura-server'])
  })

  it('更新自己：走那条短命兄弟容器，不在本进程里跑 compose', async () => {
    // kura-server 容器：镜像有新版
    docker.addContainer('kura-server-app-1', { project: 'kura-server', dir: '/volume1/docker/kura-server', image: 'ghcr.io/x/kura-server:latest' })
    registerImage('ghcr.io/x/kura-server:latest')
    const calls: Array<{ name: string; image: string; dir: string; configFiles: string[]; socketPath: string }> = []
    const auto = make({ self: { socketPath: '/var/run/docker.sock' }, selfUpdate: fakeSelfUpdate(calls) })
    auto.set('kura-server', true)

    const results = await auto.tick()

    // 关键：**没走本进程里的 compose**（那条会把执行它的自己停掉）
    expect(composeCalls).toEqual([])
    // 目录来自容器自己的 compose 标签，不是从这里传下去的默认值
    expect(calls).toEqual([expect.objectContaining({ name: 'kura-server', image: 'ghcr.io/x/kura-server:latest', dir: '/volume1/docker/kura-server' })])
    expect(results).toEqual([expect.objectContaining({ project: 'kura-server', ok: true })])
  })

  it('更新自己：目录跟着容器标签走（换目录部署不用再配 KURA_SELF_DIR）', async () => {
    // 部署根不在默认的 /volume1/docker/kura-server 下 —— 以前这里要靠环境变量，漏了就更新到错的目录
    docker.addContainer('kura-server-app-1', { project: 'kura-server', dir: '/volume2/apps/kura-server', image: 'ghcr.io/x/kura-server:latest' })
    registerImage('ghcr.io/x/kura-server:latest')
    const calls: Array<{ name: string; image: string; dir: string; configFiles: string[]; socketPath: string }> = []
    const auto = make({ self: { socketPath: '/var/run/docker.sock' }, selfUpdate: fakeSelfUpdate(calls) })
    auto.set('kura-server', true)

    await auto.tick()

    expect(calls[0]).toMatchObject({ dir: '/volume2/apps/kura-server' })
  })

  it('更新自己：kura-server 不是 compose 起的（没有项目标签）就说清，不去猜目录', async () => {
    // `docker run` 起的老独立容器没有 com.docker.compose.* 标签，但它**仍然是** kura-server ——
    // 认自己的依据是容器名（selfProject），不是项目标签（见 DockerService.projectsFrom 顶部）。
    docker.addContainer('kura-server', { image: 'ghcr.io/x/kura-server:latest' })
    registerImage('ghcr.io/x/kura-server:latest')
    const calls: Array<{ name: string; image: string; dir: string; configFiles: string[]; socketPath: string }> = []
    const auto = make({ self: { socketPath: '/var/run/docker.sock' }, selfUpdate: fakeSelfUpdate(calls) })
    auto.set('kura-server', true)

    const results = await auto.tick()

    // 以前会拿 /volume1/docker/kura-server 这个默认值硬跑 —— 目录不对等于在错的地方部署
    expect(calls).toEqual([])
    expect(results).toEqual([expect.objectContaining({ project: 'kura-server', ok: false, reason: expect.stringMatching(/不是用 compose 起的/) })])
  })

  it('更新自己时兄弟容器起不来：如实报错', async () => {
    docker.addContainer('kura-server-app-1', { project: 'kura-server', dir: '/volume1/docker/kura-server', image: 'ghcr.io/x/kura-server:latest' })
    registerImage('ghcr.io/x/kura-server:latest')
    const calls: Array<{ name: string; image: string; dir: string; configFiles: string[]; socketPath: string }> = []
    const auto = make({ self: { socketPath: '/var/run/docker.sock' }, selfUpdate: fakeSelfUpdate(calls, 1) })
    auto.set('kura-server', true)

    const results = await auto.tick()

    expect(composeCalls).toEqual([])
    expect(results).toEqual([expect.objectContaining({ project: 'kura-server', ok: false, reason: expect.stringMatching(/起不了更新用的容器/) })])
  })

  it('没配自更新的信息（如宿主没挂 docker.sock）：说清更新不了自己，不硬跑', async () => {
    docker.addContainer('kura-server-app-1', { project: 'kura-server', dir: '/volume1/docker/kura-server', image: 'ghcr.io/x/kura-server:latest' })
    registerImage('ghcr.io/x/kura-server:latest')
    const auto = make() // 没给 self
    auto.set('kura-server', true)

    const results = await auto.tick()

    expect(composeCalls).toEqual([])
    expect(results).toEqual([expect.objectContaining({ project: 'kura-server', ok: false, reason: expect.stringMatching(/没配自更新/) })])
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
    expect(load().status().projects).toEqual(['bili23-web'])
    expect(load().isOn('bili23-web')).toBe(true)
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
    const auto = make({ locks })
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

describe('自更新用的 docker 命令', () => {
  const target = {
    name: 'kura-server',
    dir: '/volume1/docker/kura-server',
    configFiles: ['/volume1/docker/kura-server/docker-compose.yaml'],
    image: 'ghcr.io/x/kura-server:latest',
    socketPath: '/var/run/docker.sock',
  }

  it('起的是不属于这个 compose 项目的短命容器（-d + --rm + --name）', () => {
    const args = selfUpdateArgs(target, 'kura-self-update-abc')
    expect(args.slice(0, 2)).toEqual(['run', '--rm'])
    // -d 必须有：它得活过 kura-server 被停的那一刻。少了这个，compose 一停自己就跟着没了
    expect(args).toContain('-d')
    expect(args[args.indexOf('--name') + 1]).toBe('kura-self-update-abc')
    expect(args).toContain('--pull=never')
    // 脚本走位置变量，正文里不拼路径 —— 拼了就成注入面
    expect(args[args.indexOf('-c') + 1]).toBe('sleep 3; n="$1"; shift; docker compose -p "$n" "$@" pull && docker compose -p "$n" "$@" up -d')
  })

  it('docker.sock 与项目目录按原路径挂进去，项目目录只读', () => {
    const args = selfUpdateArgs(target, 'c')
    expect(args).toContain('/var/run/docker.sock:/var/run/docker.sock')
    expect(args).toContain('/volume1/docker/kura-server:/volume1/docker/kura-server:ro')
  })

  it('项目名过了 compose 的校验才进 -p 参数', () => {
    expect(() => selfUpdateArgs({ ...target, name: 'bad name!' }, 'c')).toThrow(/不合法的项目名/)
  })
})
