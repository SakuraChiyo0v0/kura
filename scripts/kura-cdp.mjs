// 临时脚本（用完即删）：连 Kura 渲染进程的 CDP，执行一段表达式并打印结果。
// 用法：node scripts/kura-cdp.mjs '<js 表达式>'   —— 表达式在渲染进程里 eval，结果 JSON 化打印。
import { WebSocket } from 'ws'

// 加超时：Kura 没开 / CDP 端口没监听时，fetch 会一直挂着
const targets = await (await fetch('http://127.0.0.1:9222/json/list', { signal: AbortSignal.timeout(5_000) })).json()
const page = targets.find((t) => t.type === 'page')
if (!page) throw new Error('没有 page 目标')
const ws = new WebSocket(page.webSocketDebuggerUrl, { maxPayload: 64 * 1024 * 1024 })
let id = 0
const pending = new Map()
const fail = (error) => {
  // 连接断了 / 连不上：把在途的请求全部 reject，别让调用方永远挂着
  for (const entry of pending.values()) entry.reject(error)
  pending.clear()
}
ws.on('message', (d) => {
  const msg = JSON.parse(d.toString())
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id).resolve(msg); pending.delete(msg.id) }
})
// 没有 error / close 监听的话，连不上时 'error' 事件会变成未捕获异常直接崩；
// 连接中途断了，在途的 Promise 也永远不会 settle。
ws.on('error', (error) => fail(error))
ws.on('close', () => fail(new Error('CDP 连接已关闭')))
await new Promise((resolve, reject) => {
  ws.on('open', resolve)
  ws.on('error', reject)
})
const send = (method, params) => {
  const i = ++id
  return new Promise((resolve, reject) => {
    // 加超时：CDP 不回（页面卡住、被节流）时不会永远挂着
    const timer = setTimeout(() => { pending.delete(i); reject(new Error(`CDP 超时：${method}`)) }, 30_000)
    pending.set(i, { resolve: (msg) => { clearTimeout(timer); resolve(msg) }, reject: (error) => { clearTimeout(timer); reject(error) } })
    ws.send(JSON.stringify({ id: i, method, params }), (error) => { if (error) { clearTimeout(timer); pending.delete(i); reject(error) } })
  })
}

const expr = process.argv[2] ?? 'document.title'
const res = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
if (res.result?.exceptionDetails) console.log('异常:', JSON.stringify(res.result.exceptionDetails).slice(0, 400))
else console.log(typeof res.result?.result?.value === 'string' ? res.result.result.value : JSON.stringify(res.result?.result?.value, null, 1))
ws.close()
process.exit(0)
