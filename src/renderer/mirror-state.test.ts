import { describe, expect, it } from 'vitest'
import type { ServiceContainerView, ServiceView } from '../core/mirror.js'
import { containerState } from './MirrorView.js'

function port(overrides: Partial<ServiceView> = {}): ServiceView {
  return {
    key: 'snowluma-5099',
    spec: {
      port: 5099,
      service: 'snowluma-5099',
      label: 'snowluma-5099',
      source: 'discovered',
      container: 'snowluma',
      containerId: 'a'.repeat(64),
    },
    listener: { enabled: true, running: true, port: 5099, lastError: '' },
    localUrl: 'http://127.0.0.1:5099',
    externalUrl: '',
    stats: {
      requests: 0,
      errors: 0,
      lastError: '',
      bytesUp: 0,
      bytesDown: 0,
      recent: { requests: 0, errors: 0, bytesUp: 0, bytesDown: 0 },
      trend: [],
    },
    ...overrides,
  }
}

function container(ports: ServiceView[]): ServiceContainerView {
  return { key: 'a'.repeat(64), label: 'snowluma', ports, stats: ports[0]!.stats }
}

describe('多端口容器的展示状态', () => {
  it('启用入口全部正常才算正常', () => {
    expect(containerState(container([port(), port({ key: 'snowluma-6081' })]))).toEqual({ tone: 'success', label: '2 个入口监听中' })
  })

  it('一个启用入口失败：整个应用标异常，但不把已关闭入口误报成失败', () => {
    const failed = port({ key: 'snowluma-3001', listener: { enabled: true, running: false, port: 3001, lastError: '占用' } })
    expect(containerState(container([port(), failed]))).toEqual({ tone: 'warning', label: '1 个入口异常' })
    expect(containerState(container([failed, port({ listener: { enabled: false, running: false, port: 6081, lastError: '' } })]))).toEqual({ tone: 'warning', label: '1 个入口异常' })
  })

  it('用户关掉的入口不计入异常或运行中', () => {
    const off = port({ key: 'snowluma-3001', listener: { enabled: false, running: false, port: 3001, lastError: '' } })
    expect(containerState(container([port(), off]))).toEqual({ tone: 'success', label: '1 个入口监听中' })
  })

  it('全部入口关闭才显示已关闭', () => {
    const off = port({ listener: { enabled: false, running: false, port: 5099, lastError: '' } })
    expect(containerState(container([off, off]))).toEqual({ tone: 'neutral', label: '已关闭' })
  })
})
