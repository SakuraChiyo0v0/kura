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
