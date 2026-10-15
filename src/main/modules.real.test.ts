import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { access, readdir, readFile, writeFile } from 'node:fs/promises'
import { afterAll, describe, expect, it } from 'vitest'
import { DavServer, davServerDefaults } from '../core/dav-server.js'
import { FakeWebdav } from '../core/testing/fake-webdav.js'
import { ModuleManager, mountDefaults } from './modules.js'

/**
 * 真机测试：真的去 rclone 官网下载、校验、解压，再用 WinFsp 挂一个真盘符，读写后卸载。
 * 会联网、会短暂占用一个盘符，所以默认跳过：
 *
 *   KURA_REAL_RCLONE=1 npx vitest run src/main/modules.real.test.ts
 *
 * 全程只用临时目录；挂的是假 NAS（本地内存 WebDAV），经过真实的「本机 WebDAV」范围裁剪。
 */
const enabled = process.env.KURA_REAL_RCLONE === '1'

const exists = (path: string) => access(path).then(() => true, () => false)

function freeDrive(): string {
  for (const letter of 'RSTUVWXYZ') if (!existsSync(`${letter}:\\`)) return `${letter}:`
  throw new Error('没有空闲盘符')
}

/**
 * 找一个空的临时目录当**父目录**。设置里存的就是父目录，挂载点（父目录下的 KuraNAS）
 * 由 Kura 拼、rclone 建 —— rclone 要求挂载点本身不存在，所以不能直接把父目录当挂载点。
 */
function folderParent(dir: string): string {
  const parent = join(dir, 'mount-parent')
  mkdirSync(parent, { recursive: true })
  return parent
}

describe.runIf(enabled)('rclone 模块（真机）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kura-real-rclone-'))
  let dav: FakeWebdav | undefined
  let server: DavServer | undefined
  let manager: ModuleManager | undefined

  afterAll(async () => {
    await manager?.unmount()
    await server?.close()
    await dav?.stop()
    rmSync(dir, { recursive: true, force: true })
  })

  /** 起假 NAS + 带范围裁剪的本机 WebDAV。多条用例各自调用，互不依赖彼此留下的状态。 */
  async function startNas() {
    await server?.close()
    await dav?.stop()
    dav = await new FakeWebdav().start()
    dav.file('/volume1/docs/readme.txt', 'hello from fake nas').file('/volume1/private/secret.txt', 'secret')
    server = new DavServer({ settings: { ...davServerDefaults, port: 0, include: ['/volume1/docs'], exclude: [] }, upstream: async () => dav!.url })
    await server.start()
  }

  it('下载并安装固定版本，SHA256 校验通过', async () => {
    manager = new ModuleManager({ dir, davUrl: () => server!.status().url })
    await manager.installRclone()
    const status = manager.status()
    expect(status.rclone).toMatchObject({ state: 'ready', source: 'kura', version: 'v1.75.2' })
    expect(readdirSync(dir)).toEqual(expect.arrayContaining(['rclone'])) // 没留下 .part / staging
    expect(readdirSync(dir).some((n) => n.includes('staging') || n.endsWith('.part'))).toBe(false)
  }, 180_000)

  it('挂载为盘符：只看得到放行目录，能读能写，卸载后盘符消失', async () => {
    expect(manager!.status().winfsp.installed).toBe(true)
    await startNas()

    const drive = freeDrive()
    manager!.saveMountSettings({ ...mountDefaults, mode: 'disk', drive, volumeName: 'Kura Test' })
    await manager!.mount()
    expect(manager!.status().mount).toMatchObject({ state: 'mounted', target: drive })

    // 必须用异步 fs：假 NAS 和本机 WebDAV 就跑在这个进程里，同步调用会卡住事件循环，
    // 谁也答不了 rclone 的请求 → 互相等死（实测 10 分钟后 ECANCELED）
    expect(await readdir(`${drive}\\`)).toEqual(['volume1'])
    expect(await readdir(`${drive}\\volume1`)).toEqual(['docs'])
    expect(await readFile(`${drive}\\volume1\\docs\\readme.txt`, 'utf8')).toBe('hello from fake nas')
    await writeFile(`${drive}\\volume1\\docs\\from-windows.txt`, '写进去了')
    // vfs writes 缓存：关闭文件后异步上传，等它落到 NAS
    for (let i = 0; i < 50 && !dav!.nodes.has('/volume1/docs/from-windows.txt'); i++) await new Promise((r) => setTimeout(r, 200))
    expect(dav!.nodes.get('/volume1/docs/from-windows.txt')?.data.toString()).toBe('写进去了')
    expect(await exists(`${drive}\\volume1\\private`)).toBe(false)

    await manager!.unmount()
    for (let i = 0; i < 25 && (await exists(`${drive}\\`)); i++) await new Promise((r) => setTimeout(r, 200))
    expect(await exists(`${drive}\\`)).toBe(false)
  }, 120_000)

  it('挂到目录：不占盘符，卸载后挂载点消失', async () => {
    expect(manager!.status().winfsp.installed).toBe(true)
    await startNas()

    const parent = folderParent(dir)
    const target = join(parent, 'KuraNAS')
    manager!.saveMountSettings({ ...mountDefaults, mode: 'folder', folder: parent })
    await manager!.mount()
    expect(manager!.status().mount).toMatchObject({ state: 'mounted', target })
    expect(await readFile(`${target}\\volume1\\docs\\readme.txt`, 'utf8')).toBe('hello from fake nas')

    await manager!.unmount()
    for (let i = 0; i < 25 && (await exists(target)); i++) await new Promise((r) => setTimeout(r, 200))
    expect(await exists(target)).toBe(false)
  }, 120_000)
})
