import http, { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import {
  bearerToken,
  createMcpToken,
  handleMcpHttpRequest,
  handleMcpMessage,
  isLoopbackOrigin,
  mcpTokenMatches,
  missingArguments,
  negotiateProtocolVersion,
  toToolResult,
  type McpServerOptions,
  type McpTool,
} from './mcp.js'

const tool = (over: Partial<McpTool> = {}): McpTool => ({
  name: 'kura_test',
  title: '测试',
  description: '测试工具',
  inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
  handler: async (args) => ({ echo: args.path }),
  ...over,
})

/** 假工具表：一个成功、一个只读、一个抛错。 */
function options(over: Partial<McpServerOptions> = {}): McpServerOptions {
  return {
    tools: () => [
      tool(),
      tool({ name: 'kura_read', annotations: { readOnlyHint: true }, handler: async () => '文件内容' }),
      tool({ name: 'kura_boom', handler: async () => { throw new Error('上游 502') } }),
    ],
    serverInfo: { name: 'kura', title: 'Kura 蔵', version: '0.6.0' },
    instructions: '这是 Kura',
    ...over,
  }
}

const call = (method: string, params?: unknown, id: string | number = 1) =>
  handleMcpMessage({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) }, options())

describe('协议版本协商', () => {
  it('客户端报的版本在支持列表里就原样回', () => {
    for (const version of ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05']) {
      expect(negotiateProtocolVersion(version)).toBe(version)
    }
  })

  it('不认识 / 非字符串 → 回兜底版本（2025-06-18）', () => {
    expect(negotiateProtocolVersion('1999-01-01')).toBe('2025-06-18')
    expect(negotiateProtocolVersion(undefined)).toBe('2025-06-18')
    expect(negotiateProtocolVersion(42)).toBe('2025-06-18')
  })
})

describe('initialize', () => {
  it('只declare tools 能力，带上 serverInfo 与 instructions', async () => {
    const res = (await call('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'c', version: '1' } })) as {
      result: Record<string, unknown>
    }
    expect(res.result.protocolVersion).toBe('2025-06-18')
    expect(res.result.capabilities).toEqual({ tools: {} })
    expect(res.result.serverInfo).toEqual({ name: 'kura', title: 'Kura 蔵', version: '0.6.0' })
    expect(res.result.instructions).toBe('这是 Kura')
  })

  it('没写 instructions 时结果里就没有这个字段', async () => {
    const res = (await handleMcpMessage(
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } },
      options({ instructions: undefined }),
    )) as { result: Record<string, unknown> }
    expect('instructions' in res.result).toBe(false)
  })
})

describe('tools/list', () => {
  it('返回工具表，只读工具的 annotations 带过去', async () => {
    const res = (await call('tools/list')) as { result: { tools: Array<Record<string, unknown>> } }
    expect(res.result.tools.map((t) => t.name)).toEqual(['kura_test', 'kura_read', 'kura_boom'])
    expect(res.result.tools[0]).toMatchObject({ name: 'kura_test', title: '测试', description: '测试工具' })
    expect(res.result.tools[1]!.annotations).toEqual({ readOnlyHint: true })
    expect('annotations' in res.result.tools[0]!).toBe(false)
  })

  it('不分页：结果里没有 nextCursor', async () => {
    const res = (await call('tools/list')) as { result: Record<string, unknown> }
    expect('nextCursor' in res.result).toBe(false)
  })
})

describe('tools/call', () => {
  it('成功：对象序列化成缩进 JSON，字符串原样', async () => {
    const obj = (await call('tools/call', { name: 'kura_test', arguments: { path: '/volume1/a' } })) as {
      result: { content: Array<{ type: string; text: string }>; isError?: boolean }
    }
    expect(JSON.parse(obj.result.content[0]!.text)).toEqual({ echo: '/volume1/a' })
    expect(obj.result.isError).toBeUndefined()

    const text = (await call('tools/call', { name: 'kura_read', arguments: { path: '/x' } })) as {
      result: { content: Array<{ text: string }> }
    }
    // 文本不套 JSON 引号：读文件返回的就是文件原文
    expect(text.result.content[0]!.text).toBe('文件内容')
  })

  it('handler 抛错 → isError:true 的**结果**，不是 JSON-RPC 错误', async () => {
    const res = (await call('tools/call', { name: 'kura_boom', arguments: { path: '/x' } })) as {
      result?: { isError?: boolean; content: Array<{ text: string }> }
      error?: unknown
    }
    expect(res.error).toBeUndefined()
    expect(res.result?.isError).toBe(true)
    expect(res.result?.content[0]!.text).toContain('上游 502')
  })

  it('工具名不存在 → 协议错误 -32602', async () => {
    const res = (await call('tools/call', { name: 'kura_nope', arguments: {} })) as { error: { code: number } }
    expect(res.error.code).toBe(-32602)
  })

  it('缺必填参数 → 协议错误 -32602（不进 handler）', async () => {
    const res = (await call('tools/call', { name: 'kura_test', arguments: {} })) as { error: { code: number; message: string } }
    expect(res.error.code).toBe(-32602)
    expect(res.error.message).toContain('path')
  })

  it('参数类型不对 → -32602', async () => {
    const res = (await call('tools/call', { name: 'kura_test', arguments: { path: 123 } })) as { error: { code: number } }
    expect(res.error.code).toBe(-32602)
  })

  it('arguments 缺省时按空对象处理（然后报缺必填）', async () => {
    const res = (await call('tools/call', { name: 'kura_test' })) as { error: { code: number } }
    expect(res.error.code).toBe(-32602)
  })
})

describe('通知与杂项', () => {
  it('notifications/initialized 不回 body', async () => {
    expect(await handleMcpMessage({ jsonrpc: '2.0', method: 'notifications/initialized' }, options())).toBeUndefined()
  })

  it('没有 id 的请求也不回 body', async () => {
    expect(await handleMcpMessage({ jsonrpc: '2.0', method: 'tools/list' }, options())).toBeUndefined()
  })

  it('ping 回空结果', async () => {
    expect(await call('ping')).toEqual({ jsonrpc: '2.0', id: 1, result: {} })
  })

  it('不认识的方法 → -32601', async () => {
    const res = (await call('resources/list')) as { error: { code: number } }
    expect(res.error.code).toBe(-32601)
  })

  it('批处理 / 非法消息 → -32600', async () => {
    expect((await handleMcpMessage([{ jsonrpc: '2.0', id: 1, method: 'ping' }], options())) as { error: { code: number } }).toMatchObject({
      error: { code: -32600 },
    })
    const bad = (await handleMcpMessage({ jsonrpc: '1.0', id: 1, method: 'ping' }, options())) as { error: { code: number } }
    expect(bad.error.code).toBe(-32600)
  })
})

describe('工具返回值与参数检查', () => {
  it('toToolResult：对象 → 缩进 JSON，undefined → 「完成」', () => {
    expect(toToolResult({ a: 1 }).content[0]!.text).toBe('{\n  "a": 1\n}')
    expect(toToolResult(undefined).content[0]!.text).toBe('完成')
  })

  it('missingArguments：integer 类型接受 number', () => {
    const schema = { type: 'object', properties: { n: { type: 'integer' } }, required: ['n'] }
    expect(missingArguments(schema, { n: 3 })).toEqual([])
  })
})

describe('令牌与来源', () => {
  it('令牌是 43 字符 base64url（256 位）', () => {
    const token = createMcpToken()
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(createMcpToken()).not.toBe(token)
  })

  it('恒定时间比对：空、长度不同、内容差一点都否', () => {
    const token = createMcpToken()
    expect(mcpTokenMatches(token, token)).toBe(true)
    expect(mcpTokenMatches(token, token.slice(0, -1))).toBe(false)
    expect(mcpTokenMatches(token, createMcpToken())).toBe(false)
    expect(mcpTokenMatches(token, undefined)).toBe(false)
    expect(mcpTokenMatches('', token)).toBe(false)
  })

  it('bearerToken 解析', () => {
    expect(bearerToken('Bearer abc')).toBe('abc')
    expect(bearerToken('bearer  abc ')).toBe('abc')
    expect(bearerToken(undefined)).toBeUndefined()
    expect(bearerToken('Basic abc')).toBeUndefined()
  })

  it('回环 Origin 判定：只有 127.x / localhost / ::1 算本机', () => {
    expect(isLoopbackOrigin('http://127.0.0.1:18007')).toBe(true)
    expect(isLoopbackOrigin('http://localhost')).toBe(true)
    expect(isLoopbackOrigin('http://127.1.2.3')).toBe(true)
    expect(isLoopbackOrigin('https://evil.example')).toBe(false)
    expect(isLoopbackOrigin('null')).toBe(false)
    // 把回环写进路径里骗不过去（hostname 必须是回环）
    expect(isLoopbackOrigin('http://evil.example/127.0.0.1')).toBe(false)
  })
})

describe('HTTP 层', () => {
  let server: http.Server | undefined

  afterEach(async () => {
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()))
    server = undefined
  })

  /** 起一个真的回环监听，跑完整 HTTP 路径（Origin/Host/令牌都在这一层）。 */
  async function serve(token = 'tok'): Promise<string> {
    server = createServer((req, res) => {
      void handleMcpHttpRequest(req, res, { ...options(), token: () => token })
    })
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve))
    return `http://127.0.0.1:${(server!.address() as AddressInfo).port}/mcp`
  }

  async function send(
    url: string,
    init: { method?: string; headers?: Record<string, string>; body?: string } = {},
  ): Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }> {
    return new Promise((resolve, reject) => {
      const req = http.request(url, { method: init.method ?? 'POST', headers: init.headers }, (res) => {
        let text = ''
        res.on('data', (c) => (text += c))
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: text, headers: res.headers }))
      })
      req.on('error', reject)
      req.end(init.body)
    })
  }

  const auth = { authorization: 'Bearer tok', 'content-type': 'application/json' }

  it('POST 请求 → 200 + application/json', async () => {
    const url = await serve()
    const res = await send(url, { headers: auth, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }) })
    expect(res.status).toBe(200)
    expect(res.headers['content-type']).toContain('application/json')
    expect(JSON.parse(res.body)).toEqual({ jsonrpc: '2.0', id: 1, result: {} })
  })

  it('POST 通知 → 202 且无 body', async () => {
    const url = await serve()
    const res = await send(url, { headers: auth, body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) })
    expect(res.status).toBe(202)
    expect(res.body).toBe('')
  })

  it('GET → 405（客户端据此判定「没有 SSE 流」）', async () => {
    const url = await serve()
    const res = await send(url, { method: 'GET', headers: { authorization: 'Bearer tok' } })
    expect(res.status).toBe(405)
    expect(res.headers.allow).toBe('POST')
  })

  it('DELETE → 405（不做会话）', async () => {
    const url = await serve()
    expect((await send(url, { method: 'DELETE', headers: auth })).status).toBe(405)
  })

  it('令牌不对 / 缺失 → 401', async () => {
    const url = await serve()
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' })
    expect((await send(url, { headers: auth, body })).status).toBe(200)
    expect((await send(url, { headers: { ...auth, authorization: 'Bearer wrong' }, body })).status).toBe(401)
    expect((await send(url, { headers: { 'content-type': 'application/json' }, body })).status).toBe(401)
  })

  it('Origin 非本机 → 403；没有 Origin 放行', async () => {
    const url = await serve()
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' })
    expect((await send(url, { headers: { ...auth, origin: 'https://evil.example' }, body })).status).toBe(403)
    expect((await send(url, { headers: { ...auth, origin: 'http://127.0.0.1:3000' }, body })).status).toBe(200)
  })

  it('Host 非本机 → 403（防 DNS 重绑定）', async () => {
    const url = await serve()
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' })
    const res = await send(url, { headers: { ...auth, host: 'evil.example' }, body })
    expect(res.status).toBe(403)
  })

  it('请求体不是 JSON → 400（-32700）', async () => {
    const url = await serve()
    const res = await send(url, { headers: auth, body: 'not json' })
    expect(res.status).toBe(400)
    expect(JSON.parse(res.body).error.code).toBe(-32700)
  })

  it('不认识的 MCP-Protocol-Version → 400', async () => {
    const url = await serve()
    const res = await send(url, {
      headers: { ...auth, 'mcp-protocol-version': '1999-01-01' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
    })
    expect(res.status).toBe(400)
  })

  it('认识的 MCP-Protocol-Version 放行', async () => {
    const url = await serve()
    const res = await send(url, {
      headers: { ...auth, 'mcp-protocol-version': '2025-06-18' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
    })
    expect(res.status).toBe(200)
  })

  it('令牌轮换后：旧令牌 401，新令牌放行', async () => {
    let current = 'first'
    server = createServer((req, res) => void handleMcpHttpRequest(req, res, { ...options(), token: () => current }))
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve))
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' })
    expect((await send(url, { headers: { ...auth, authorization: 'Bearer first' }, body })).status).toBe(200)
    current = 'second'
    expect((await send(url, { headers: { ...auth, authorization: 'Bearer first' }, body })).status).toBe(401)
    expect((await send(url, { headers: { ...auth, authorization: 'Bearer second' }, body })).status).toBe(200)
  })
})
