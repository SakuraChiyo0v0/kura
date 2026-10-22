import { EventEmitter } from 'node:events'
import type { ChildProcess } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { clampCacheMaxGb, ModuleManager, clearNetworkHistory, mountArgs, mountDefaults, mountTarget, rcloneRelease, validateDrive, validateFolder } from './modules.js'

describe('rclone 挂载参数', () => {
  it('连接串形态、盘符、缓存目录、只读', () => {
    const args = mountArgs({ ...mountDefaults, drive: 'n:', readOnly: true }, 'http://127.0.0.1:18006/', 'C:\\cache')
    expect(args.slice(0, 3)).toEqual(['mount', ":webdav,url='http://127.0.0.1:18006',vendor=other:/", 'N:'])
    expect(args).toContain('--read-only')
    expect(args[args.indexOf('--cache-dir') + 1]).toBe('C:\\cache')
    expect(args[args.indexOf('--vfs-cache-mode') + 1]).toBe('writes')
  })

  it('缓存有容量上限，且用用户填的值（full 档连读过的都留，没上限就只增不减）', () => {
    const args = mountArgs({ ...mountDefaults, cacheMaxGb: 20 }, 'http://127.0.0.1:18006/', 'C:\cache')
    expect(args[args.indexOf('--vfs-cache-max-size') + 1]).toBe('20G')
    const custom = mountArgs({ ...mountDefaults, cacheMaxGb: 50 }, 'http://127.0.0.1:18006/', 'C:\cache')
    expect(custom[custom.indexOf('--vfs-cache-max-size') + 1]).toBe('50G')
  })

  it('上限填 0 = 不限制：不给 --vfs-cache-max-size', () => {
    const args = mountArgs({ ...mountDefaults, cacheMaxGb: 0 }, 'http://127.0.0.1:18006/', 'C:\cache')
    expect(args).not.toContain('--vfs-cache-max-size')
  })

  it('缓存关掉时不带上限参数（给了也没意义）', () => {
    const args = mountArgs({ ...mountDefaults, cacheMode: 'off', cacheMaxGb: 20 }, 'http://127.0.0.1:18006/', 'C:\cache')
    expect(args).not.toContain('--vfs-cache-max-size')
  })

  it('脏值被钳回来：负数 → 0、超大 → 1024、非数字 → 默认', () => {
    expect(clampCacheMaxGb(-5)).toBe(0)
    expect(clampCacheMaxGb(99999)).toBe(1024)
    expect(clampCacheMaxGb('abc')).toBe(mountDefaults.cacheMaxGb)
    expect(clampCacheMaxGb(undefined)).toBe(mountDefaults.cacheMaxGb)
    expect(clampCacheMaxGb(20.7)).toBe(20)
  })

  it('不设 max-age —— 按时间过期会让听过的歌重新从 NAS 拉', () => {
    const args = mountArgs(mountDefaults, 'http://127.0.0.1:18006/', 'C:\cache')
    expect(args).not.toContain('--vfs-cache-max-age')
  })

  it('只有网络模式加 --network-mode；固定磁盘与目录挂载都不加', () => {
    const dav = 'http://127.0.0.1:18006/'
    expect(mountArgs({ ...mountDefaults, mode: 'network' }, dav, 'C:\\cache')).toContain('--network-mode')
    expect(mountArgs({ ...mountDefaults, mode: 'disk' }, dav, 'C:\\cache')).not.toContain('--network-mode')
    expect(mountArgs({ ...mountDefaults, mode: 'folder', folder: 'D:\\' }, dav, 'C:\\cache')).not.toContain('--network-mode')
  })

  it('目录模式：设置里存父目录，挂载点是它下面的 KuraNAS', () => {
    const dav = 'http://127.0.0.1:18006/'
    const folder = mountArgs({ ...mountDefaults, mode: 'folder', drive: 'Q:', folder: 'd:\\' }, dav, 'C:\\cache')
    expect(folder[2]).toBe('D:\\KuraNAS')
    expect(folder).not.toContain('Q:')
    expect(mountTarget({ ...mountDefaults, mode: 'folder', folder: 'd:\\' })).toBe('D:\\KuraNAS')
    expect(mountTarget({ ...mountDefaults, mode: 'disk', drive: 'q:' })).toBe('Q:')
    expect(mountTarget({ ...mountDefaults, mode: 'network', drive: 'q:' })).toBe('Q:')
  })

  it('目录模式没选父目录时不能挂（但可以存）', () => {
    expect(() => mountTarget({ ...mountDefaults, mode: 'folder', folder: '' })).toThrow(/还没有选/)
    expect(() => mountTarget({ ...mountDefaults, mode: 'folder', folder: '  ' })).toThrow(/还没有选/)
  })

  it('盘符只认 D: 到 Z:', () => {
    expect(validateDrive(' x:\\ ')).toBe('X:')
    expect(() => validateDrive('C:')).toThrow(/盘符/)
    expect(() => validateDrive('C:\\Users')).toThrow(/盘符/)
  })

  it('父目录要绝对路径、不能含 ..；留空是「还没选」不是错', () => {
    expect(validateFolder(' d:\\KuraNAS\\ ')).toBe('D:\\KuraNAS')
    expect(validateFolder('d:\\')).toBe('D:') // 盘根：去掉末尾分隔符就是 D:
    expect(validateFolder('')).toBe('')
    expect(validateFolder('   ')).toBe('')
    expect(() => validateFolder('KuraNAS')).toThrow(/绝对路径/)
    expect(() => validateFolder('D:sub')).toThrow(/绝对路径/) // 盘符相对，不是绝对路径
    expect(() => validateFolder('D:\\a\\..\\b')).toThrow(/\.\./)
  })

  it('固定版本的下载地址与校验值成对', () => {
    expect(rcloneRelease.url).toContain(rcloneRelease.version)
    expect(rcloneRelease.url.startsWith('https://downloads.rclone.org/')).toBe(true)
    expect(rcloneRelease.sha256).toMatch(/^[0-9a-f]{64}$/)
  })
})

/** 假的 rclone 进程：kill('SIGINT') 时像真的一样退出。 */
function fakeChild(): ChildProcess {
  const child = new EventEmitter() as ChildProcess
  Object.assign(child, {
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    kill: () => {
      setTimeout(() => child.emit('exit', 0), 5)
      return true
    },
  })
  return child
}

describe('ModuleManager', () => {
  let dir: string
  let spawned: Array<{ exe: string; args: string[]; child: ChildProcess }>
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'kura-modules-'))
    spawned = []
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  const manager = (patch: Partial<ConstructorParameters<typeof ModuleManager>[0]> = {}) =>
    new ModuleManager({
      dir,
      davUrl: () => 'http://127.0.0.1:18006/',
      spawnMount: (exe, args) => {
        const child = fakeChild()
        spawned.push({ exe, args, child })
        return child
      },
      ...patch,
    })

  /** 放一个假的 rclone.exe 进 Kura 的模块目录（detect 只看文件在不在）。 */
  const installFake = () => {
    mkdirSync(join(dir, 'rclone'), { recursive: true })
    writeFileSync(join(dir, 'rclone', 'rclone.exe'), '')
  }

  it('没装 rclone 时不能挂载', async () => {
    const m = manager()
    await m.detect()
    if (m.status().rclone.source === 'system') return // 本机 PATH 里恰好有 rclone：这条不适用
    expect(m.status().rclone.state).toBe('missing')
    await expect(m.mount()).rejects.toThrow(/rclone/)
  })

  it('挂载 → 卸载：用设置里的盘符，卸载后状态回到未挂载', async () => {
    installFake()
    const m = manager()
    await m.detect()
    expect(m.status().rclone).toMatchObject({ state: 'ready', source: 'kura' })
    m.saveMountSettings({ ...mountDefaults, drive: 'Q:' })
    await m.mount()
    expect(m.status().mount).toMatchObject({ state: 'mounted', target: 'Q:' })
    expect(spawned[0]!.args).toContain('Q:')
    // 缓存上限要真的传给 rclone（不是只写在 mountArgs 里）
    expect(spawned[0]!.args[spawned[0]!.args.indexOf('--vfs-cache-max-size') + 1]).toBe('20G')
    await m.unmount()
    expect(m.status().mount.state).toBe('stopped')
  })

  it('目录模式挂到目录上（不占盘符）', async () => {
    installFake()
    const m = manager()
    await m.detect()
    // 设置里存父目录；挂载点是 Kura 拼的
    m.saveMountSettings({ ...mountDefaults, mode: 'folder', drive: 'Q:', folder: 'D:\\' })
    await m.mount()
    expect(m.status().mount).toMatchObject({ state: 'mounted', target: 'D:\\KuraNAS' })
    expect(spawned[0]!.args[2]).toBe('D:\\KuraNAS')
    expect(spawned[0]!.args).not.toContain('--network-mode')
  })

  it('目录模式：父目录不合法就不给存；留空能存但挂不了', async () => {
    installFake()
    const m = manager()
    await m.detect()
    expect(() => m.saveMountSettings({ ...mountDefaults, mode: 'folder', folder: 'relative\\path' })).toThrow(/绝对路径/)
    // 还没选目录：存得下去（不是「保存失败」），但挂载要拦
    m.saveMountSettings({ ...mountDefaults, mode: 'folder', folder: '' })
    expect(m.mountSettings()).toMatchObject({ mode: 'folder', folder: '' })
    await expect(m.mount()).rejects.toThrow(/还没有选/)
    // 非目录模式允许 folder 留空
    m.saveMountSettings({ ...mountDefaults, mode: 'disk', folder: '' })
    expect(m.mountSettings()).toMatchObject({ mode: 'disk', folder: '' })
  })

  it('rclone 意外退出：报错并带上它最后一行输出', async () => {
    installFake()
    const m = manager()
    await m.detect()
    await m.mount()
    const child = spawned[0]!.child
    child.stderr!.emit('data', Buffer.from('ERROR : mount failed: cannot find winfsp\n'))
    child.emit('exit', 1)
    expect(m.status().mount).toMatchObject({ state: 'error', error: expect.stringContaining('cannot find winfsp') })
  })

  it('挂载设置落盘并校验', () => {
    const m = manager()
    expect(() => m.saveMountSettings({ ...mountDefaults, drive: 'A:' })).toThrow(/盘符/)
    m.saveMountSettings({ ...mountDefaults, drive: 'k:', volumeName: '  ', autoMount: true })
    expect(manager().mountSettings()).toMatchObject({ drive: 'K:', volumeName: mountDefaults.volumeName, autoMount: true })
  })

  it('卸载只删 Kura 自己下载的那份', async () => {
    installFake()
    const m = manager()
    await m.detect()
    await m.uninstallRclone()
    expect(m.status().rclone.source).not.toBe('kura')
  })

  it('网络模式卸载：清掉网络位置历史，不报残留', async () => {
    installFake()
    const cleared: string[] = []
    const m = manager({ clearNetworkHistory: async (v) => (cleared.push(v), '') })
    await m.detect()
    m.saveMountSettings({ ...mountDefaults, mode: 'network', volumeName: 'NAS-SHARE' })
    await m.mount()
    await m.unmount()
    expect(cleared).toEqual(['NAS-SHARE'])
    expect(m.status().mount).toMatchObject({ state: 'stopped', error: '' })
  })

  it('网络位置历史清不掉时：状态带出错原因，别静默放过', async () => {
    installFake()
    const m = manager({ clearNetworkHistory: async () => 'reg delete 失败' })
    await m.detect()
    m.saveMountSettings({ ...mountDefaults, mode: 'network', volumeName: 'NAS-SHARE' })
    await m.mount()
    await m.unmount()
    // 卸载本身是成功的（dist 已断开），但残留这事必须说出来
    expect(m.status().mount.state).toBe('stopped')
    expect(m.status().mount.error).toContain('NAS-SHARE')
    expect(m.status().mount.error).toContain('残留')
  })

  it('Explorer 稍后才写键：守着窗口重试，别把「此刻不存在」当清干净', async () => {
    // 实测：这条键是卸载时才由 Explorer 写的（命令行挂载在 rclone 退出后 0.06~0.11s）。
    // 卸载后立刻删一次，删的是个空；旧逻辑查到「键不存在」就 return 成功，
    // 恰好绕过整个窗口、残留一直留着。
    //
    // 关键：写键要由**独立计时器**驱动，不能挂在被测代码的 sleep 上 ——
    // 否则旧逻辑提前 return、sleep 压根不执行，残留就永远不会出现，测试假绿。
    let present = false
    const writer = setTimeout(() => { present = true }, 150)
    const registry = {
      delete: () => {
        if (!present) throw new Error('reg delete: 系统找不到指定的注册表项') // 键还没被写出来
        present = false
      },
      exists: () => present,
      sleep: (ms: number) => new Promise<void>((r) => setTimeout(r, ms)),
    }
    try {
      const failed = await clearNetworkHistory('NAS-SHARE', 600, registry)
      // 等窗口彻底过去再断言：旧逻辑此刻已经 return 了，而键会在这之后才被写出来
      await new Promise((r) => setTimeout(r, 300))
      expect(failed, '守满窗口后应当删掉，返回成功').toBe('')
      expect(present, '窗口内写进来的键应当被删掉').toBe(false)
    } finally {
      clearTimeout(writer)
    }
  })

  it('固定磁盘模式不碰网络位置历史（那是网络模式独有的）', async () => {
    installFake()
    const cleared: string[] = []
    const m = manager({ clearNetworkHistory: async (v) => (cleared.push(v), '') })
    await m.detect()
    m.saveMountSettings({ ...mountDefaults, mode: 'disk' })
    await m.mount()
    await m.unmount()
    expect(cleared).toEqual([])
  })

  it('挂载进程被外部结束：对账后不再说「已挂载」', async () => {
    installFake()
    const m = manager()
    await m.detect()
    await m.mount()
    expect(m.status().mount.state).toBe('mounted')
    // 模拟进程被任务管理器结束：child 没了，但 mountState 还停在 mounted
    ;(m as unknown as { child: undefined }).child = undefined
    await m.reconcile()
    expect(m.status().mount).toMatchObject({ state: 'error', error: expect.stringContaining('不在运行') })
  })

  it('挂载点访问不到了：对账后不再说「已挂载」', async () => {
    installFake()
    const m = manager({ probeMountPoint: async () => false })
    await m.detect()
    m.saveMountSettings({ ...mountDefaults, drive: 'Q:' })
    await m.mount()
    expect(m.status().mount.state).toBe('mounted')
    await m.reconcile()
    expect(m.status().mount).toMatchObject({ state: 'error', error: expect.stringContaining('Q:') })
  })

  it('一切都好时对账不改状态（别把正常的挂载误判掉）', async () => {
    installFake()
    const m = manager({ probeMountPoint: async () => true })
    await m.detect()
    await m.mount()
    await m.reconcile()
    expect(m.status().mount.state).toBe('mounted')
  })
})
