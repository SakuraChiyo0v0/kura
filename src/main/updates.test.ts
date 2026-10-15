import { describe, expect, it } from 'vitest'
import type { UpdateStatus } from '@sakura-ui/electron/shared'
import { UpdateScheduler, checkIntervalMs, firstCheckDelayMs, friendlyBackend, friendlyUpdateError, nsisBackend, updateSource } from './updates.js'

/** 手动推进的定时器：只记最新排的那一个（调度器同一时刻只排一个） */
function fakeTimers() {
  const pending = new Map<number, { fn: () => void; ms: number }>()
  let next = 0
  return {
    pending,
    setTimeout: (fn: () => void, ms: number) => {
      const id = ++next
      pending.set(id, { fn, ms })
      return id
    },
    clearTimeout: (id: unknown) => void pending.delete(id as number),
    /** 触发唯一一个待定任务，返回它的延迟 */
    async fire(): Promise<number> {
      expect(pending.size).toBe(1)
      const [id, task] = [...pending][0]!
      pending.delete(id)
      task.fn()
      await new Promise((r) => setImmediate(r))
      return task.ms
    },
  }
}

function fakeManager(initial: UpdateStatus = { state: 'idle' }) {
  let status = initial
  const listeners = new Set<(s: UpdateStatus) => void>()
  const set = (next: UpdateStatus) => {
    status = next
    for (const l of listeners) l(next)
    return next
  }
  return {
    set,
    checks: 0,
    downloads: 0,
    checkResult: { state: 'up-to-date' } as UpdateStatus,
    getStatus: () => status,
    async check() {
      this.checks++
      return set(this.checkResult)
    },
    async download() {
      this.downloads++
      return status
    },
    onChange(listener: (s: UpdateStatus) => void) {
      listeners.add(listener)
      return () => void listeners.delete(listener)
    },
  }
}

const log = { info: () => {}, warn: () => {} }

describe('UpdateScheduler', () => {
  it('启动一分钟后查一次，之后每 6 小时查', async () => {
    const timers = fakeTimers()
    const manager = fakeManager()
    new UpdateScheduler({ manager, enabled: () => true, log, timers }).start()
    expect(await timers.fire()).toBe(firstCheckDelayMs)
    expect(manager.checks).toBe(1)
    expect(await timers.fire()).toBe(checkIntervalMs)
    expect(manager.checks).toBe(2)
  })

  it('查到新版本就自动下载', async () => {
    const timers = fakeTimers()
    const manager = fakeManager()
    manager.checkResult = { state: 'available', version: '9.9.9' }
    new UpdateScheduler({ manager, enabled: () => true, log, timers }).start()
    await timers.fire()
    expect(manager.downloads).toBe(1)
  })

  it('已经下好了就不再问', async () => {
    const timers = fakeTimers()
    const manager = fakeManager({ state: 'downloaded', version: '9.9.9' })
    new UpdateScheduler({ manager, enabled: () => true, log, timers }).start()
    await timers.fire()
    expect(manager.checks).toBe(0)
    expect(timers.pending.size).toBe(1)
  })

  it('开关关着：不排定时器；手动查到了也只提示不下载', async () => {
    const timers = fakeTimers()
    const manager = fakeManager()
    let enabled = false
    const scheduler = new UpdateScheduler({ manager, enabled: () => enabled, log, timers })
    scheduler.start()
    expect(timers.pending.size).toBe(0)
    manager.set({ state: 'available', version: '9.9.9' })
    expect(manager.downloads).toBe(0)

    enabled = true
    scheduler.setEnabled(true)
    expect(timers.pending.size).toBe(1)
    enabled = false
    scheduler.setEnabled(false)
    expect(timers.pending.size).toBe(0)
  })

  it('stop 之后不再排、也不再响应状态', async () => {
    const timers = fakeTimers()
    const manager = fakeManager()
    const scheduler = new UpdateScheduler({ manager, enabled: () => true, log, timers })
    scheduler.start()
    scheduler.stop()
    expect(timers.pending.size).toBe(0)
    manager.set({ state: 'available', version: '9.9.9' })
    expect(manager.downloads).toBe(0)
  })
})

describe('updateSource', () => {
  it('冒烟永远不接；打包后走 GitHub；开发模式默认不接', () => {
    expect(updateSource({ packaged: true, smoke: true, env: { KURA_UPDATE_URL: 'http://x' } })).toEqual({ kind: 'off' })
    expect(updateSource({ packaged: true, smoke: false, env: {} })).toEqual({ kind: 'github' })
    expect(updateSource({ packaged: false, smoke: false, env: {} })).toEqual({ kind: 'off' })
  })

  it('KURA_UPDATE_URL 只认 http(s)', () => {
    expect(updateSource({ packaged: false, smoke: false, env: { KURA_UPDATE_URL: 'http://127.0.0.1:8123/' } })).toEqual({
      kind: 'generic',
      url: 'http://127.0.0.1:8123/',
    })
    expect(updateSource({ packaged: true, smoke: false, env: { KURA_UPDATE_URL: 'file:///C:/x' } })).toEqual({ kind: 'off' })
  })
})

describe('friendlyBackend', () => {
  const coded = (message: string, code: string) => Object.assign(new Error(message), { code })
  const backend = (error: unknown) => ({
    check: async () => {
      throw error
    },
    download: async () => {
      throw error
    },
    install: () => {},
  })

  it('还没发过版：当成已是最新（返回 null），不报错', async () => {
    const warned: string[] = []
    const wrapped = friendlyBackend(backend(coded('No published versions on GitHub', 'ERR_UPDATER_NO_PUBLISHED_VERSIONS')), {
      warn: (m) => void warned.push(m),
    })
    await expect(wrapped.check()).resolves.toBeNull()
    expect(warned).toEqual([])
  })

  it('其它错误换成一句中文，原文第一行写日志', async () => {
    const warned: Array<Record<string, unknown> | undefined> = []
    const wrapped = friendlyBackend(backend(new Error('net::ERR_CONNECTION_REFUSED\n    at stack')), { warn: (_m, f) => void warned.push(f) })
    await expect(wrapped.check()).rejects.toThrow('更新服务器拒绝了连接')
    await expect(wrapped.download(() => {})).rejects.toThrow('更新服务器拒绝了连接')
    expect(warned[0]).toEqual({ err: 'net::ERR_CONNECTION_REFUSED' })
  })

  it('仓库一个 Release 都没有（XML 层抛、不带 code）：也当成已是最新', async () => {
    const wrapped = friendlyBackend(backend(new Error('No published versions on GitHub')), { warn: () => {} })
    await expect(wrapped.check()).resolves.toBeNull()
  })

  it('认不出的错误给通用说明，不把英文原文抛给界面', () => {
    expect(friendlyUpdateError(new Error('something weird'))).toBe('检查或下载更新时出错，详情见日志')
    expect(friendlyUpdateError(new Error('getaddrinfo ENOTFOUND github.com'))).toBe('连不上更新服务器，检查一下网络')
    expect(friendlyUpdateError(new Error('sha512 checksum mismatch'))).toBe('下载的安装包校验没通过，已丢弃')
  })
})

describe('nsisBackend', () => {
  const fakeUpdater = (result: unknown) => ({
    checkForUpdates: async () => result,
    downloadUpdate: async () => {},
    quitAndInstall: () => {},
    on: () => {},
    removeListener: () => {},
  })

  it('没有新版本（isUpdateAvailable: false）时报「已是最新」，不能再往下走下载', async () => {
    // electron-updater 这时也会把 updateInfo 填成当前版本号，只按 version 在不在判断就会误报「发现新版本」
    const backend = nsisBackend(fakeUpdater({ isUpdateAvailable: false, updateInfo: { version: '0.5.1' } }))
    await expect(backend.check()).resolves.toBeNull()
  })

  it('有新版本时照常返回版本号', async () => {
    const backend = nsisBackend(fakeUpdater({ isUpdateAvailable: true, updateInfo: { version: '9.9.9' } }))
    await expect(backend.check()).resolves.toEqual({ version: '9.9.9', releaseNotes: undefined })
  })

  it('上游返回 null（开发模式没接更新源）时也是没有更新', async () => {
    const backend = nsisBackend(fakeUpdater(null))
    await expect(backend.check()).resolves.toBeNull()
  })
})
