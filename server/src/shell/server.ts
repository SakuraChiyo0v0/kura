import { timingSafeEqual } from 'node:crypto'
import { execFile } from 'node:child_process'
import http from 'node:http'
import type net from 'node:net'
import { randomBytes } from 'node:crypto'
import { WebSocketServer, type WebSocket } from 'ws'
import { nsenterInvocation, nodePtySpawner, type PtySpawner, type PtySession } from './pty.js'
import { AuditLog, type AuditEntry } from './audit.js'

/**
 * kura-shell：特权容器里的终端执行器。
 *
 * **它不认用户，只认一个内部令牌**（kura-server 每次启动生成、经共享卷传过来）。
 * 所以「谁能用终端」这件事在 kura-server 那边决定一次就够了，这里不做第二套认证 ——
 * 少一处能出错的地方。这个容器不发布端口、只在 kura-internal 网络上，
 * 即使令牌泄漏，攻击者也要先进到那个内部网络。
 *
 * 对外两种接口（设计文档 §七）：
 *   WS   /api/tty        —— 一个连接一个 PTY。上行文本 = 输入，`{"type":"resize",...}` = 改尺寸；下行 = 输出
 *   POST /api/exec       —— `{cmd,cwd?,timeout?}` → `{exitCode,stdout,stderr,durationMs}`
 */
export interface ShellOptions {
  /**
   * 内部令牌；空字符串 = 拒绝一切（配置没送到时宁可不开）。
   * 给函数时**每次请求现取** —— 令牌文件是共享卷上的，kura-server 换了令牌这里不用重启就跟上。
   */
  token: string | (() => string)
  audit: AuditLog
  /** 并发上限，默认 4 */
  maxSessions?: number
  /** 进宿主的 shell，默认 /bin/bash */
  shell?: string
  /** 测试注入 */
  spawnPty?: PtySpawner
  /** exec 的执行器（测试注入用；默认 nsenter 进宿主） */
  runExec?: (cmd: string, cwd: string, timeoutMs: number) => Promise<{ exitCode: number; stdout: string; stderr: string }>
  log?: (message: string, fields?: Record<string, unknown>) => void
}

interface PtyConnection {
  id: string
  user: string
  ip: string
  proc: PtySession
  ws: WebSocket
}

export function internalToken(): string {
  return randomBytes(32).toString('base64url')
}

/** 恒定时间比对令牌。 */
function tokenMatches(expected: string, given: string | undefined): boolean {
  if (!expected || !given) return false
  const a = Buffer.from(expected)
  const b = Buffer.from(given)
  return a.length === b.length && timingSafeEqual(a, b)
}

function clientIp(req: http.IncomingMessage): string {
  return req.socket.remoteAddress ?? 'unknown'
}

/** x-kura-user 是编码过的（HTTP 头只能 ASCII），解回来 —— 只用于审计。 */
function headerUser(req: http.IncomingMessage): string {
  const raw = String(req.headers['x-kura-user'] ?? '')
  if (!raw) return ''
  try {
    return decodeURIComponent(raw)
  } catch {
    return raw
  }
}

function readBody(req: http.IncomingMessage, limit = 64 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > limit) {
        reject(new Error('请求体过大'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function json(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

export function createShellServer(options: ShellOptions): http.Server {
  const maxSessions = options.maxSessions ?? 4
  /** 现取当前令牌（给的是函数就调一次，给的是字符串就用它）。 */
  const currentToken = (): string => (typeof options.token === 'function' ? options.token() : options.token)
  const spawnPty = options.spawnPty ?? nodePtySpawner
  const shell = options.shell ?? '/bin/bash'
  const log = options.log ?? (() => {})
  const connections = new Map<string, PtyConnection>()

  /** 默认 exec：nsenter 进宿主执行（绝对不经 shell 拼字符串，参数原样传）。 */
  const runExec =
    options.runExec ??
    ((cmd: string, cwd: string, timeoutMs: number) =>
      new Promise<{ exitCode: number; stdout: string; stderr: string }>((resolve) => {
        execFile('nsenter', ['-t', '1', '-m', '-u', '-i', '-n', '-p', '--', shell, '-lc', cmd], { cwd: cwd || '/', timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
          const code = error && typeof (error as { code?: unknown }).code === 'number' ? (error as { code: number }).code : error ? 1 : 0
          resolve({ exitCode: code, stdout, stderr })
        })
      }))

  const server = http.createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://shell')
      // 健康检查不需要令牌：kura-server 用它判断容器活着没有
      if (url.pathname === '/api/health') {
        json(res, 200, { status: 'OK', app: 'kura-shell', sessions: connections.size })
        return
      }
      // 令牌从 Authorization: Bearer 或 X-Kura-Token 头来
      const bearer = /^Bearer\s+(.+)$/i.exec(String(req.headers.authorization ?? ''))?.[1]?.trim()
      const given = bearer ?? String(req.headers['x-kura-token'] ?? '').trim()
      if (!tokenMatches(currentToken(), given)) {
        json(res, 401, { error: '内部令牌不对' })
        return
      }

      if (url.pathname === '/api/exec' && req.method === 'POST') {
        await handleExec(req, res)
        return
      }
      json(res, 404, { error: '没有这个接口' })
    })().catch((error: Error) => {
      log('kura-shell 处理请求出错', { err: error.message })
      if (!res.headersSent) json(res, 500, { error: error.message })
      else res.destroy()
    })
  })

  const handleExec = async (req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
    let body: { cmd?: unknown; cwd?: unknown; timeout?: unknown }
    try {
      body = JSON.parse(await readBody(req)) as typeof body
    } catch {
      json(res, 400, { error: '请求体不是合法 JSON' })
      return
    }
    const cmd = String(body.cmd ?? '').trim()
    if (!cmd) {
      json(res, 400, { error: 'cmd 不能为空' })
      return
    }
    const cwd = String(body.cwd ?? '')
    const timeoutMs = Math.min(Math.max(Number(body.timeout ?? 30_000) || 30_000, 100), 300_000)
    const user = headerUser(req)
    const ip = clientIp(req)
    const id = randomBytes(8).toString('hex')
    const started = Date.now()
    const result = await runExec(cmd, cwd, timeoutMs)
    const durationMs = Date.now() - started
    options.audit.write({ at: new Date().toISOString(), id, user, action: 'exec', detail: cmd, exitCode: result.exitCode, durationMs, ip })
    json(res, 200, { ...result, durationMs })
  }

  const wss = new WebSocketServer({ noServer: true })

  server.on('upgrade', (req: http.IncomingMessage, socket: net.Socket, head: Buffer) => {
    socket.on('error', () => {})
    const url = new URL(req.url ?? '/', 'http://shell')
    if (url.pathname !== '/api/tty') {
      socket.end('HTTP/1.1 404 Not Found\r\nconnection: close\r\n\r\n')
      return
    }
    const bearer = /^Bearer\s+(.+)$/i.exec(String(req.headers.authorization ?? ''))?.[1]?.trim()
    const given = bearer ?? String(req.headers['x-kura-token'] ?? '').trim()
    if (!tokenMatches(currentToken(), given)) {
      socket.end('HTTP/1.1 401 Unauthorized\r\nconnection: close\r\n\r\n')
      return
    }
    if (connections.size >= maxSessions) {
      socket.end('HTTP/1.1 429 Too Many Requests\r\nconnection: close\r\n\r\n')
      return
    }
    wss.handleUpgrade(req, socket, head, (ws) => onConnection(ws, req, url))
  })

  const onConnection = (ws: WebSocket, req: http.IncomingMessage, url: URL): void => {
    const id = randomBytes(8).toString('hex')
    const user = headerUser(req)
    const ip = clientIp(req)
    const cols = Number(url.searchParams.get('cols') ?? 80) || 80
    const rows = Number(url.searchParams.get('rows') ?? 24) || 24
    const invocation = nsenterInvocation(shell)
    let proc: PtySession
    try {
      proc = spawnPty({ ...invocation, cols, rows, cwd: '/', env: { ...process.env, TERM: 'xterm-256color' } })
    } catch (error) {
      log('PTY 起不来', { err: (error as Error).message })
      ws.send(`\r\n终端起不来：${(error as Error).message}\r\n`)
      ws.close(1011, 'pty failed')
      return
    }
    const connection: PtyConnection = { id, user, ip, proc, ws }
    connections.set(id, connection)
    options.audit.write({ at: new Date().toISOString(), id, user, action: 'pty-open', detail: shell, ip })
    log('终端会话开始', { id, user, ip, 会话数: connections.size })

    proc.onData((data) => {
      if (ws.readyState === ws.OPEN) ws.send(data)
    })
    proc.onExit(({ exitCode }) => {
      if (ws.readyState === ws.OPEN) ws.close(1000, `exit ${exitCode}`)
      closeConnection(id, exitCode)
    })
    ws.on('message', (data: Buffer, isBinary: boolean) => {
      const text = isBinary ? data.toString('utf8') : data.toString()
      // resize 是唯一的控制消息；别的都当输入原样写进 PTY
      const resize = /^\s*\{\s*"type"\s*:\s*"resize"\s*,\s*"cols"\s*:\s*(\d+)\s*,\s*"rows"\s*:\s*(\d+)\s*\}\s*$/.exec(text)
      if (resize) {
        try {
          proc.resize(Math.max(1, Number(resize[1])), Math.max(1, Number(resize[2])))
        } catch {
          // 进程已经没了，忽略
        }
        return
      }
      // PTY 已经退出时 write 可能抛（写已销毁的 socket）。这是 ws 的事件回调，抛出去就是未捕获异常，
      // 会把整个 kura-shell 进程带走 —— 所有终端会话一起断。写不进去就关掉这个会话。
      try {
        proc.write(text)
      } catch {
        closeConnection(id)
      }
    })
    ws.on('close', () => closeConnection(id))
    ws.on('error', () => closeConnection(id))
  }

  const closeConnection = (id: string, exitCode?: number): void => {
    const connection = connections.get(id)
    if (!connection) return
    connections.delete(id)
    try {
      connection.proc.kill()
    } catch {
      // 已经退出了
    }
    options.audit.write({ at: new Date().toISOString(), id, user: connection.user, action: 'pty-close', detail: options.shell ?? '/bin/bash', exitCode, ip: connection.ip })
    log('终端会话结束', { id, 会话数: connections.size })
  }

  server.on('close', () => {
    for (const id of [...connections.keys()]) closeConnection(id)
  })

  return server
}

export type { AuditEntry }
