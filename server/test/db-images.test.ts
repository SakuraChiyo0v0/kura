import { describe, expect, it } from 'vitest'
import { DockerError } from '../src/docker/engine.js'
import { assertImageName, isListable, listVersions, repositoryOf, splitTag } from '../src/db/images.js'
import { templates } from '../src/db/templates.js'

/**
 * Docker Hub 版本查询的单测。
 *
 * 用**真响应形状**（从 Hub 上抓下来的字段），不自己编一个：
 * 这一层要处理的是「官方镜像 tag 命名不统一」这个现实，编的样本会把过滤逻辑测成假的
 * （记忆 feedback_test_real_shapes）。
 */

describe('splitTag：从 tag 里切出版本与变体', () => {
  it('认得出这些真实存在的形状', () => {
    expect(splitTag('17')).toEqual({ version: '17', variant: '' })
    expect(splitTag('17-alpine')).toEqual({ version: '17', variant: 'alpine' })
    expect(splitTag('17.2')).toEqual({ version: '17.2', variant: '' })
    expect(splitTag('8.4')).toEqual({ version: '8.4', variant: '' })
    expect(splitTag('11.4-ubi')).toEqual({ version: '11.4', variant: 'ubi' })
    expect(splitTag('7-bookworm')).toEqual({ version: '7', variant: 'bookworm' })
  })

  it('认不出的返回 undefined（不猜）', () => {
    expect(splitTag('latest')).toBeUndefined()
    expect(splitTag('alpine')).toBeUndefined()
    expect(splitTag('windowsservercore-ltsc2022')).toBeUndefined()
    expect(splitTag('17-windowsservercore')).toEqual({ version: '17', variant: 'windowsservercore' })
  })
})

describe('isListable：哪些 tag 值得列进下拉框', () => {
  it('只留主版本与两段版本，三段小版本不列（补丁版本刷屏且很快被删）', () => {
    expect(isListable('17', '')).toBe(true)
    expect(isListable('17.2', '')).toBe(true)
    expect(isListable('17.2.1', '')).toBe(false)
  })

  it('windows 系变体不列（NAS 是 linux/amd64）', () => {
    expect(isListable('17', 'windowsservercore')).toBe(false)
    expect(isListable('17', 'nanoserver')).toBe(false)
    expect(isListable('17', 'alpine')).toBe(true)
  })
})

describe('repositoryOf', () => {
  it('从模板的默认镜像里取仓库名，不另写一份', () => {
    expect(repositoryOf('postgres')).toBe('postgres')
    expect(repositoryOf('mysql')).toBe('mysql')
    expect(repositoryOf('mariadb')).toBe('mariadb')
    expect(repositoryOf('redis')).toBe('redis')
  })
})

/** 一个能按 URL 应答的假 fetch。 */
function fakeFetch(handler: (url: string) => { status?: number; body?: unknown; throw?: Error }): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    const result = handler(url)
    if (result.throw) throw result.throw
    const status = result.status ?? 200
    return new Response(JSON.stringify(result.body ?? {}), {
      status,
      statusText: status === 200 ? 'OK' : 'Not Found',
      headers: { 'content-type': 'application/json' },
    })
  }) as typeof fetch
}

/** Docker Hub 真实响应的形状（截取关键字段）。 */
function hubResponse(tags: Array<{ name: string; last_updated?: string; size?: number }>): unknown {
  return {
    count: tags.length,
    next: null,
    previous: null,
    results: tags.map((tag) => ({
      name: tag.name,
      last_updated: tag.last_updated ?? '2026-10-01T00:00:00.000000Z',
      images: [
        { architecture: 'amd64', size: tag.size ?? 120_000_000, digest: 'sha256:aaa' },
        { architecture: 'arm64', size: 110_000_000, digest: 'sha256:bbb' },
      ],
    })),
  }
}

describe('listVersions', () => {
  it('筛出该引擎的变体，按版本从新到旧排', async () => {
    const list = await listVersions('redis', {
      fetchImpl: fakeFetch(() => ({
        body: hubResponse([{ name: '7-alpine' }, { name: '7.2-alpine' }, { name: '8-alpine' }, { name: '7' }, { name: 'latest' }, { name: '8.0.1-alpine' }]),
      })),
    })
    expect(list.repository).toBe('redis')
    // 8 在 7 前面（版本从新到旧）
    expect(list.versions.map((v) => v.tag)).toEqual(['8-alpine', '7.2-alpine', '7-alpine', '7'])
    // latest 与三段版本被滤掉
    expect(list.versions.some((v) => v.tag === 'latest')).toBe(false)
    expect(list.versions.some((v) => v.version === '8.0.1')).toBe(false)
  })

  it('只留有 amd64 的那个大小（NAS 是 amd64）', async () => {
    const list = await listVersions('postgres', {
      fetchImpl: fakeFetch(() => ({ body: hubResponse([{ name: '17-alpine', size: 250_000_000 }]) })),
    })
    expect(list.versions[0]?.size).toBe(250_000_000)
  })

  it('MySQL 只留默认变体（它没有 alpine）', async () => {
    const list = await listVersions('mysql', {
      fetchImpl: fakeFetch(() => ({ body: hubResponse([{ name: '8.4' }, { name: '8.0' }, { name: '8.4-alpine' }]) })),
    })
    expect(list.versions.map((v) => v.tag)).toEqual(['8.4', '8.0'])
  })

  it('Docker Hub 挂了不抛错，回 error + 默认镜像（离线时不能把安装废掉）', async () => {
    const list = await listVersions('postgres', {
      fetchImpl: fakeFetch(() => ({ status: 503, body: { message: 'unavailable' } })),
    })
    expect(list.versions).toEqual([])
    expect(list.error).toContain('503')
    // 关键：默认镜像还在，界面能回退
    expect(list.defaultImage).toBe(templates.postgres.image)
  })

  it('网络异常也不抛，回 error', async () => {
    const list = await listVersions('redis', {
      fetchImpl: fakeFetch(() => ({ throw: new Error('getaddrinfo ENOTFOUND hub.docker.com') })),
    })
    expect(list.error).toContain('ENOTFOUND')
    expect(list.defaultImage).toBe(templates.redis.image)
  })

  it('超时被识别成超时（不是含糊的网络错误）', async () => {
    const abortError = new Error('aborted')
    abortError.name = 'AbortError'
    const list = await listVersions('redis', { fetchImpl: fakeFetch(() => ({ throw: abortError })) })
    expect(list.error).toContain('超时')
  })

  it('查的是 library/<仓库> 这个官方命名空间', async () => {
    let seen = ''
    await listVersions('postgres', {
      fetchImpl: fakeFetch((url) => {
        seen = url
        return { body: hubResponse([]) }
      }),
    })
    expect(seen).toContain('/library/postgres/tags')
  })

  it('同一版本里默认变体排前面', async () => {
    const list = await listVersions('postgres', {
      fetchImpl: fakeFetch(() => ({ body: hubResponse([{ name: '17-bookworm' }, { name: '17-alpine' }]) })),
    })
    expect(list.versions[0]?.variant).toBe('alpine')
  })
})

describe('assertImageName：不能把任意字符串塞进 compose', () => {
  it('合法镜像名通过', () => {
    expect(() => assertImageName('postgres', 'postgres:17-alpine')).not.toThrow()
    expect(() => assertImageName('mysql', 'mysql:8.4')).not.toThrow()
  })

  it('换仓库被拒（等于换一个没验过的镜像）', () => {
    expect(() => assertImageName('postgres', 'evil/postgres:17')).toThrow(DockerError)
    expect(() => assertImageName('postgres', 'mysql:8.4')).toThrow(/只支持官方镜像/)
  })

  it('带换行的被拒 —— 那能在 compose 里造出额外的行', () => {
    expect(() => assertImageName('postgres', 'postgres:17\n    privileged: true')).toThrow(DockerError)
    expect(() => assertImageName('postgres', 'postgres:17 alpine')).toThrow(DockerError)
  })

  it('空 tag / 带空格的都拒', () => {
    expect(() => assertImageName('postgres', 'postgres:')).toThrow(DockerError)
    expect(() => assertImageName('postgres', '')).toThrow(DockerError)
  })
})
