import { existsSync, statSync } from 'node:fs'
import net from 'node:net'
import { randomBytes } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { findDockerSocket, socketCandidates } from '../src/docker/socket.js'

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
      log: (message) => lines.push(message),
    })
    expect(lines.length).toBe(4)
    expect(lines[0]).toContain('没应答')
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
