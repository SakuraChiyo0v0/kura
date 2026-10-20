import { describe, expect, it } from 'vitest'
import { DockerError } from '../src/docker/engine.js'
import { assertImageName, builtinVersions, isListable, listVersions, normalizeRegistry, repositoryOf, splitTag } from '../src/db/images.js'
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
    // 8 在 7 前面（版本从新到旧）；7.2-alpine 被收进 7-alpine（同一主版本只留一个）
    expect(list.versions.map((v) => v.tag)).toEqual(['8-alpine', '7-alpine', '7'])
    // latest 与三段版本被滤掉
    expect(list.versions.some((v) => v.tag === 'latest')).toBe(false)
    expect(list.versions.some((v) => v.version === '8.0.1')).toBe(false)
  })

  it('同一主版本的小版本被收成一个（否则下拉框被补丁版本刷满）', async () => {
    // 真实形状：docker.1ms.run 上 PostgreSQL 列出来就是这一串
    const list = await listVersions('postgres', {
      fetchImpl: fakeFetch(() => ({
        body: hubResponse([
          { name: '17.11-alpine' },
          { name: '17.11' },
          { name: '17.11-bookworm' },
          { name: '17.11-trixie' },
          { name: '17.10-alpine' },
          { name: '17.10' },
          { name: '17.9-alpine' },
          { name: '16.5-alpine' },
        ]),
      })),
    })
    // 17 只出一个 17-alpine / 17 / 17-bookworm / 17-trixie，不再有 17.11 / 17.10 / 17.9
    const tags = list.versions.map((v) => v.tag)
    expect(tags).not.toContain('17.11-alpine')
    expect(tags).not.toContain('17.10-alpine')
    expect(tags).toContain('17-alpine')
    expect(tags).toContain('16-alpine')
    // 每个 (主版本, 变体) 只出现一次
    expect(new Set(tags).size).toBe(tags.length)
  })

  it('MySQL 的 8.4 不会被收成 8（那样镜像根本不存在）', async () => {
    const list = await listVersions('mysql', {
      fetchImpl: fakeFetch(() => ({ body: hubResponse([{ name: '8.4' }, { name: '8.0' }, { name: '5.7' }]) })),
    })
    expect(list.versions.map((v) => v.tag)).toEqual(['8.4', '8.0', '5.7'])
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

  it('Docker Hub 挂了不抛错，回落到内置版本（离线时不能把安装废掉）', async () => {
    const list = await listVersions('postgres', {
      fetchImpl: fakeFetch(() => ({ status: 503, body: { message: 'unavailable' } })),
    })
    // 关键：**不是空列表** —— 用户仍然要能选一个版本装
    expect(list.versions.length).toBeGreaterThan(0)
    expect(list.source).toBe('builtin')
    expect(list.error).toContain('503')
    // 默认镜像还在，界面能回退
    expect(list.defaultImage).toBe(templates.postgres.image)
  })

  it('网络异常也不抛，回 error', async () => {
    const list = await listVersions('redis', {
      fetchImpl: fakeFetch(() => ({ throw: new Error('getaddrinfo ENOTFOUND hub.docker.com') })),
    })
    expect(list.error).toContain('ENOTFOUND')
    expect(list.defaultImage).toBe(templates.redis.image)
  })

  it('把 fetch 的 cause 链剥出来（只说 "fetch failed" 等于没说）', async () => {
    // Node 的 fetch 失败时，外层永远只是 TypeError('fetch failed')，
    // 真实原因（ENOTFOUND / ECONNREFUSED / 证书）在 cause 里。真机上报的就是这个形状。
    const outer = new TypeError('fetch failed')
    ;(outer as Error & { cause?: unknown }).cause = Object.assign(new Error('getaddrinfo ENOTFOUND hub.docker.com'), {
      code: 'ENOTFOUND',
    })
    const list = await listVersions('postgres', { fetchImpl: fakeFetch(() => ({ throw: outer })) })
    // 关键：不能只显示 "fetch failed"
    expect(list.error).not.toBe('fetch failed')
    expect(list.error).toContain('ENOTFOUND')
    expect(list.error).toContain('Docker Hub')
  })

  it('cause 里是 ECONNREFUSED 时也说得清', async () => {
    const outer = new TypeError('fetch failed')
    ;(outer as Error & { cause?: unknown }).cause = Object.assign(new Error('connect ECONNREFUSED 1.2.3.4:443'), {
      code: 'ECONNREFUSED',
    })
    const list = await listVersions('redis', { fetchImpl: fakeFetch(() => ({ throw: outer })) })
    expect(list.error).toContain('ECONNREFUSED')
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

/**
 * 镜像站点通道（registry `/v2/tags/list`）。
 *
 * 这是给「NAS 连不上 hub.docker.com」的现实准备的：国内网络下 hub 的 web API 常常不通，
 * 但镜像加速器代理的是 registry 接口。两者的响应形状**完全不同**，所以分成两个通道。
 */
describe('镜像站点：normalizeRegistry', () => {
  it('只填域名时补 https', () => {
    expect(normalizeRegistry('docker.1ms.run')).toBe('https://docker.1ms.run')
  })

  it('已经带了 scheme 就原样（去掉尾部斜杠）', () => {
    expect(normalizeRegistry('https://docker.1ms.run/')).toBe('https://docker.1ms.run')
    expect(normalizeRegistry('http://mirror.local:5000')).toBe('http://mirror.local:5000')
  })

  it('空 / 空白回空串（表示用官方）', () => {
    expect(normalizeRegistry('')).toBe('')
    expect(normalizeRegistry('   ')).toBe('')
    expect(normalizeRegistry(undefined)).toBe('')
  })
})

describe('内置兜底版本', () => {
  it('每个引擎都有一份，且能拼成合法镜像名', () => {
    for (const engine of ['postgres', 'mysql', 'mariadb', 'redis'] as const) {
      const versions = builtinVersions(engine)
      expect(versions.length).toBeGreaterThan(0)
      for (const version of versions) {
        expect(() => assertImageName(engine, `${repositoryOf(engine)}:${version.tag}`)).not.toThrow()
      }
    }
  })

  it('兜底列表也按版本从新到旧', () => {
    const versions = builtinVersions('postgres')
    const numbers = versions.map((v) => Number(v.version))
    expect(numbers).toEqual([...numbers].sort((a, b) => b - a))
  })
})

describe('listVersions：走镜像站点', () => {
  /** 造一个只应答 registry 的假 fetch。 */
  function registryFetch(handler: (url: string, headers: Record<string, string>) => { status: number; body?: unknown; headers?: Record<string, string> }): typeof fetch {
    return (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      const headers = (init?.headers ?? {}) as Record<string, string>
      const result = handler(url, headers)
      return new Response(result.body === undefined ? '' : JSON.stringify(result.body), {
        status: result.status,
        headers: result.headers ?? { 'content-type': 'application/json' },
      })
    }) as typeof fetch
  }

  it('不需要认证的站点：直接给 tags', async () => {
    const list = await listVersions('postgres', {
      registry: 'docker.1ms.run',
      fetchImpl: registryFetch((url) => {
        if (url.includes('/v2/library/postgres/tags/list')) {
          return { status: 200, body: { name: 'library/postgres', tags: ['17', '17-alpine', '16-alpine'] } }
        }
        return { status: 404 }
      }),
    })
    expect(list.source).toBe('registry')
    expect(list.versions.map((v) => v.tag)).toEqual(['17-alpine', '17', '16-alpine'])
  })

  it('要 Bearer 认证的站点：按 challenge 换 token 再查', async () => {
    const seen: string[] = []
    const list = await listVersions('postgres', {
      registry: 'docker.m.daocloud.io',
      fetchImpl: registryFetch((url, headers) => {
        seen.push(url)
        if (url.includes('/auth/token')) {
          return { status: 200, body: { token: 'tok-123' } }
        }
        if (url.includes('/v2/library/postgres/tags/list')) {
          if (headers.authorization !== 'Bearer tok-123') {
            return {
              status: 401,
              headers: {
                'content-type': 'application/json',
                'www-authenticate': 'Bearer realm="https://m.daocloud.io/auth/token",service="docker.m.daocloud.io",scope="repository:library/postgres:pull"',
              },
              body: { errors: [{ code: 'UNAUTHORIZED' }] },
            }
          }
          return { status: 200, body: { name: 'library/postgres', tags: ['17-alpine'] } }
        }
        return { status: 404 }
      }),
    })
    expect(list.source).toBe('registry')
    expect(list.versions.map((v) => v.tag)).toEqual(['17-alpine'])
    // 确实按 challenge 去换了 token
    expect(seen.some((u) => u.includes('/auth/token'))).toBe(true)
    expect(seen.some((u) => u.includes('scope=repository%3Alibrary%2Fpostgres%3Apull'))).toBe(true)
  })

  it('站点禁掉 tags 列表时不当成「没有版本」，而是回退到内置列表', async () => {
    // 实测 daocloud 就是回 {"name":"disable-list-tags","tags":[]}
    const list = await listVersions('postgres', {
      registry: 'docker.m.daocloud.io',
      fetchImpl: registryFetch((url) => {
        if (url.includes('/auth/token')) return { status: 200, body: { token: 't' } }
        if (url.includes('/tags/list')) return { status: 200, body: { name: 'disable-list-tags', tags: [] } }
        return { status: 404 }
      }),
    })
    // 关键：不能是空列表 —— 那会让界面显示「没有版本可用」
    expect(list.versions.length).toBeGreaterThan(0)
    expect(list.source).toBe('builtin')
    expect(list.error).toContain('不提供版本列表')
  })

  it('站点不通时继续试 Docker Hub，再不行用内置', async () => {
    const list = await listVersions('redis', {
      registry: 'dead.example',
      fetchImpl: registryFetch((url) => {
        if (url.includes('dead.example')) throw Object.assign(new TypeError('fetch failed'), {
          cause: Object.assign(new Error('getaddrinfo ENOTFOUND dead.example'), { code: 'ENOTFOUND' }),
        })
        if (url.includes('hub.docker.com')) throw Object.assign(new TypeError('fetch failed'), {
          cause: Object.assign(new Error('connect ECONNRESET'), { code: 'ECONNRESET' }),
        })
        return { status: 404 }
      }),
    })
    expect(list.source).toBe('builtin')
    expect(list.versions.length).toBeGreaterThan(0)
    // 两条通道的失败原因都要报出来（排查时要知道是站点的问题还是 Hub 的问题）
    expect(list.error).toContain('镜像站点')
    expect(list.error).toContain('Docker Hub')
  })

  it('没配站点时直接走 Docker Hub（source=hub，带大小）', async () => {
    const list = await listVersions('postgres', {
      fetchImpl: fakeFetch(() => ({ body: hubResponse([{ name: '17-alpine', size: 250_000_000 }]) })),
    })
    expect(list.source).toBe('hub')
    expect(list.versions[0]?.size).toBe(250_000_000)
  })
})
