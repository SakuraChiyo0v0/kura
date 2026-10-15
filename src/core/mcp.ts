import { randomBytes, timingSafeEqual } from 'node:crypto'
import type http from 'node:http'
import { isLoopbackHost } from './dav-server.js'
import { errorMessage } from './errors.js'
import { silentLogger, type Logger } from './log.js'

/**
 * Kura 的 MCP 服务器（Model Context Protocol）：让 AI 客户端（Claude Code / Claude Desktop）连上来操作 NAS。
 *
 * 这个文件**只有协议**，不认识文件、容器、映射那些东西：工具由调用方（`src/main/mcp-tools.ts`）
 * 以闭包形式传进来，所以这里可以拿假工具直接单测。
 *
 * 传输用 Streamable HTTP，但**只实现 JSON**，不实现 SSE：
 * 官方 SDK 客户端把 GET 返回 405 当作「服务端不提供 SSE 流」的合法响应
 * （`@modelcontextprotocol/sdk` 的 client/streamableHttp.js），POST 回 application/json 也照收。
 * 因此这里不需要维护长连接，请求/响应一一对应就够了 —— Kura 的工具都是短操作，用不上流式推送。
 *
 * 安全（三条都必需，见 AGENTS.md 与 docs/交接.md 的边界）：
 *   1. 只听回环 —— 监听交给 `ServiceListener`（构造时 `assertLoopback`）；
 *   2. Host 与 Origin 双校验 —— 防 DNS 重绑定（浏览器里的恶意页面把域名解析到 127.0.0.1 再来读）；
 *   3. Bearer 令牌 —— 别让本机上别的程序顺手连上。默认关闭，由用户在设置里开。
 */

/** 能接受的协议版本。客户端报的版本在这里面就原样回，否则回 `mcpFallbackVersion`。 */
export const mcpSupportedVersions = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'] as const

/**
 * 协商不上时回的版本。规范要求「回服务端支持的最新版」，这里却**特意回 2025-06-18**：
 * 声明的能力只有 `tools` 一项，而这几个版本里 tools 的字段形状（name/title/description/
 * inputSchema/annotations、content/isError）没有差别，回一个客户端普遍认识的老版本最不容易出岔子。
 */
export const mcpFallbackVersion = '2025-06-18'

/** 请求体上限：工具参数都是路径、id、短文本，4 MiB 足够，防止一条请求把内存吃光。 */
export const mcpMaxBodyBytes = 4 * 1024 * 1024

export interface McpAnnotations {
  title?: string
  /** 只读：不改任何东西 */
  readOnlyHint?: boolean
  /** 会删东西（区别于「只是改」）：客户端应当特别提示用户 */
  destructiveHint?: boolean
  /** 同样的参数重复调，结果一样 */
  idempotentHint?: boolean
  /** 会碰外部世界（本方案里都碰 NAS，所以不逐个标） */
  openWorldHint?: boolean
}

/** 一个工具。handler 抛错 = 执行失败（回 isError），不是协议错误。 */
export interface McpTool {
  name: string
  title: string
  description: string
  /** JSON Schema（type: object） */
  inputSchema: Record<string, unknown>
  annotations?: McpAnnotations
  handler: (args: Record<string, unknown>) => Promise<unknown>
}

export interface McpServerOptions {
  tools: () => McpTool[]
  serverInfo: { name: string; title: string; version: string }
  /** 给客户端的说明（会进模型上下文），写清这是什么、路径长什么样、改动落在哪 */
  instructions?: string
  log?: Logger
}

// ---------------------------------------------------------------- 令牌

/** 生成接入令牌：256 位随机，base64url。 */
export function createMcpToken(): string {
  return randomBytes(32).toString('base64url')
}

/** 恒定时间比对，长度不同直接否（`timingSafeEqual` 长度不等会抛）。 */
export function mcpTokenMatches(expected: string, given: string | undefined): boolean {
  if (!expected || !given) return false
  const a = Buffer.from(expected)
  const b = Buffer.from(given)
  return a.length === b.length && timingSafeEqual(a, b)
}

/** 从 `Authorization: Bearer xxx` 取出令牌。 */
export function bearerToken(header: string | undefined): string | undefined {
  return /^Bearer\s+(.+)$/i.exec(header ?? '')?.[1]?.trim()
}

// ---------------------------------------------------------------- 来源校验

/**
 * Origin 是不是本机。**只在 Origin 头存在时判**：命令行客户端（Claude Code）不发 Origin，
 * 浏览器一定发 —— 所以这条正好只用来挡浏览器，不会误伤正经客户端。
 * `new URL` 解析不了（含 "null" 这种沙箱来源）一律算不合法。
 */
export function isLoopbackOrigin(origin: string): boolean {
  try {
    return isLoopbackHost(new URL(origin).hostname)
  } catch {
    return false
  }
}

/** 客户端报的协议版本 → 回给它的版本。 */
export function negotiateProtocolVersion(requested: unknown): string {
  const version = typeof requested === 'string' ? requested : ''
  return (mcpSupportedVersions as readonly string[]).includes(version) ? version : mcpFallbackVersion
}

// ---------------------------------------------------------------- JSON-RPC

type RpcId = string | number | null

function rpcResult(id: RpcId, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id, result }
}

function rpcError(id: RpcId, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id, error: { code, message } }
}

interface McpContent {
  type: 'text'
  text: string
}

/**
 * 工具返回值 → MCP 的 content。字符串原样当文本（读文件就是这条，别套上 JSON 引号），
 * 其余序列化成缩进 JSON（模型读起来比压缩的一行长）。
 */
export function toToolResult(value: unknown): { content: McpContent[] } {
  const text = typeof value === 'string' ? value : value === undefined || value === null ? '完成' : JSON.stringify(value, null, 2)
  return { content: [{ type: 'text', text }] }
}

/**
 * 按 inputSchema 里声明的 `required` 与基本类型查一遍。
 * **只做这一层**：完整 JSON Schema 校验要引一个校验器，而参数最终由各服务的 handler 把关
 * （范围、路径合法这些都在下游），这里的目的只是「明显缺参数」时回协议错误而不是执行错误。
 */
export function missingArguments(inputSchema: Record<string, unknown>, args: Record<string, unknown>): string[] {
  const required = Array.isArray(inputSchema.required) ? inputSchema.required : []
  const properties = (inputSchema.properties ?? {}) as Record<string, { type?: string }>
  const problems: string[] = []
  for (const key of required) {
    if (typeof key !== 'string') continue
    if (args[key] === undefined || args[key] === null) {
      problems.push(`缺少必填参数 ${key}`)
      continue
    }
    const expected = properties[key]?.type
    const value = args[key]
    const actual = Array.isArray(value) ? 'array' : typeof value === 'number' ? 'number' : typeof value
    if (expected && expected !== actual && !(expected === 'integer' && actual === 'number')) {
      problems.push(`参数 ${key} 应该是 ${expected}，收到 ${actual}`)
    }
  }
  return problems
}

/**
 * 处理一条 JSON-RPC 消息。返回 `undefined` = 这是通知（或响应），按规范回 202 无 body。
 */
export async function handleMcpMessage(message: unknown, options: McpServerOptions): Promise<Record<string, unknown> | undefined> {
  const log = options.log ?? silentLogger
  if (typeof message !== 'object' || message === null || Array.isArray(message)) {
    // 不支持批处理：JSON-RPC 的 batch 在 2025-06-18 已从规范移除，现代客户端不发
    return rpcError(null, -32600, '不是合法的 JSON-RPC 消息')
  }
  const msg = message as { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown }
  const hasId = typeof msg.id === 'string' || typeof msg.id === 'number'
  const id: RpcId = hasId ? (msg.id as RpcId) : null
  if (msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
    // 没有 id 的坏消息没法回错误（回过去也配不上号），丢掉即可
    return hasId ? rpcError(id, -32600, '不是合法的 JSON-RPC 请求') : undefined
  }
  const method = msg.method
  const params = (typeof msg.params === 'object' && msg.params !== null ? msg.params : {}) as Record<string, unknown>

  // 通知：处理完不回 body。initialized 是握手第三步，收到就算握手完成
  if (method.startsWith('notifications/')) return undefined
  if (!hasId) {
    log.warn('MCP 收到没有 id 的请求，按通知处理', { method })
    return undefined
  }

  switch (method) {
    case 'initialize':
      return rpcResult(id, {
        protocolVersion: negotiateProtocolVersion(params.protocolVersion),
        // 不declare listChanged：工具表是固定的，不会中途变
        capabilities: { tools: {} },
        serverInfo: options.serverInfo,
        ...(options.instructions ? { instructions: options.instructions } : {}),
      })

    case 'ping':
      return rpcResult(id, {})

    case 'tools/list':
      return rpcResult(id, {
        tools: options.tools().map((tool) => ({
          name: tool.name,
          title: tool.title,
          description: tool.description,
          inputSchema: tool.inputSchema,
          ...(tool.annotations ? { annotations: tool.annotations } : {}),
        })),
      })

    case 'tools/call': {
      const name = typeof params.name === 'string' ? params.name : ''
      const tool = options.tools().find((t) => t.name === name)
      if (!tool) return rpcError(id, -32602, `没有这个工具：${name}`)
      const args = (typeof params.arguments === 'object' && params.arguments !== null && !Array.isArray(params.arguments)
        ? params.arguments
        : {}) as Record<string, unknown>
      const problems = missingArguments(tool.inputSchema, args)
      if (problems.length) return rpcError(id, -32602, problems.join('；'))
      try {
        return rpcResult(id, toToolResult(await tool.handler(args)))
      } catch (error) {
        // 执行失败按规范回 isError（不是协议错误）：模型看得见原因，可能自己改参数重试
        log.warn('MCP 工具执行失败', { tool: name, err: errorMessage(error) })
        return rpcResult(id, { content: [{ type: 'text', text: `执行失败：${errorMessage(error)}` }], isError: true })
      }
    }

    default:
      return rpcError(id, -32601, `不认识的方法：${method}`)
  }
}

// ---------------------------------------------------------------- HTTP 层

export interface McpHttpOptions extends McpServerOptions {
  /** 当前令牌；现取，轮换后下一个请求就按新的算 */
  token: () => string
}

function replyJson(res: http.ServerResponse, status: number, body?: unknown, headers: Record<string, string> = {}): void {
  if (res.headersSent) {
    res.destroy()
    return
  }
  if (body === undefined) {
    res.writeHead(status, headers)
    res.end()
    return
  }
  const text = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text), ...headers })
  res.end(text)
}

function replyText(res: http.ServerResponse, status: number, message: string, headers: Record<string, string> = {}): void {
  if (res.headersSent) {
    res.destroy()
    return
  }
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', ...headers })
  res.end(`Kura MCP：${message}\n`)
}

async function readBody(req: http.IncomingMessage, limit: number): Promise<string> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    if (size > limit) throw new Error(`请求体超过 ${limit} 字节`)
    chunks.push(chunk as Buffer)
  }
  return Buffer.concat(chunks).toString('utf8')
}

/**
 * 一条 HTTP 请求的处理。状态码都是规范定死的：
 * - POST + 请求 → 200 JSON；POST + 通知/响应 → 202 空 body
 * - GET → 405（客户端据此判定「没有 SSE 流」，是**预期**行为，不是错误）
 * - DELETE → 405（不做会话）
 * - 令牌不对 → 401；Host / Origin 不是本机 → 403
 */
export async function handleMcpHttpRequest(req: http.IncomingMessage, res: http.ServerResponse, options: McpHttpOptions): Promise<void> {
  const method = (req.method ?? 'GET').toUpperCase()

  // 防 DNS 重绑定，与 dav-server.ts 同一套判据
  if (!isLoopbackHost(String(req.headers.host ?? ''))) {
    replyText(res, 403, 'Host 不是本机地址')
    return
  }
  const origin = String(req.headers.origin ?? '')
  if (origin && !isLoopbackOrigin(origin)) {
    replyText(res, 403, 'Origin 不是本机地址')
    return
  }

  // 不做 SSE（GET）也不做会话（DELETE）：回 405，客户端会按「服务端不提供」处理
  if (method === 'GET' || method === 'DELETE') {
    replyText(res, 405, `不支持 ${method}（没有 SSE 流与会话）`, { allow: 'POST' })
    return
  }
  if (method !== 'POST') {
    replyText(res, 405, `不支持 ${method}`, { allow: 'POST' })
    return
  }

  const expected = options.token()
  if (!mcpTokenMatches(expected, bearerToken(req.headers.authorization))) {
    replyText(res, 401, '令牌不对（设置里可以查看当前令牌）', { 'www-authenticate': 'Bearer realm="kura"' })
    return
  }

  // 规范：客户端在握手后要带 MCP-Protocol-Version；带了不认识的必须回 400
  const protocolHeader = String(req.headers['mcp-protocol-version'] ?? '')
  if (protocolHeader && !(mcpSupportedVersions as readonly string[]).includes(protocolHeader)) {
    replyText(res, 400, `不支持的协议版本 ${protocolHeader}`)
    return
  }

  let raw: string
  try {
    raw = await readBody(req, mcpMaxBodyBytes)
  } catch (error) {
    replyJson(res, 413, { jsonrpc: '2.0', id: null, error: { code: -32700, message: errorMessage(error) } })
    return
  }

  let message: unknown
  try {
    message = JSON.parse(raw) as unknown
  } catch {
    replyJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: '请求体不是合法 JSON' } })
    return
  }

  const response = await handleMcpMessage(message, options)
  if (response === undefined) {
    // 通知 / 响应：规范要求 202 且无 body
    replyJson(res, 202)
    return
  }
  replyJson(res, 200, response)
}
