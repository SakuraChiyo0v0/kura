import { EventEmitter } from 'node:events'
import type { ChildProcess } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ModuleManager, mountArgs, mountDefaults, mountTarget, rcloneRelease, validateDrive, validateFolder } from './modules.js'

describe('rclone 挂载参数', () => {
  it('连接串形态、盘符、缓存目录、只读', () => {
    const args = mountArgs({ ...mountDefaults, drive: 'n:', readOnly: true }, 'http://127.0.0.1:18006/', 'C:\\cache')
    expect(args.slice(0, 3)).toEqual(['mount', ":webdav,url='http://127.0.0.1:18006',vendor=other:/", 'N:'])
    expect(args).toContain('--read-only')
    expect(args[args.indexOf('--cache-dir') + 1]).toBe('C:\\cache')
    expect(args[args.indexOf('--vfs-cache-mode') + 1]).toBe('writes')
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

  const manager = () =>
    new ModuleManager({
      dir,
      davUrl: () => 'http://127.0.0.1:18006/',
      spawnMount: (exe, args) => {
        const child = fakeChild()
        spawned.push({ exe, args, child })
        return child
      },
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
})
