import { existsSync, statSync } from 'node:fs'
import net from 'node:net'
import { randomBytes } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DockerSocketResolver, findDockerSocket, socketCandidates } from '../src/docker/socket.js'

/**
 * Docker socket 的自动发现。
 *
 * 判据只有两个（文件是不是 socket、daemon 答不答应），测试直接把这两个换掉 ——
 * 不需要真的 dockerd。真机上的实测（同一个 inode、`/v1.43/info` 正常应答）见 socket.ts 顶部注释。
 */

describe('socketCandidates：显式配置优先', () => {
  it('配了环境变量就只认它，不再猜别的', () => {
    const list = socketCandidates('/var/run/docker.sock')
    expect(list).toEqual([{ path: '/var/run/docker.sock', hostPath: '/var/run/docker.sock', source: 'env' }])
  })

  it('空串 / 只有空格当作没配', () => {
    expect(socketCandidates('').length).toBeGreaterThan(1)
    expect(socketCandidates('   ').length).toBeGreaterThan(1)
  })

  it('没配时先试挂载点，再试经 /host 看见的那份', () => {
    const list = socketCandidates(undefined)
    expect(list.map((s) => s.path)).toEqual([
      '/var/run/docker.sock',
      '/run/docker.sock',
      '/host/run/docker.sock',
      '/host/var/run/docker.sock',
    ])
  })

  it('经 /host 找到的，宿主路径要去掉 /host 前缀', () => {
    // 这条最关键：自更新的兄弟容器按**宿主**路径挂载，写成 /host/run/docker.sock 会挂出空目录
    const hostRoot = socketCandidates(undefined).find((s) => s.path === '/host/run/docker.sock')
    expect(hostRoot).toMatchObject({ hostPath: '/run/docker.sock', source: 'host-root' })
  })
})

describe('findDockerSocket：文件在 + 真能应答才算找到', () => {
  it('第一个候选就能用', async () => {
    const found = await findDockerSocket({
      isSocket: (p) => p === '/var/run/docker.sock',
      ping: async () => true,
    })
    expect(found).toMatchObject({ path: '/var/run/docker.sock', source: 'mounted' })
  })

  it('文件在但 daemon 不答应：跳过，继续试下一个', async () => {
    // 这就是「docker 正在升级 / 宿主刚重启」的样子，只看文件类型会误判成可用
    const found = await findDockerSocket({
      isSocket: (p) => p === '/var/run/docker.sock' || p === '/host/run/docker.sock',
      ping: async (p) => p === '/host/run/docker.sock',
    })
    expect(found).toMatchObject({ path: '/host/run/docker.sock', hostPath: '/run/docker.sock', source: 'host-root' })
  })

  it('一个都没有：返回 undefined（Docker 功能不开）', async () => {
    expect(await findDockerSocket({ isSocket: () => false, ping: async () => true })).toBeUndefined()
  })

  it('配了环境变量但它不能用：不偷偷回退到别的 —— 用户显式说的算', async () => {
    const found = await findDockerSocket({
      env: '/custom/docker.sock',
      isSocket: (p) => p !== '/custom/docker.sock',
      ping: async () => true,
    })
    expect(found).toBeUndefined()
  })

  it('跳过的候选会写进日志（排「为什么没开」要看得到）', async () => {
    const lines: string[] = []
    await findDockerSocket({
      isSocket: () => true,
      ping: async () => false,
      rounds: 1, // 只看一轮，不然轮询会让条数翻倍
      log: (message) => lines.push(message),
    })
    expect(lines.length).toBe(4)
    expect(lines[0]).toContain('没应答')
  })
})

/**
 * 轮询与自愈。
 *
 * 2026-10-25 真机：宿主重启后容器跟着起来，那一刻 dockerd 还没 listening。
 * 旧实现 6 秒内探不到就**判定整个进程没有 Docker**，此后永不重探 —— 容器健康、socket 早就好了，
 * 但 Docker 页永久显示「镜像太旧」，只能人工重启容器。
 */
describe('findDockerSocket：会轮询，不是探一次就走', () => {
  it('第一轮没应答、第二轮才通 —— 要能等到', async () => {
    let round = 0
    const found = await findDockerSocket({
      isSocket: () => true,
      ping: async () => {
        round++
        // 每轮 4 个候选（默认）；前两轮（8 次 ping）全失败，从第 9 次起通
        return round > 8
      },
      delayMs: 0,
      sleep: async () => {},
    })
    expect(found).toMatchObject({ source: 'mounted' })
  })

  it('给 1 轮就只探一轮（不要无限重试）', async () => {
    let pings = 0
    const found = await findDockerSocket({
      isSocket: () => true,
      ping: async () => {
        pings++
        return false
      },
      rounds: 1,
      delayMs: 0,
      sleep: async () => {},
    })
    expect(found).toBeUndefined()
    expect(pings).toBe(8) // 4 个候选 × answered 内部的 2 次重试
  })
})

/**
 * resolver：启动探不到也**不判死**，下次要用时再探。
 * 这是「自愈」真正的落点 —— 没有它，轮询只是把「6 秒」变成「9 秒」，仍然是一次性的。
 */
describe('DockerSocketResolver：探不到不判死，之后能自愈', () => {
  it('启动时探不到，冷却过后再问就好了', async () => {
    let ready = false
    let now = 0
    const resolver = new DockerSocketResolver(
      {
        isSocket: () => true,
        ping: async () => ready,
        rounds: 1,
        delayMs: 0,
        sleep: async () => {},
      },
      10_000,
      () => now,
    )

    expect(await resolver.get()).toBeUndefined() // 启动那一刻：dockerd 还没起来
    expect(resolver.current()).toBeUndefined()

    // socket 恢复了。但冷却期内不重探（别让一串失败请求把 socket 打爆）
    ready = true
    now += 5_000
    expect(await resolver.get()).toBeUndefined()

    // 过了冷却：自愈
    now += 6_000
    const found = await resolver.get()
    expect(found).toBeDefined()
    expect(resolver.current()).toBe(found) // 缓存住，后续请求不再 ping
  })

  it('并发调用共用同一次探测（不会同时 ping 一堆）', async () => {
    let probes = 0
    const resolver = new DockerSocketResolver(
      {
        isSocket: () => true,
        ping: async () => {
          probes++
          await new Promise((r) => setTimeout(r, 5))
          return true
        },
        rounds: 1,
        delayMs: 0,
        sleep: async () => {},
      },
      0,
      () => 0,
    )
    const all = await Promise.all([resolver.get(), resolver.get(), resolver.get()])
    expect(all.every((x) => x !== undefined)).toBe(true)
    // 4 个候选 × answered 的 2 次，但只有一个"轮次"在跑：只要不是三份各跑一遍即可
    expect(probes).toBeLessThan(24)
  })

  it('invalidate 之后会重新探（daemon 重启、原 socket 已失效）', async () => {
    let probes = 0
    const resolver = new DockerSocketResolver(
      {
        isSocket: () => true,
        ping: async () => {
          probes++
          return true
        },
        rounds: 1,
        delayMs: 0,
        sleep: async () => {},
      },
      0,
      () => 0,
    )
    await resolver.get()
    const afterFirst = probes
    // 缓存住：再问不重新 ping
    await resolver.get()
    expect(probes).toBe(afterFirst)

    // 调用方发现连不上了 → 丢掉缓存
    resolver.invalidate()
    expect(resolver.current()).toBeUndefined()
    await resolver.get()
    expect(probes).toBeGreaterThan(afterFirst) // 真的重新探了
  })

  it('require() 没 socket 时抛出人话错误（不是一句 undefined）', () => {
    const resolver = new DockerSocketResolver(
      { isSocket: () => false, ping: async () => false, rounds: 1, delayMs: 0, sleep: async () => {} },
      10_000,
      () => 0,
    )
    expect(() => resolver.require()).toThrow(/Docker socket 暂时不可用/)
  })
})

/**
 * 真实的 socket 文件 —— 用**默认的** isSocket / ping，不注入假的。
 *
 * 这一组是为了锁住一个真机上抓不到的坑：Windows 上 Node 的 unix socket 是命名管道，
 * 而 `statSync()` 对命名管道**直接抛 EBUSY**（2026-10-20 实测）。
 * 按「stat 失败就当没有」写，开发机上一律探不到 —— CI 的接线测试就是这么红的。
 */
describe('真 socket 文件（用默认的 isSocket / ping，不注入）', () => {
  /** 起一个按 Docker 样子答 `/_ping` 的真 socket（Windows 上就是命名管道）。 */
  async function serve(): Promise<{ path: string; close: () => Promise<void> }> {
    const path =
      process.platform === 'win32'
        ? `\\\\.\\pipe\\kura-sock-test-${randomBytes(6).toString('hex')}`
        : join(tmpdir(), `kura-sock-test-${randomBytes(6).toString('hex')}.sock`)
    const server = net.createServer((socket) => {
      // 每条连接只答一次；`destroyed` 挡住「同一个 socket 上又收到一块数据」的重复应答
      // （不挡会抛 ERR_STREAM_WRITE_AFTER_END，而且是被测代码连了多次才暴露出来的）
      let answered = false
      socket.on('data', () => {
        if (answered || socket.destroyed) return
        answered = true
        socket.end('HTTP/1.1 200 OK\r\ncontent-type: text/plain\r\ncontent-length: 2\r\n\r\nOK')
      })
      socket.on('error', () => {})
    })
    await new Promise<void>((resolve) => server.listen(path, resolve))
    return { path, close: () => new Promise<void>((resolve) => server.close(() => resolve())) }
  }

  it('能找到真实 socket，并且**重复找也还在**（Windows 命名管道只能探一次）', async () => {
    const { path, close } = await serve()
    try {
      // 连找三次。第一版实现在 Windows 上只有第一次成功：探过之后同一个路径的
      // existsSync 永久变 false（见 socket.ts 那段注释），于是第二次起全是 undefined。
      // 真实场景里找 socket 会被调多次（每次重连都走一遍），所以这条必须成立。
      for (let i = 0; i < 3; i++) {
        const found = await findDockerSocket({ env: path })
        expect(found, `第 ${i + 1} 次没找到`).toMatchObject({ path, source: 'env' })
      }
    } finally {
      await close()
    }
  })

  it('路径不存在时干净地返回 undefined（不靠 existsSync 也不会误判）', async () => {
    const missing =
      process.platform === 'win32' ? `\\\\.\\pipe\\kura-nope-${randomBytes(6).toString('hex')}` : join(tmpdir(), `kura-nope-${randomBytes(6).toString('hex')}.sock`)
    expect(await findDockerSocket({ env: missing })).toBeUndefined()
  })
})
