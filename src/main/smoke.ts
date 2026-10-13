import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import { join } from 'node:path'
import type { BrowserWindow } from 'electron'
import { delay } from '@sakura-ui/electron/shared'

export interface SmokeContext {
  window: BrowserWindow
  userData: string
  isTrayCreated(): boolean
  showMainWindow(): void
}

function httpGet(url: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve) => {
    http
      .get(url, (res) => {
        let body = ''
        res.on('data', (c) => (body += c))
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }))
      })
      .on('error', (error) => resolve({ status: 0, body: error.message }))
  })
}

/**
 * 真实 Electron 里的无人值守冒烟（KURA_SMOKE=1，假 NAS 由 scripts/smoke.mjs 提供）。
 *
 * 走一遍用户真实会做的事：首次启动看到引导 → 填表 → 测试连接 → 保存 → 映射页出现服务卡片
 * → 本机端口真能访问到 NAS 上的应用 → 关掉一个服务端口真的释放 → 关窗口只隐藏、托盘能唤回。
 * 每一项判据都对着外部事实（HTTP 实际响应、磁盘文件内容、视口尺寸），不对着相邻的页面元素。
 */
export async function runSmoke(ctx: SmokeContext): Promise<boolean> {
  const { window } = ctx
  const js = <T>(code: string): Promise<T> => window.webContents.executeJavaScript(code) as Promise<T>
  const results: Array<[string, boolean, string?]> = []
  const check = (name: string, ok: boolean, detail?: string) => results.push([name, ok, detail])
  const shotDir = process.env.KURA_SCREENSHOT_DIR
  const shot = async (name: string) => {
    if (!shotDir) return
    mkdirSync(shotDir, { recursive: true })
    writeFileSync(join(shotDir, name), (await window.webContents.capturePage()).toPNG())
  }
  /** 等页面上出现某个条件，最多 timeoutMs */
  const waitFor = async (code: string, timeoutMs = 8_000): Promise<boolean> => {
    const end = Date.now() + timeoutMs
    while (Date.now() < end) {
      if (await js<boolean>(code)) return true
      await delay(150)
    }
    return false
  }
  /** React 受控输入：用原生 setter 改值再派发 input 事件，onChange 才会收到 */
  const fill = (label: string, value: string) =>
    js(`(() => {
      const input = [...document.querySelectorAll('label')].find(l => l.textContent.trim().startsWith(${JSON.stringify(label)}))?.control
        ?? [...document.querySelectorAll('input')].find(i => i.getAttribute('aria-label') === ${JSON.stringify(label)})
      if (!input) return false
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(value)})
      input.dispatchEvent(new Event('input', { bubbles: true }))
      return true
    })()`)
  const clickButton = (text: string) =>
    js<boolean>(`(() => { const b = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === ${JSON.stringify(text)} && !b.disabled); b?.click(); return Boolean(b) })()`)

  const timeout = setTimeout(() => {
    console.error('SMOKE 超时未完成', JSON.stringify(results))
    process.exit(1)
  }, 60_000)
  timeout.unref()

  try {
    if (window.webContents.isLoading()) {
      await new Promise<void>((resolve) => window.webContents.once('did-finish-load', () => resolve()))
    }
    window.show()

    // ① 外壳
    check('标题栏', await waitFor(`document.querySelector('.sk-el-titlebar__title')?.textContent === 'Kura'`))
    check('preload 桥', await js<boolean>(`typeof window.kura?.connection?.test === 'function'`))
    check('托盘', ctx.isTrayCreated())

    // ② 首次启动 = 引导
    const onboarding = await waitFor(`document.querySelector('[data-testid="page-title"]')?.textContent === '连接你的绿联 NAS'`)
    check('首次启动显示引导', onboarding)
    await shot('v0.1-引导.png')

    // ③ 填表 → 测试连接
    const filled = await Promise.all([
      fill('设备地址', 'https://smoke-dev.cn30.ug.link'),
      fill('账号', 'smoke-user'),
      fill('密码', 'smoke-pass'),
      fill('NAS 局域网地址', '127.0.0.1'),
      fill('网关账号', 'smoke-gw'),
      fill('网关密码', 'smoke-gw-pass'),
    ])
    check('表单填写', filled.every(Boolean), JSON.stringify(filled))
    await clickButton('测试连接')
    const tested = await waitFor(`document.querySelectorAll('[data-testid="connection-test"] [data-ok="true"]').length >= 3`)
    check('测试连接三步通过', tested, await js<string>(`document.querySelector('[data-testid="connection-test"]')?.innerText ?? '无结果'`))
    await shot('v0.1-测试连接.png')

    // ④ 保存 → 凭据加密落盘 → 进入映射页
    await clickButton('保存并连接')
    const toMirror = await waitFor(`document.querySelector('[data-testid="page-title"]')?.textContent === '服务映射'`)
    check('保存后进入服务映射', toMirror)
    const disk = (() => {
      try {
        return readFileSync(join(ctx.userData, 'credentials.json'), 'utf8')
      } catch {
        return ''
      }
    })()
    check('凭据已加密落盘', disk.length > 0 && !/smoke-pass|smoke-gw-pass|smoke-user|smoke-dev/.test(disk))

    // ⑤ 服务卡片出现，本机端口真能访问到 NAS 上的应用
    const cards = await waitFor(`document.querySelectorAll('[data-testid="service-card"]').length === 2`, 15_000)
    check('清单里的两个服务出现', cards)
    const portA = Number(process.env.SMOKE_PORT_A)
    const viaMirror = await httpGet(`http://127.0.0.1:${portA}/`)
    check('本机端口转发到 NAS 应用', viaMirror.status === 200 && viaMirror.body.includes('fake openlist'), `${viaMirror.status} ${viaMirror.body.slice(0, 80)}`)
    await delay(3_500) // 等一轮快照刷新，卡片上的请求数跟上
    await shot('v0.1-服务映射.png')

    // ⑥ 关掉 openlist：端口真的释放
    await js(`document.querySelector('[data-service="openlist"] [role="switch"]')?.click()`)
    const off = await waitFor(`document.querySelector('[data-service="openlist"]')?.innerText.includes('已关闭')`)
    const afterOff = await httpGet(`http://127.0.0.1:${portA}/`)
    check('关闭服务后端口释放', off && afterOff.status === 0, `界面=${off} 请求=${afterOff.status}`)

    // ⑦ 概览
    await js(`document.querySelector('.sk-sidebar-item[aria-label="概览"]')?.click()`)
    check('概览页', await waitFor(`document.querySelector('.kura-stats') !== null`))
    await delay(500)
    await shot('v0.1-概览.png')

    // ⑧ 布局：侧栏撑到窗口底（判据对视口，不对父容器）
    const layout = await js<{ bottom: number; viewport: number }>(
      `({ bottom: Math.round(document.querySelector('.sk-sidebar').getBoundingClientRect().bottom), viewport: innerHeight })`,
    )
    check('侧栏撑满', Math.abs(layout.bottom - layout.viewport) <= 1, JSON.stringify(layout))

    // ⑨ 关窗口只隐藏，托盘唤回
    window.close()
    await delay(300)
    check('关窗只隐藏', !window.isDestroyed() && !window.isVisible())
    ctx.showMainWindow()
    await delay(300)
    check('托盘唤回', !window.isDestroyed() && window.isVisible())
  } catch (error) {
    check('执行异常', false, (error as Error).stack)
  } finally {
    clearTimeout(timeout)
  }

  const passed = results.every(([, ok]) => ok)
  for (const [name, ok, detail] of results) {
    console.log(`  ${ok ? '✓' : '✗'} ${name}${!ok && detail ? `：${detail}` : ''}`)
  }
  console.log(`SMOKE ${results.filter(([, ok]) => ok).length}/${results.length} => ${passed ? 'PASS' : 'FAIL'}`)
  return passed
}
