import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { findRemoteRoots, repairCache, scanCache, tagRegionLength, type CacheDoctorOptions } from './cache-doctor.js'
import type { DavClient } from '../core/dav-client.js'

/**
 * 假 WebDAV：内存里放一份「远端」文件，只为体检服务。
 * 只实现体检用到的三个方法，别的访问直接抛错（避免测试里悄悄用到没 mock 的东西）。
 */
interface FakeFile {
  data: Buffer
  modified: number
}

function fakeDav(files: Map<string, FakeFile>): DavClient {
  return {
    async stat(path: string) {
      const file = files.get(path)
      if (!file) return undefined
      return { path, name: path.split('/').pop() ?? '', isDir: false, size: file.data.length, modified: file.modified, contentType: 'audio/mpeg' }
    },
    async readRange(path: string, start: number, end?: number, options: { maxBytes?: number } = {}) {
      const file = files.get(path)
      if (!file) throw new Error(`404 ${path}`)
      const stop = end === undefined ? file.data.length - 1 : Math.min(end, file.data.length - 1)
      const cap = options.maxBytes ?? Number.POSITIVE_INFINITY
      return file.data.subarray(start, Math.min(stop + 1, start + cap))
    },
  } as unknown as DavClient
}

/**
 * 造一个带 ID3 头的「音频」：头部 tagBody 决定标签内容，音频段用 audioFill 填充。
 *
 * **音频段必须大于 HEAD_BYTES（400KB）**，否则「头」就覆盖了整个文件，
 * 「末尾那一段一不一致」永远为真，音频真变了也判不出来。
 * 第一版用了 200KB，`头和音频都变了` 那条因此误判成 tag —— 测试数据不真实，
 * 不是代码错。真实 mp3 都是几 MB，这里按真实形状造。
 */
function makeAudio(title: string, audioFill = 0x41, audioLen = 600_000): Buffer {
  const frame = Buffer.concat([Buffer.from('TIT2', 'latin1'), Buffer.from([0, 0, 0, title.length + 1]), Buffer.from([3]), Buffer.from(title, 'utf8')])
  // padding 补到固定长度，模拟「大小不变的标签替换」
  const padding = Buffer.alloc(2048)
  const tagBody = Buffer.concat([frame, padding])
  const header = Buffer.from([0x49, 0x44, 0x33, 0x04, 0x00, 0x00, (tagBody.length >> 21) & 0x7f, (tagBody.length >> 14) & 0x7f, (tagBody.length >> 7) & 0x7f, tagBody.length & 0x7f])
  return Buffer.concat([header, tagBody, Buffer.alloc(audioLen, audioFill)])
}

describe('缓存体检', () => {
  let dir: string
  let cacheDir: string
  let vfsRoot: string
  let metaRoot: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'kura-cache-doctor-'))
    cacheDir = join(dir, 'rclone-cache')
    // rclone 的实际布局：vfs/<remote>/<NAS 上的路径>。
    // 相对路径的基准是 remote 根（`：webdav{xxx}`），所以这里只建到 remote 那一层，
    // 下面的 `volume1/音乐` 由各用例的 write() 现建 —— 与线上 `findRemoteRoots` 拿到的根一致。
    vfsRoot = join(cacheDir, 'vfs', '：webdav{test123}')
    metaRoot = join(cacheDir, 'vfsMeta', '：webdav{test123}')
    mkdirSync(vfsRoot, { recursive: true })
    mkdirSync(metaRoot, { recursive: true })
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  const write = (rel: string, data: Buffer): void => {
    const dataFile = join(vfsRoot, rel)
    const metaFile = join(metaRoot, rel)
    mkdirSync(join(dataFile, '..'), { recursive: true })
    mkdirSync(join(metaFile, '..'), { recursive: true })
    writeFileSync(dataFile, data)
    writeFileSync(metaFile, JSON.stringify({ ModTime: '2020-01-01T00:00:00.000Z', Size: data.length, Fingerprint: String(data.length), Dirty: false }, null, '\t'))
  }
  // 相对路径是相对 remote 根（`vfs/：webdav{test}`）的，也就是从 `volume1/` 起。
  // 远端 DAV 路径前面补一个 `/` 就对了 —— 与线上一致（`volume1/a.mp3` → `/volume1/a.mp3`）。
  const options = (files: Map<string, FakeFile>): CacheDoctorOptions => ({
    cacheDir,
    dav: fakeDav(files),
    toDavPath: (rel) => `/${rel}`,
  })

  it('找出 remotes：vfs 与 vfsMeta 两侧都要认，且配对', () => {
    const roots = findRemoteRoots(cacheDir)
    expect(roots).toHaveLength(1)
    expect(roots[0]!.vfs).toContain('vfs')
    expect(roots[0]!.vfsMeta).toContain('vfsMeta')
    expect(roots[0]!.vfs).not.toContain('vfsMeta')
  })

  it('内容一致的文件判成 intact，不算过期', async () => {
    const audio = makeAudio('年轮')
    write('volume1/a.mp3', audio)
    const scan = await scanCache(options(new Map([['/volume1/a.mp3', { data: audio, modified: 1_700_000_000_000 }]])))
    expect(scan.intact).toBe(1)
    expect(scan.stale).toHaveLength(0)
    expect(scan.orphans).toHaveLength(0)
  })

  it('只换了标签（大小相同）判成 tag，而不是 intact —— 这正是挂载盘看到旧标签的成因', async () => {
    // 关键：两个标题**字节长度相同**，文件总大小才一样；长短不同的话这个用例
    // 在「大小变了」那一步就落到 audio，测不到这里
    const local = makeAudio('年轮')
    const remote = makeAudio('花海')
    expect(Buffer.byteLength('年轮', 'utf8')).toBe(Buffer.byteLength('花海', 'utf8'))
    expect(remote.length).toBe(local.length)

    write('volume1/a.mp3', local)
    const scan = await scanCache(options(new Map([['/volume1/a.mp3', { data: remote, modified: 1_700_000_000_000 }]])))
    expect(scan.stale).toHaveLength(1)
    expect(scan.stale[0]!.kind).toBe('tag')
    // 只补头，不该算整份
    expect(scan.bytes.needDownload).toBeLessThan(scan.bytes.fullRedownload)
  })

  it('大小变了直接判成 audio（连头都不用比）', async () => {
    const local = makeAudio('年轮', 0x41, 200_000)
    const remote = makeAudio('年轮', 0x41, 300_000)
    write('volume1/a.mp3', local)
    const scan = await scanCache(options(new Map([['/volume1/a.mp3', { data: remote, modified: 1 }]])))
    expect(scan.stale[0]!.kind).toBe('audio')
    expect(scan.stale[0]!.reason).toContain('大小')
  })

  it('头和音频都变了必须判成 audio —— 只比头会把它误判成 tag，补完是个坏文件', async () => {
    // 标题等长（头不同）+ 音频内容不同（尾不同）
    const local = makeAudio('年轮', 0x41)
    const remote = makeAudio('花海', 0x42)
    expect(remote.length).toBe(local.length)
    write('volume1/a.mp3', local)
    const scan = await scanCache(options(new Map([['/volume1/a.mp3', { data: remote, modified: 1 }]])))
    expect(scan.stale[0]!.kind).toBe('audio')
  })

  it('远端已不存在 → 归到孤儿，不混进过期', async () => {
    write('volume1/gone.mp3', makeAudio('走了'))
    const scan = await scanCache(options(new Map()))
    expect(scan.orphans).toHaveLength(1)
    expect(scan.orphans[0]!.name).toBe('gone.mp3')
    expect(scan.stale).toHaveLength(0)
    expect(scan.bytes.orphans).toBeGreaterThan(0)
  })

  it('补标签：写完本地内容和远端一致，音频段一个字节不动', async () => {
    const local = makeAudio('年轮', 0x41)
    const remote = makeAudio('花海', 0x41)
    write('volume1/a.mp3', local)
    const files = new Map([['/volume1/a.mp3', { data: remote, modified: 1_700_000_000_000 }]])
    const opts = options(files)

    const scan = await scanCache(opts)
    const repair = await repairCache(scan, opts)

    expect(repair.retagged).toBe(1)
    expect(repair.failed).toHaveLength(0)
    const after = readFileSync(join(vfsRoot, 'volume1', 'a.mp3'))
    expect(after.equals(remote)).toBe(true)
    // 只下载了标签区，没有整份拉
    expect(repair.downloaded).toBeLessThan(remote.length / 2)
  })

  it('补标签后 vfsMeta 的 ModTime 跟上远端（否则 rclone 仍认为没同步）', async () => {
    const local = makeAudio('年轮', 0x41)
    const remote = makeAudio('花海', 0x41)
    write('volume1/a.mp3', local)
    const modified = 1_700_000_000_000
    const opts = options(new Map([['/volume1/a.mp3', { data: remote, modified }]]))
    await repairCache(await scanCache(opts), opts)

    const meta = JSON.parse(readFileSync(join(metaRoot, 'volume1', 'a.mp3'), 'utf8')) as { ModTime: string }
    expect(new Date(meta.ModTime).getTime()).toBe(modified)
  })

  it('整份重下：音频变了就换掉整个文件', async () => {
    const local = makeAudio('年轮', 0x41)
    const remote = makeAudio('年轮', 0x42)
    write('volume1/a.mp3', local)
    const opts = options(new Map([['/volume1/a.mp3', { data: remote, modified: 1 }]]))
    const repair = await repairCache(await scanCache(opts), opts)

    expect(repair.redownloaded).toBe(1)
    expect(readFileSync(join(vfsRoot, 'volume1', 'a.mp3')).equals(remote)).toBe(true)
  })

  it('删孤儿：数据与元数据一起删', async () => {
    write('volume1/gone.mp3', makeAudio('走了'))
    const opts = options(new Map())
    const repair = await repairCache(await scanCache(opts), opts)
    expect(repair.removed).toBe(1)
    expect(() => readFileSync(join(vfsRoot, 'volume1', 'gone.mp3'))).toThrow()
    expect(() => readFileSync(join(metaRoot, 'volume1', 'gone.mp3'))).toThrow()
  })

  it('识别 ID3 标签区长度；没 ID3 的返回 0（调用方据此退回整份重下）', () => {
    expect(tagRegionLength(makeAudio('年轮'))).toBeGreaterThan(10)
    expect(tagRegionLength(Buffer.from('fLaC0000'))).toBe(0)
    expect(tagRegionLength(Buffer.alloc(4))).toBe(0)
  })
})
