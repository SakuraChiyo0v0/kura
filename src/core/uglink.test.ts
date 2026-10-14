import { describe, expect, it } from 'vitest'
import type { HttpRequester } from './http.js'
import { lookupUglink, normalizeAlias } from './uglink.js'

describe('normalizeAlias', () => {
  it('认用户可能粘贴的各种形态', () => {
    // 裸 ID
    expect(normalizeAlias('dev-7f3a')).toBe('dev-7f3a')
    expect(normalizeAlias('  DEV-7F3A  ')).toBe('dev-7f3a')
    // 绿联界面上「网页端」那条
    expect(normalizeAlias('https://ug.link/dev-7f3a')).toBe('dev-7f3a')
    // 登录后跳转到的设备域（带路径与锚点）
    expect(normalizeAlias('https://dev-7f3a.cn99.ug.link/desktop/?os=ugospro#/')).toBe('dev-7f3a')
    // 不带节点域的写法
    expect(normalizeAlias('dev-7f3a.ug.link')).toBe('dev-7f3a')
    // DApp 域（容器「外部链接」）
    expect(normalizeAlias('https://app-5244-dev-7f3a.cn99.ugdocker.link')).toBe('dev-7f3a')
  })

  it('ugapp 域解析不出来也不硬猜（设备名夹在中间，无法可靠切开）', () => {
    // app-<应用id>-<设备>-<随机>.cn99.ugapp.link：设备名两侧都是可变的，猜错不如留给查找去报「ID 不存在」
    expect(normalizeAlias('app-xxxxxxxx-dev-7f3a-xxxxx.cn99.ugapp.link')).not.toBe('dev-7f3a')
  })

  it('认不出来的返回空串或原样，不硬造', () => {
    expect(normalizeAlias('')).toBe('')
    expect(normalizeAlias('   ')).toBe('')
    expect(normalizeAlias('nas.example.com')).toBe('nas')
  })
})

describe('lookupUglink', () => {
  const respond = (body: string, status = 200): HttpRequester => async () => ({
    status,
    headers: {},
    body: Buffer.from(body),
  })

  it('把 ID 解析成设备域与局域网地址', async () => {
    const request = respond(
      JSON.stringify({
        code: 200,
        msg: 'SUCCESS',
        data: {
          alias: 'dev-7f3a',
          relayDomain: 'cn99.ug.link',
          netInfo: { ipv4: ['192.0.2.10'] },
        },
      }),
    )
    const info = await lookupUglink('https://ug.link/dev-7f3a', request)
    expect(info).toEqual({ id: 'dev-7f3a', base: 'https://dev-7f3a.cn99.ug.link', lanHost: '192.0.2.10' })
  })

  it('没有局域网地址也能用（只走外网）', async () => {
    const request = respond(JSON.stringify({ code: 200, msg: 'ok', data: { alias: 'dev-1', relayDomain: 'cn99.ug.link' } }))
    expect(await lookupUglink('dev-1', request)).toMatchObject({ lanHost: '' })
  })

  it('ID 不存在时报绿联的原话，别让它变成一个莫名其妙的连接失败', async () => {
    const request = respond(JSON.stringify({ code: 7022, msg: 'UGREENlink ID不存在' }))
    await expect(lookupUglink('no-such-device-zzz', request)).rejects.toThrow(/没有这个 UGREENlink ID/)
  })

  it('缺中继域直接报错，不留半份配置', async () => {
    const request = respond(JSON.stringify({ code: 200, msg: 'ok', data: { alias: 'dev-1' } }))
    await expect(lookupUglink('dev-1', request)).rejects.toThrow(/中继域/)
  })

  it('空 ID / 畸形 ID 在发请求前就拒绝', async () => {
    const request = respond('{}')
    await expect(lookupUglink('', request)).rejects.toThrow(/请填写/)
    await expect(lookupUglink('https://ug.link/', request)).rejects.toThrow(/请填写/)
    await expect(lookupUglink('中文', request)).rejects.toThrow(/格式不对/)
  })
})
