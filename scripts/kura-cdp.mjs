// 临时脚本（用完即删）：连 Kura 渲染进程的 CDP，执行一段表达式并打印结果。
// 用法：node scripts/kura-cdp.mjs '<js 表达式>'   —— 表达式在渲染进程里 eval，结果 JSON 化打印。
import { WebSocket } from 'ws'

const targets = await (await fetch('http://127.0.0.1:9222/json/list')).json()
const page = targets.find((t) => t.type === 'page')
if (!page) throw new Error('没有 page 目标')
const ws = new WebSocket(page.webSocketDebuggerUrl, { maxPayload: 64 * 1024 * 1024 })
let id = 0
const pending = new Map()
ws.on('message', (d) => {
  const msg = JSON.parse(d.toString())
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id) }
})
await new Promise((r) => ws.on('open', r))
const send = (method, params) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })) })

const expr = process.argv[2] ?? 'document.title'
const res = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
if (res.result?.exceptionDetails) console.log('异常:', JSON.stringify(res.result.exceptionDetails).slice(0, 400))
else console.log(typeof res.result?.result?.value === 'string' ? res.result.result.value : JSON.stringify(res.result?.result?.value, null, 1))
ws.close()
process.exit(0)
