import { describe, expect, it } from 'vitest'
import { isAuthRedirect, mergeCookie, rewriteLocation, rewriteSetCookie } from './cookies.js'
import { appBase } from './ugreen.js'

describe('mergeCookie', () => {
  it('保留应用自己的 cookie', () => {
    expect(mergeCookie('app_session=A; theme=dark', 'ugreen-proxy-token=X')).toBe(
      'app_session=A; theme=dark; ugreen-proxy-token=X',
    )
  })

  it('只替换客户端管理的那几个（按名字，不按值）', () => {
    expect(mergeCookie('ugreen-proxy-token=OLD; app=1', 'ugreen-proxy-token=NEW')).toBe('app=1; ugreen-proxy-token=NEW')
  })

  it('两层托管 cookie 都剔除旧值', () => {
    expect(
      mergeCookie('authelia_session=OLD; ugreen-proxy-token=OLD; x=1', 'ugreen-proxy-token=N; authelia_session=M'),
    ).toBe('x=1; ugreen-proxy-token=N; authelia_session=M')
  })

  it('入站为空', () => {
    expect(mergeCookie('', 'ugreen-proxy-token=X')).toBe('ugreen-proxy-token=X')
  })
})

describe('rewriteSetCookie', () => {
  it('去掉 Domain 与 Secure，保留其余属性', () => {
    expect(rewriteSetCookie(['sid=abc; Domain=app-8899-dev.cn30.ugdocker.link; Path=/x; Secure; HttpOnly'])).toEqual([
      'sid=abc; Path=/x; HttpOnly',
    ])
  })

  it('没有 Path 的补 Path=/', () => {
    expect(rewriteSetCookie(['sid=abc; Secure'])).toEqual(['sid=abc; Path=/'])
  })

  it('解析不了的行丢弃', () => {
    expect(rewriteSetCookie(['=novalue', 'ok=1'])).toEqual(['ok=1; Path=/'])
  })
})

describe('rewriteLocation', () => {
  it('绿联域的绝对跳转改成相对路径，保留查询与 fragment', () => {
    expect(rewriteLocation('https://app-5244-dev.cn30.ugdocker.link/a/b?x=1#frag')).toBe('/a/b?x=1#frag')
    expect(rewriteLocation('https://dev.cn30.ug.link/desktop/#/login/account')).toBe('/desktop/#/login/account')
  })

  it('别人家的域不动', () => {
    expect(rewriteLocation('https://example.com/a')).toBe('https://example.com/a')
  })

  it('相对路径不动', () => {
    expect(rewriteLocation('/a/b')).toBe('/a/b')
  })
})

describe('isAuthRedirect', () => {
  it('302 到登录页才算', () => {
    expect(isAuthRedirect(302, 'https://dev.cn30.ug.link/desktop/#/login/account')).toBe(true)
    expect(isAuthRedirect(200, 'https://dev.cn30.ug.link/desktop/#/login/account')).toBe(false)
    expect(isAuthRedirect(302, '/somewhere')).toBe(false)
  })
})

describe('appBase', () => {
  it('设备域推出 DApp 域：.ug.link → .ugdocker.link', () => {
    expect(appBase('https://dev-1.cn30.ug.link', 5244)).toBe('https://app-5244-dev-1.cn30.ugdocker.link')
  })

  it('不是绿联外网域就拒绝', () => {
    expect(() => appBase('https://nas.example.com', 5244)).toThrow(/\.ug\.link/)
    expect(() => appBase('not a url', 5244)).toThrow(/合法 URL/)
  })
})
