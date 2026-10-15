import { describe, expect, it } from 'vitest'
import { decideWindowClose, isHiddenLaunch, loginItemSettings } from './lifecycle.js'

describe('开机自启', () => {
  it('安装版只带 --hidden', () => {
    expect(loginItemSettings({ openAtLogin: true, packaged: true, appPath: 'C:\\app' })).toEqual({
      openAtLogin: true,
      args: ['--hidden'],
    })
  })

  it('开发态要把应用目录带上，否则拉起的是一个空的 electron.exe', () => {
    expect(loginItemSettings({ openAtLogin: false, packaged: false, appPath: 'C:\\dev\\kura' }).args).toEqual([
      'C:\\dev\\kura',
      '--hidden',
    ])
  })

  it('带 --hidden 启动视为开机自启', () => {
    expect(isHiddenLaunch(['Kura.exe', '--hidden'])).toBe(true)
    expect(isHiddenLaunch(['Kura.exe'])).toBe(false)
  })
})

describe('decideWindowClose', () => {
  it('默认关窗口只隐藏到托盘', () => {
    expect(decideWindowClose({ quitting: false, closeToTray: true, trayAvailable: true })).toBe('hide')
  })

  it('进入退出流程后一律放行', () => {
    expect(decideWindowClose({ quitting: true, closeToTray: true, trayAvailable: true })).toBe('close')
  })

  it('关闭了「退到托盘」就真关', () => {
    expect(decideWindowClose({ quitting: false, closeToTray: false, trayAvailable: true })).toBe('close')
  })

  it('托盘没建起来时不能隐藏，否则程序会无处可找', () => {
    expect(decideWindowClose({ quitting: false, closeToTray: true, trayAvailable: false })).toBe('close')
  })
})
