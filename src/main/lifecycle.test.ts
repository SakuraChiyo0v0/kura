import { describe, expect, it } from 'vitest'
import { decideWindowClose } from './lifecycle.js'

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
