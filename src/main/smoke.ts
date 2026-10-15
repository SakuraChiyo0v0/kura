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
    // 主进程同步完成后，界面在 1 秒内（远小于 3 秒轮询）就该反映出来。
    // 从「主进程说 ready」那一刻计时：主进程推送前有 150ms 合并窗口，查 snapshot 本身还要一次 IPC 往返，
    // 而 waitUntil 每 100ms 才看一次 —— 机器忙时（8 次里 1 次）卡在 1 秒边上。判据是「远小于 3 秒」，给 1.5 秒
    const pushed = await waitUntil(js, `document.querySelector('.kura-section__foot')?.textContent.includes('秒前') ?? false`, 1_500)
    check('清单到达后界面立即更新（推送）', synced && pushed, `syncingShown=${syncingShown} synced=${synced} pushed=${pushed}`)
    check('启动到窗口可用的耗时', openedMs < 8_000, `${openedMs}ms`)

    // 冒烟脚本在两轮之间把 lastSeenVersion 改成了 0.0.1：这一轮等于「升级后第一次打开」
    const version = await js<string>(`window.kura.appInfo().then((i) => i.version)`)
    const shown = await waitUntil(js, `document.querySelector('.kura-whats-new .kura-changelog__entry') !== null`, 5_000)
    const title = await js<string>(`document.querySelector('.kura-whats-new .sk-dialog-title')?.textContent ?? ''`)
    check('升级后弹「本次更新内容」', shown && title.includes(version), title)
    await js(`[...document.querySelectorAll('.kura-whats-new button')].find((b) => b.textContent === '知道了')?.click()`)
    const seen = await waitUntil(js, `window.__SAKURA_SETTINGS__.get().then((s) => s.lastSeenVersion === ${JSON.stringify(version)})`, 3_000)
    const closed = await waitUntil(js, `document.querySelector('.kura-whats-new') === null`, 3_000)
    check('关掉后记下当前版本，不再弹', seen && closed, `seen=${seen} closed=${closed}`)
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
    const cards = await waitFor(`document.querySelectorAll('[data-testid="service-card"]').length === 5`, 15_000)
    check(
      '清单里的五个服务出现',
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

    // ⑦c v0.2 本机 WebDAV：范围现在由 NAS 那份统一管，改范围 → 外部 HTTP 验证
    const dav = ctx.davUrl()
    const rootBefore = await httpSend('PROPFIND', dav, { depth: '1' })
    check('本机 WebDAV 可用', rootBefore.status === 207 && rootBefore.body.includes('/volume1/'), `${rootBefore.status}`)
    await js(`[...document.querySelectorAll('[role="tab"]')].find(t => t.textContent.includes('本机 WebDAV'))?.click()`)
    await waitFor(`document.querySelector('[data-testid="scope-include"]') !== null`)
    // 默认放行 /：先移除，再加 /volume1/docs，并排除一个不存在的子目录（验证排除列表能保存）
    await js(`document.querySelector('[data-testid="scope-include"] button[aria-label="移除 /"]')?.click()`)
    await fill('添加放行目录', '/volume1/docs')
    await js(`document.querySelector('[data-testid="scope-include"] .kura-rules__add button[type="submit"]')?.click()`)
    await fill('添加排除目录', '/volume1/docs/tmp')
    await js(`document.querySelector('[data-testid="scope-exclude"] .kura-rules__add button[type="submit"]')?.click()`)
    await delay(150)
    await js(`document.querySelector('[data-testid="scope-save"]')?.click()`)
    await delay(900)
    // 范围是**整体替换**：删掉的 / 必须真的没了（合并式实现这里会失败）
    const scopeAfter = await js<{ include: string[]; exclude: string[] }>(`window.kura.nasScope.get().then(s => ({ include: s.include, exclude: s.exclude }))`)
    check('范围保存是整体替换（删掉的条目真的没了）', scopeAfter.include.join() === '/volume1/docs' && scopeAfter.exclude.join() === '/volume1/docs/tmp', JSON.stringify(scopeAfter))
    const root = await httpSend('PROPFIND', dav, { depth: '1' })
    const v1 = await httpSend('PROPFIND', `${dav}volume1/`, { depth: '1' })
    const hidden = await httpGet(`${dav}volume1/private/secret.txt`)
    const allowed = await httpGet(`${dav}volume1/docs/readme.txt`)
    check(
      '暴露范围生效（外部 HTTP）',
      !root.body.includes('/home/') && v1.body.includes('/volume1/docs/') && !v1.body.includes('private') && hidden.status === 404 && allowed.body === 'hello from smoke nas',
      `root含home=${root.body.includes('/home/')} v1含private=${v1.body.includes('private')} secret=${hidden.status} readme=${allowed.status}`,
    )
    await fill('NAS 路径', '/volume1/private')
    await js(`[...document.querySelectorAll('.kura-dav .kura-rules__add button')].find(b => b.textContent.trim() === '检查')?.click()`)
    check('可见性自检', await waitFor(`document.querySelector('[data-testid="scope-probe"]')?.dataset.visibility === 'hidden'`))
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

    // ⑦d3 容器管理：项目列表 → Kura 自己只读 → 重启项目，输出实时出现、结束后状态刷新 → 容器详情（密码遮住）与日志
    await nav('容器')
    const projectsShown = await waitFor(`document.querySelector('[data-testid="project-list"] [data-project="openlist"]') !== null`, 10_000)
    const selfReadOnly = await js<boolean>(
      `(() => { const li = document.querySelector('[data-project="kura-server"]'); return Boolean(li) && li.innerText.includes('只读') && ![...li.querySelectorAll('button')].some(b => b.textContent.trim() === '重启') })()`,
    )
    check('容器页：项目列表，Kura 自己只读', projectsShown && selfReadOnly, `projects=${projectsShown} selfReadOnly=${selfReadOnly}`)
    // 和服务映射互链：openlist 在映射页被关掉了（⑥），所以这里不该给它的本机地址；重新打开后应该出现
    const hiddenWhenOff = await js<boolean>(`!document.querySelector('[data-project="openlist"] [data-testid="project-mapped"]')`)
    await js(`window.kura.mirror.setEnabled('openlist', true)`)
    const linked = await waitFor(`document.querySelector('[data-project="openlist"] [data-testid="project-mapped"]')?.textContent.includes('127.0.0.1:${process.env.SMOKE_PORT_A}')`, 8_000)
    check('容器页：项目链到服务映射的本机地址（映射关着时不给）', hiddenWhenOff && linked, `hiddenWhenOff=${hiddenWhenOff} linked=${linked}`)
    await js(`[...document.querySelectorAll('[data-project="openlist"] button')].find(b => b.textContent.trim() === '重启')?.click()`)
    const outputDone = await waitFor(`document.querySelector('[data-testid="docker-output"]')?.dataset.state === 'ok' && document.querySelector('[data-testid="docker-output"] pre')?.textContent.includes('Started')`, 10_000)
    check('项目操作：输出实时显示并以成功结束', outputDone, await js<string>(`document.querySelector('[data-testid="docker-output"]')?.innerText.slice(0, 200) ?? '没有输出面板'`))
    await js(`[...document.querySelectorAll('[data-project="openlist"] .kura-docker-members button')][0]?.click()`)
    const drawer = await waitFor(`document.querySelector('[data-testid="container-drawer"]')?.innerText.includes('ADMIN_PASSWORD') && document.querySelector('[data-testid="container-logs"]')?.textContent.includes('openlist started')`, 10_000)
    const masked = await js<boolean>(`document.querySelector('[data-testid="container-drawer"]')?.innerText.includes('已隐藏') ?? false`)
    check('容器详情：环境变量里的密码遮住、实时日志在跑', drawer && masked, await js<string>(`document.querySelector('[data-testid="container-drawer"]')?.innerText.slice(0, 300) ?? '没有详情'`))

    // ⑦d3b 进容器 shell：点「连接 shell」→ 出提示符 → 键入回显
    await clickButton('连接 shell')
    const shellText = `document.querySelector('[data-testid="container-shell"]')?.kuraText?.() ?? ''`
    const shellPrompt = await waitFor(`(${shellText}).includes('/opt/openlist #')`, 8_000)
    await waitFor(`(() => { const ta = document.querySelector('[data-testid="container-shell"] textarea'); ta?.focus(); return document.activeElement === ta })()`)
    window.webContents.sendInputEvent({ type: 'char', keyCode: 'p' })
    window.webContents.sendInputEvent({ type: 'char', keyCode: 'w' })
    window.webContents.sendInputEvent({ type: 'char', keyCode: 'd' })
    const shellEcho = await waitFor(`(${shellText}).includes('/opt/openlist # pwd')`)
    check('进容器 shell：连上并回显输入', shellPrompt && shellEcho, `prompt=${shellPrompt} 缓冲区=${JSON.stringify(await js<string>(shellText))}`)
    await js(`document.querySelector('[data-testid="container-shell"]')?.scrollIntoView()`)
    await shot('v0.4-容器shell.png')
    await clickButton('断开')

    // ⑦d3c 检查更新：openlist 的镜像有新版 → 项目上出「有更新」
    await js(`document.querySelector('[data-testid="container-drawer"] button[aria-label="关闭详情"]')?.click()`)
    await clickButton('检查更新')
    const updateBadge = await waitFor(`document.querySelector('[data-project="openlist"] [data-testid="project-update"]') !== null && document.querySelector('[data-project="kura-server"] [data-testid="project-update"]') === null`, 8_000)
    check('检查更新：有新版的项目出标记，Kura 自己不查', updateBadge)
    await js(`document.querySelector('[data-project="openlist"]')?.scrollIntoView({ block: 'center' })`)
    await shot('v0.4-检查更新.png')

    // ⑦d3d 卷与网络（只读）
    await js(`[...document.querySelectorAll('[role="tab"]')].find(t => t.textContent.trim() === '卷')?.click()`)
    const volumes = await waitFor(`document.body.innerText.includes('old-cache') && document.body.innerText.includes('1 个没有容器在用')`, 8_000)
    await clickButton('计算占用')
    const sized = await waitFor(`document.body.innerText.includes('1.2 MiB')`, 8_000)
    await js(`[...document.querySelectorAll('[role="tab"]')].find(t => t.textContent.trim() === '网络')?.click()`)
    const networks = await waitFor(`document.querySelector('[data-testid="network-list"] [data-network="sso-net"]')?.innerText.includes('172.20.0.3')`, 8_000)
    check('卷与网络：列表、谁在用、点了才算占用、网络成员', volumes && sized && networks, `volumes=${volumes} sized=${sized} networks=${networks}`)
    await js(`[...document.querySelectorAll('[role="tab"]')].find(t => t.textContent.trim().startsWith('项目'))?.click()`)
    await waitFor(`document.querySelector('[data-project="openlist"]') !== null`)
    await shot('v0.4-容器.png')

    // ⑦d4 编辑 compose：改坏了存不进去且原因写清；改好了先看改动、再保存；进审计
    await js(`document.querySelector('[data-testid="container-drawer"] button[aria-label="关闭详情"]')?.click()`)
    await js(`[...document.querySelectorAll('[data-project="openlist"] button')].find(b => b.textContent.trim() === '编辑')?.click()`)
    const editorOpen = await waitFor(`document.querySelector('[data-testid="project-editor"] textarea')?.value.includes('openlistteam/openlist')`, 8_000)
    const setEditor = (value: string) =>
      js(`(() => {
        const ta = document.querySelector('[data-testid="project-editor"] textarea')
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(ta, ${JSON.stringify(value)})
        ta.dispatchEvent(new Event('input', { bubbles: true }))
      })()`)
    // 打开改动预览 → 关掉「保存后应用」（冒烟只验文件这一步；开关是原生 checkbox，看 .checked）→ 点保存。
    // 按钮文字随开关变（「保存并应用」/「保存」），所以按 data-testid 找，不按文字
    const reviewAndSave = async () => {
      await clickButton('查看改动并保存')
      await waitFor(`document.querySelector('[data-testid="editor-review"]') !== null`)
      await js(`(() => { const s = document.querySelector('[data-testid="editor-review"] input[role="switch"]'); if (s?.checked) s.click() })()`)
      await waitFor(`document.querySelector('[data-testid="editor-save"]')?.textContent.trim() === '保存'`, 2_000)
      await js(`document.querySelector('[data-testid="editor-save"]')?.click()`)
    }
    await setEditor('oops: [')
    await reviewAndSave()
    const rejected = await waitFor(`document.querySelector('[data-testid="editor-error"]')?.textContent.includes('services must be a mapping')`)
    await setEditor('services:\n  openlist:\n    image: openlistteam/openlist:v4.2.7\n    restart: unless-stopped\n')
    await clickButton('查看改动并保存')
    const diffShown = await waitFor(`document.querySelector('[data-testid="editor-review"] [data-kind="add"]')?.textContent.includes('v4.2.7')`)
    await clickButton('接着改')
    await reviewAndSave()
    const saved = await waitFor(`!document.querySelector('[data-testid="editor-review"]') && !document.querySelector('[data-testid="project-editor"]')?.innerText.includes('有未保存的改动')`)
    check('编辑 compose：坏的被拒并说清原因、保存前能看改动、好的存上', editorOpen && rejected && diffShown && saved, `open=${editorOpen} rejected=${rejected} diff=${diffShown} saved=${saved}`)
    await shot('v0.4-编辑项目.png')
    await js(`document.querySelector('[data-testid="project-editor"] button[aria-label="关闭编辑"]')?.click()`)

    // ⑦e v0.3 模块页：能显示依赖检测结果（不在冒烟里真去下载 rclone）
    await nav('模块')
    check('模块页', await waitFor(`document.querySelector('[data-testid="module-rclone"] .kura-req') !== null`))
    // 挂载形态三选一：切到「挂到文件夹」应换成父目录输入，且不再显示盘符/卷名
    const seg = `[data-testid="module-rclone"] .sk-segmented`
    const segReady = await waitFor(`document.querySelectorAll('${seg} input[type="radio"]').length === 3`)
    const pickMode = (mode: string) => js(`(() => { const i = document.querySelector('${seg} input[value="${mode}"]'); i?.click(); return !!i })()`)
    await pickMode('folder')
    const folderMode = await waitFor(
      `document.querySelector('[data-testid="module-rclone"]')?.innerText.includes('父目录') && !document.querySelector('[data-testid="module-rclone"]')?.innerText.includes('卷名')`,
    )
    await pickMode('network')
    const netMode = await waitFor(`document.querySelector('${seg} input[value="network"]')?.checked === true`)
    await pickMode('disk')
    const diskMode = await waitFor(`document.querySelector('[data-testid="module-rclone"]')?.innerText.includes('卷名')`)
    check('挂载形态可切换：硬盘 / 网络位置 / 文件夹', segReady && folderMode && netMode && diskMode, `seg=${segReady} folder=${folderMode} net=${netMode} disk=${diskMode}`)
    await shot('v0.3-模块.png')

    // ⑦f v0.5 关于与更新：版本号、本版本更新内容（读的是打进包里的 CHANGELOG）。
    // 冒烟不接更新源，所以不该出现检查更新的提示条；刚走完引导的新用户也不该弹「本次更新内容」
    await nav('设置')
    const version = await js<string>(`window.kura.appInfo().then((i) => i.version)`)
    const about = await waitFor(
      `document.querySelector('[data-testid="app-version"]')?.textContent === ${JSON.stringify(version)} && document.querySelectorAll('[data-testid="updates-section"] .kura-changelog__entry').length === 1`,
    )
    check('设置页显示版本与本版本更新内容', about, await js<string>(`document.querySelector('[data-testid="updates-section"]')?.innerText.slice(0, 200) ?? '无'`))
    check('冒烟不接更新源', (await js<number>(`document.querySelectorAll('.sk-el-update-banner').length`)) === 0)
    check('新用户不弹「本次更新内容」', (await js<number>(`document.querySelectorAll('.kura-whats-new').length`)) === 0)
    await shot('v0.5-关于与更新.png')

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
