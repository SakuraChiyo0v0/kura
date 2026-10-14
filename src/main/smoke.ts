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
  /** 本机 WebDAV 的地址 */
  davUrl(): string
}

function httpGet(url: string): Promise<{ status: number; body: string }> {
  return httpSend('GET', url)
}

function httpSend(method: string, url: string, headers: Record<string, string> = {}, body?: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve) => {
    const req = http.request(url, { method, headers }, (res) => {
      let text = ''
      res.on('data', (c) => (text += c))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: text }))
    })
    req.on('error', (error) => resolve({ status: 0, body: error.message }))
    req.end(body)
  })
}

/**
 * 第二轮冒烟：用第一轮留下的同一份数据目录**重启**，看「已经配置过」的人每次打开 Kura 看到什么。
 *
 * 判据都盯着「第一帧」：
 * - 不出现引导页（凭据读得到）；
 * - 页面一加载完就是主界面、且已经有服务卡片（上次缓存的清单，不等网络）；
 * - 假 NAS 在这一轮故意把清单接口拖慢（SMOKE_SLOW_SERVICES_MS），证明卡片确实来自缓存、
 *   而之后最新清单一到，界面靠**推送**更新（不靠 3 秒轮询）。
 */
export async function runRestartSmoke(ctx: { window: BrowserWindow; startedAt: number }): Promise<boolean> {
  const { window } = ctx
  const js = <T>(code: string): Promise<T> => window.webContents.executeJavaScript(code) as Promise<T>
  const results: Array<[string, boolean, string?]> = []
  const check = (name: string, ok: boolean, detail?: string) => results.push([name, ok, detail])
  const timeout = setTimeout(() => {
    console.error('SMOKE(重启) 超时未完成', JSON.stringify(results))
    process.exit(1)
  }, 60_000)
  timeout.unref()
  try {
    if (window.webContents.isLoading()) {
      await new Promise<void>((resolve) => window.webContents.once('did-finish-load', () => resolve()))
    }
    window.show()
    // 页面脚本刚跑完的那一刻：第一帧画的是什么
    await delay(50)
    const first = await js<{ title: string; cards: number; onboarding: boolean; bootstrap: boolean }>(`({
      title: document.querySelector('[data-testid="page-title"]')?.textContent ?? '',
      cards: document.querySelectorAll('.kura-service-list li, [data-testid="service-card"]').length,
      onboarding: document.querySelector('.kura-onboarding') !== null,
      bootstrap: Boolean(window.kura?.bootstrap?.connection?.configured),
    })`)
    check('重启不进引导页', !first.onboarding && first.bootstrap, JSON.stringify(first))
    check('第一帧就是主界面（无空白等待）', first.title === '概览', JSON.stringify(first))
    check('第一帧就有服务（来自上次缓存）', first.cards >= 4, JSON.stringify(first))
    const openedMs = Date.now() - ctx.startedAt

    // 清单接口被拖慢了：这时应该显示「正在同步」而不是空白；到了之后自动刷新（推送）
    const syncingShown = await js<boolean>(`document.querySelector('.kura-section__foot')?.textContent.includes('同步') ?? false`)
    const synced = await waitUntil(js, `window.kura.mirror.snapshot().then(s => s?.phase === 'ready')`, 15_000)
    // 主进程同步完成后，界面在 1 秒内（远小于 3 秒轮询）就该反映出来
    const pushed = await waitUntil(js, `document.querySelector('.kura-section__foot')?.textContent.includes('秒前') ?? false`, 1_000)
    check('清单到达后界面立即更新（推送）', synced && pushed, `syncingShown=${syncingShown} synced=${synced} pushed=${pushed}`)
    check('启动到窗口可用的耗时', openedMs < 8_000, `${openedMs}ms`)
  } catch (error) {
    check('执行异常', false, (error as Error).stack)
  } finally {
    clearTimeout(timeout)
  }
  const passed = results.every(([, ok]) => ok)
  for (const [name, ok, detail] of results) console.log(`  ${ok ? '✓' : '✗'} ${name}${detail && (!ok || name.includes('耗时')) ? `：${detail}` : ''}`)
  console.log(`SMOKE(重启) ${results.filter(([, ok]) => ok).length}/${results.length} => ${passed ? 'PASS' : 'FAIL'}`)
  return passed
}

async function waitUntil(js: <T>(code: string) => Promise<T>, code: string, timeoutMs: number): Promise<boolean> {
  const end = Date.now() + timeoutMs
  while (Date.now() < end) {
    if (await js<boolean>(code)) return true
    await delay(100)
  }
  return false
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
  /** 假 NAS 自己记的计数（scripts/smoke.mjs 的 /__smoke/counters） */
  const smokeNasCounter = async (name: string): Promise<number> => {
    const res = await httpGet(`${process.env.KURA_SMOKE_NAS}/__smoke/counters`)
    try {
      return Number((JSON.parse(res.body) as Record<string, number>)[name] ?? -1)
    } catch {
      return -1
    }
  }
  const clickButton = (text: string) =>
    js<boolean>(`(() => { const b = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === ${JSON.stringify(text)} && !b.disabled); b?.click(); return Boolean(b) })()`)

  const timeout = setTimeout(() => {
    console.error('SMOKE 超时未完成', JSON.stringify(results))
    process.exit(1)
  }, 120_000)
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

    // ③ 填表 → 测试连接（填的是 UGREENlink ID，设备域由主进程查绿联云得到）
    const filled = await Promise.all([
      fill('UGREENlink ID', 'smoke-nas-id'),
      fill('账号', 'smoke-user'),
      fill('密码', 'smoke-pass'),
      fill('NAS 局域网地址', '127.0.0.1'),
    ])
    check('表单填写', filled.every(Boolean), JSON.stringify(filled))
    const lookupsBefore = await smokeNasCounter('lookups')
    // 一步完成：点「测试并连接」= 逐条测试 → 全部通过 → 保存 → 进入主界面
    await clickButton('测试并连接')
    // 逐条点亮：未跑到的步骤先以转圈（data-pending）出现，跑完才落成 data-ok。
    // 判据盯的是「同一时刻既有转圈也有结果」——否则等它全绿再断言，等于没测动态效果。
    const progressive = await waitFor(
      `(() => {
         const items = document.querySelectorAll('[data-testid="connection-test"] .kura-test__step')
         if (items.length < 4) return false
         const pending = document.querySelectorAll('[data-testid="connection-test"] [data-pending]').length
         const settled = document.querySelectorAll('[data-testid="connection-test"] [data-ok]').length
         return pending > 0 && settled > 0
       })()`,
      8_000,
    )
    check('测试过程逐条点亮（转圈与结果并存）', progressive, await js<string>(`document.querySelector('[data-testid="connection-test"]')?.innerText ?? '无结果'`))
    // 测试一通过就会自动保存并跳走，所以判据是「各步通过」或「已经进了主界面」（后者只在全部通过时发生）
    const tested = await waitFor(
      `document.querySelectorAll('[data-testid="connection-test"] [data-ok="true"]').length >= 4 || document.querySelector('[data-testid="page-title"]')?.textContent === '服务映射'`,
    )
    check('测试连接各步通过', tested, await js<string>(`document.querySelector('[data-testid="connection-test"]')?.innerText ?? '无结果'`))
    if (await js<boolean>(`document.querySelector('[data-testid="connection-test"]') !== null`)) await shot('v0.1-测试连接.png')

    // ④ 不用再点第二个按钮：测试通过后自动保存 → 凭据加密落盘 → 进入映射页
    const toMirror = await waitFor(`document.querySelector('[data-testid="page-title"]')?.textContent === '服务映射'`)
    check('一步测试并保存，进入服务映射', toMirror)
    // 保存时复用测试那次的 ID 解析：整个流程只查一次绿联云
    const lookups = (await smokeNasCounter('lookups')) - lookupsBefore
    check('保存时不重复查 UGREENlink ID', lookups === 1, `查询次数=${lookups}`)
    const disk = (() => {
      try {
        return readFileSync(join(ctx.userData, 'credentials.json'), 'utf8')
      } catch {
        return ''
      }
    })()
    check('凭据已加密落盘', disk.length > 0 && !/smoke-pass|smoke-user|smoke-nas-id/.test(disk))

    // ⑤ 服务卡片出现，本机端口真能访问到 NAS 上的应用
    const cards = await waitFor(`document.querySelectorAll('[data-testid="service-card"]').length === 4`, 15_000)
    check(
      '清单里的四个服务出现',
      cards,
      `visibility=${await js<string>('document.visibilityState')} 主进程快照服务数=${await js<number>('window.kura.mirror.snapshot().then(s => s?.services.length ?? -1)')} 卡片数=${await js<number>(`document.querySelectorAll('[data-testid="service-card"]').length`)}`,
    )
    const portA = Number(process.env.SMOKE_PORT_A)
    const viaMirror = await httpGet(`http://127.0.0.1:${portA}/`)
    check('本机端口转发到 NAS 应用', viaMirror.status === 200 && viaMirror.body.includes('fake openlist'), `${viaMirror.status} ${viaMirror.body.slice(0, 80)}`)
    await delay(3_500) // 等一轮快照刷新，卡片上的请求数跟上
    await shot('v0.1-服务映射.png')

    // ⑥ 关掉 openlist：端口真的释放
    await js(`document.querySelector('[data-service="openlist"] [role="switch"]')?.click()`)
    const off = await waitFor(`document.querySelector('[data-service="openlist"]')?.innerText.includes('已关闭')`)
    const afterOff = await httpGet(`http://127.0.0.1:${portA}/`)
    check(
      '关闭服务后端口释放',
      off && afterOff.status === 0,
      `界面=${off} 请求=${afterOff.status} 卡片=${JSON.stringify(await js<string>(`document.querySelector('[data-service="openlist"]')?.innerText.slice(0, 160) ?? '无'`))} 开关=${await js<string>(`document.querySelector('[data-service="openlist"] [role="switch"]')?.outerHTML.slice(0, 200) ?? '无'`)}`,
    )

    // ⑦ 概览
    await js(`document.querySelector('.sk-sidebar-item[aria-label="概览"]')?.click()`)
    check('概览页', await waitFor(`document.querySelector('.kura-stats') !== null`))
    await delay(500)
    await shot('v0.1-概览.png')

    // ⑦b v0.2 文件：经映射层的 WebDAV 列出 NAS 目录、进目录、新建文件夹
    const nav = (label: string) => js(`document.querySelector('.sk-sidebar-item[aria-label="${label}"]')?.click()`)
    await nav('文件')
    const listed = await waitFor(`document.querySelector('[data-testid="file-table"] tr[data-name="volume1"]') !== null`, 10_000)
    check('文件页列出 NAS 根目录', listed, await js<string>(`document.querySelector('.kura-files')?.innerText.slice(0, 200) ?? '无'`))
    await js(`[...document.querySelectorAll('[data-testid="file-table"] tr[data-name="volume1"] .kura-files__name')][0]?.click()`)
    const inVolume = await waitFor(`document.querySelector('[data-testid="file-table"] tr[data-name="docs"]') !== null`)
    check('进入子目录', inVolume)
    await clickButton('新建文件夹')
    await delay(200)
    await fill('名称', 'smoke-新建')
    await js(`document.querySelector('.kura-files__name-form button[type="submit"]')?.click()`)
    check('新建文件夹', await waitFor(`document.querySelector('[data-testid="file-table"] tr[data-name="smoke-新建"]') !== null`))
    await shot('v0.2-文件.png')

    // ⑦c v0.2 本机 WebDAV：只放行 /volume1/docs，外部程序直接发 HTTP 验证范围
    const dav = ctx.davUrl()
    const rootBefore = await httpSend('PROPFIND', dav, { depth: '1' })
    check('本机 WebDAV 可用', rootBefore.status === 207 && rootBefore.body.includes('/volume1/'), `${rootBefore.status}`)
    await js(`[...document.querySelectorAll('[role="tab"]')].find(t => t.textContent.includes('本机 WebDAV'))?.click()`)
    await waitFor(`document.querySelector('[data-testid="dav-include"]') !== null`)
    // 默认放行 /：先移除，再加 /volume1/docs，并排除一个不存在的子目录（验证排除列表能保存）
    await js(`document.querySelector('[data-testid="dav-include"] button[aria-label="移除 /"]')?.click()`)
    await fill('添加放行目录', '/volume1/docs')
    await js(`document.querySelector('[data-testid="dav-include"] .kura-rules__add button[type="submit"]')?.click()`)
    await fill('添加排除目录', '/volume1/docs/tmp')
    await js(`document.querySelector('[data-testid="dav-exclude"] .kura-rules__add button[type="submit"]')?.click()`)
    await delay(150)
    await clickButton('保存')
    await delay(800)
    const root = await httpSend('PROPFIND', dav, { depth: '1' })
    const v1 = await httpSend('PROPFIND', `${dav}volume1/`, { depth: '1' })
    const hidden = await httpGet(`${dav}volume1/private/secret.txt`)
    const allowed = await httpGet(`${dav}volume1/docs/readme.txt`)
    check(
      '暴露范围生效（外部 HTTP）',
      !root.body.includes('/home/') && v1.body.includes('/volume1/docs/') && !v1.body.includes('private') && hidden.status === 404 && allowed.body === 'hello from smoke nas',
      `root含home=${root.body.includes('/home/')} v1含private=${v1.body.includes('private')} secret=${hidden.status} readme=${allowed.status}`,
    )
    const saved = (() => {
      try {
        return JSON.parse(readFileSync(join(ctx.userData, 'webdav.json'), 'utf8')) as { include: string[]; exclude: string[] }
      } catch {
        return undefined
      }
    })()
    check('范围设置落盘', saved?.include.join() === '/volume1/docs' && saved?.exclude.join() === '/volume1/docs/tmp', JSON.stringify(saved))
    await fill('NAS 路径', '/volume1/private')
    await js(`[...document.querySelectorAll('.kura-dav .kura-rules__add button')].find(b => b.textContent.trim() === '检查')?.click()`)
    check('可见性自检', await waitFor(`document.querySelector('[data-testid="dav-probe"]')?.dataset.visibility === 'hidden'`))
    await shot('v0.2-本机WebDAV.png')

    // ⑦d v0.2 终端：**不需要任何凭据**（认的是映射层的网关会话）→ 直接开标签 → 键入回显
    await nav('终端')
    await waitFor(`document.querySelector('.kura-term') !== null`)
    const termReady = await waitFor(`[...document.querySelectorAll('button')].some(b => b.textContent.trim() === '打开终端' && !b.disabled)`, 10_000)
    check('终端无需凭据即可用', termReady, await js<string>(`document.querySelector('.kura-term')?.innerText.slice(0, 200) ?? ''`))
    await clickButton('打开终端')
    // 读 xterm 缓冲区（不是渲染出的 DOM：窗口不在前台时渲染帧被节流，DOM 会落后 —— 早先这条因此时好时坏）
    const termText = `document.querySelector('[data-testid="terminal-pane"]')?.kuraText?.() ?? ''`
    const prompt = await waitFor(`(${termText}).includes('smoke-nas:~#')`, 10_000)
    // 等 xterm 的输入框真的拿到焦点再按键：sendInputEvent 发给当前焦点，焦点不在就丢了
    await waitFor(`(() => { const ta = document.querySelector('[data-testid="terminal-pane"] textarea'); ta?.focus(); return document.activeElement === ta })()`)
    window.webContents.sendInputEvent({ type: 'char', keyCode: 'l' })
    window.webContents.sendInputEvent({ type: 'char', keyCode: 's' })
    const echoed = await waitFor(`(${termText}).includes('smoke-nas:~# ls')`)
    check('终端连接并回显输入', prompt && echoed, `prompt=${prompt} 缓冲区=${JSON.stringify(await js<string>(termText))}`)
    // resize 真的发出去了（服务端是真 PTY，尺寸不对会错位）；开标签后 xterm 首次 fit 就会发
    const resizeCount = await smokeNasCounter('terminalResize')
    check('终端发送窗口尺寸', resizeCount > 0, `resize 帧数=${resizeCount}`)
    // 终端页不再有凭据表单：整页不该出现输入框，也不该留独立凭据文件
    check('终端页没有凭据表单', await js<boolean>(`document.querySelectorAll('.kura-term input').length === 0`))
    await shot('v0.2-终端.png')

    // ⑦d2 切页不能把终端弄丢。Sakura 的 PageTransition 按 routeKey 记住子树，切页是**卸载重建** ——
    // 终端页原先放在它里面，于是切走再回来，标签列表和 xterm 回滚缓冲一起没掉，而主进程的 PTY 还活着
    // （界面显示「没有打开的终端」，其实会话还在）。现在终端常驻在页面之外、只 hidden。
    // 这条只有真实 UI 能验：单测里没有页面切换与 React 卸载。
    await nav('设置')
    await delay(200)
    await nav('终端')
    const keepPanes = await js<number>(`document.querySelectorAll('.xterm').length`)
    const keepBuffer = await js<string>(`document.querySelector('[data-testid="terminal-pane"]')?.kuraText?.() ?? ''`)
    check('切页后终端还在（标签与回滚缓冲都没丢）', keepPanes === 1 && keepBuffer.includes('smoke-nas:~# ls'), `面板数=${keepPanes} 缓冲区=${JSON.stringify(keepBuffer.slice(-80))}`)

    // 终端要填满页面：host 是 PageTransition 的兄弟节点，两边都 flex:1 的话各占一半、终端只有一半高
    const termLayout = await js<{ host: number; panes: number; main: number }>(
      `({ host: Math.round(document.querySelector('.kura-term-host').getBoundingClientRect().height),
          panes: Math.round(document.querySelector('.kura-term__panes').getBoundingClientRect().height),
          main: Math.round(document.querySelector('main').getBoundingClientRect().height) })`,
    )
    check('终端占满页面高度', termLayout.host >= termLayout.main - 160 && termLayout.panes > 0, JSON.stringify(termLayout))

    // ⑦e v0.3 模块页：能显示依赖检测结果（不在冒烟里真去下载 rclone）
    await nav('模块')
    check('模块页', await waitFor(`document.querySelector('[data-testid="module-rclone"] .kura-req') !== null`))
    await shot('v0.3-模块.png')

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
