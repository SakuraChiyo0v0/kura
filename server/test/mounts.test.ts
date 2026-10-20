import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { hostSide, isMounted, resolveProjectRoots, statKey, toOriginalPath } from '../src/docker/mounts.js'

/**
 * 「项目目录真的按原路径挂进来了吗」的判定。
 *
 * 这里**不用真的跨挂载**（Windows 开发机上做不了），而是喂一对假的 dev:ino ——
 * 判定的全部依据就是这两个号。真机上的配对（同一个目录 inode 相同）见
 * `docs/归档/` 里那次的实测记录。
 */

/** 假文件系统：路径 → 身份。没登记的一律不存在。 */
function fakeFs(entries: Record<string, string>): (path: string) => string | undefined {
  const normalize = (p: string): string => p.replace(/\/+/g, '/').replace(/\/$/, '') || '/'
  const map = new Map(Object.entries(entries).map(([k, v]) => [normalize(k), v]))
  return (path) => map.get(normalize(path))
}

describe('isMounted：比 inode，不猜字符串', () => {
  it('同一个目录（两侧 dev:ino 相同）= 挂进来了', () => {
    const key = fakeFs({
      '/host': '1:1',
      '/volume1/docker': '64768:137101313',
      '/host/volume1/docker': '64768:137101313',
    })
    expect(isMounted('/volume1/docker', { key })).toBe(true)
  })

  it('容器里自己造出来的同名目录（ino 不同）= 没挂进来', () => {
    // 这正是要挡的情况：路径看着对，实际是容器的 overlay 层
    const key = fakeFs({
      '/host': '1:1',
      '/volume1/docker': '99:7',
      '/host/volume1/docker': '64768:137101313',
    })
    expect(isMounted('/volume1/docker', { key })).toBe(false)
  })

  it('原路径不存在、只在 /host 下能看到 = 没挂进来', () => {
    // 真机上 /volume1/@appstore 就是这样（compose 没挂它）
    const key = fakeFs({
      '/host': '1:1',
      '/host/volume1/@appstore': '64768:209453057',
    })
    expect(isMounted('/volume1/@appstore', { key })).toBe(false)
  })

  it('两侧都不存在 = 没挂进来（不是「无从判断就放行」）', () => {
    const key = fakeFs({ '/host': '1:1' })
    expect(isMounted('/volume1/docker', { key })).toBe(false)
  })

  it('宿主根不在（不在容器里 / 单测临时目录）：退回「存在就算可达」', () => {
    const key = fakeFs({ '/volume1/docker': '64768:137101313' })
    expect(isMounted('/volume1/docker', { key })).toBe(true)
    const missing = fakeFs({})
    expect(isMounted('/volume1/docker', { key: missing })).toBe(false)
  })
})

describe('resolveProjectRoots：不可达时还能看见', () => {
  it('挂对了：扫原路径，没有提示', () => {
    const key = fakeFs({
      '/host': '1:1',
      '/volume1/docker': '64768:1',
      '/host/volume1/docker': '64768:1',
    })
    expect(resolveProjectRoots('/volume1/docker', { key })).toEqual({ projectRoot: '/volume1/docker', scanRoot: '/volume1/docker', reachable: true, hint: '' })
  })

  it('没挂对但 /host 下看得到：退到 /host 去扫，并给出补救建议', () => {
    const key = fakeFs({
      '/host': '1:1',
      '/host/volume1/docker': '64768:1',
    })
    const roots = resolveProjectRoots('/volume1/docker', { key })
    expect(roots).toMatchObject({ projectRoot: '/volume1/docker', scanRoot: '/host/volume1/docker', reachable: false })
    // 建议里要点出两件实事：现在从哪看得到、compose 该加哪一行
    expect(roots.hint).toContain('/host/volume1/docker')
    expect(roots.hint).toContain('/volume1/docker:/volume1/docker')
  })

  it('哪儿都没有：说清是「不存在或没挂」，不编原因', () => {
    const key = fakeFs({ '/host': '1:1' })
    const roots = resolveProjectRoots('/volume1/docker', { key })
    expect(roots.reachable).toBe(false)
    expect(roots.scanRoot).toBe('/volume1/docker')
    expect(roots.hint).toContain('不存在')
  })
})

describe('toOriginalPath：报给界面的永远是宿主原路径', () => {
  it('扫的是 /host 下那份时换回原路径', () => {
    const roots = { projectRoot: '/volume1/docker', scanRoot: '/host/volume1/docker', reachable: false, hint: '' }
    expect(toOriginalPath('/host/volume1/docker/openlist', roots)).toBe('/volume1/docker/openlist')
    expect(toOriginalPath('/host/volume1/docker/openlist/docker-compose.yaml', roots)).toBe('/volume1/docker/openlist/docker-compose.yaml')
  })

  it('扫的就是原路径时原样返回', () => {
    const roots = { projectRoot: '/volume1/docker', scanRoot: '/volume1/docker', reachable: true, hint: '' }
    expect(toOriginalPath('/volume1/docker/openlist', roots)).toBe('/volume1/docker/openlist')
  })

  it('不在这个根下面的（理论上不会出现）不硬改', () => {
    const roots = { projectRoot: '/volume1/docker', scanRoot: '/host/volume1/docker', reachable: false, hint: '' }
    expect(toOriginalPath('/tmp/envtest', roots)).toBe('/tmp/envtest')
  })
})

describe('statKey / hostSide：真文件', () => {
  let dir = ''
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'kura-mounts-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('同一个目录两次取到同一个身份，不同目录不同', () => {
    mkdirSync(join(dir, 'a'))
    mkdirSync(join(dir, 'b'))
    expect(statKey(join(dir, 'a'))).toBe(statKey(join(dir, 'a')))
    expect(statKey(join(dir, 'a'))).not.toBe(statKey(join(dir, 'b')))
  })

  it('拿不到的路径给 undefined（不抛）', () => {
    expect(statKey(join(dir, 'nope'))).toBeUndefined()
    // 文件也是能取到身份的，不要把它误当成目录判断
    writeFileSync(join(dir, 'f'), 'x')
    expect(statKey(join(dir, 'f'))).toBeTruthy()
  })

  it('hostSide 拼宿主那边的路径', () => {
    expect(hostSide('/volume1/docker')).toBe('/host/volume1/docker')
    expect(hostSide('/volume1/docker/')).toBe('/host/volume1/docker')
  })
})
