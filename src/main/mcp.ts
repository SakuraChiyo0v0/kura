import { join } from 'node:path'
import { ServiceListener } from '../core/listener.js'
import { handleMcpHttpRequest, createMcpToken, type McpTool } from '../core/mcp.js'
import { readJson, writeJsonAtomic } from '../core/store.js'
import { silentLogger, type Logger } from '../core/log.js'
import type { McpStatusView } from '../shared/ipc.js'
import { createMcpTools, type McpToolDeps } from './mcp-tools.js'

/**
 * MCP 服务器（Model Context Protocol）：AI 客户端连上 Kura 来操作 NAS。
 *
 * 只监听回环，与映射服务、本机 WebDAV 用同一套 `ServiceListener`（构造时强制 `assertLoopback`）。
 * 令牌存 `%APPDATA%\Kura\mcp.json`（`writeJsonAtomic` 落 0600），与设置分文件 ——
 * 它是一把钥匙，不该混在普通设置里。
 *
 * **默认关闭**：新增的对外接口不该默认开着，由用户在设置里打开。
 */
export interface McpServiceOptions extends McpToolDeps {
  dataDir: string
  log?: Logger
  /** 服务信息里的版本号（打包后是 app.getVersion()） */
  version: () => string
}

/** mcp.json 只存令牌：开关与端口是设置（settings.json）里那份。 */
interface McpFile {
  token?: unknown
}

export class McpService {
  private readonly listener: ServiceListener
  private readonly tools: McpTool[]
  private readonly file: string
  private readonly log: Logger
  private token = ''
  private enabled: boolean

  constructor(private readonly options: McpServiceOptions) {
    this.file = join(options.dataDir, 'mcp.json')
    this.log = options.log ?? silentLogger
    const saved = readJson<McpFile>(this.file)
    this.token = typeof saved?.token === 'string' && saved.token ? saved.token : createMcpToken()
    if (this.token !== saved?.token) this.persist()
    this.enabled = false
    this.tools = createMcpTools(options)
    this.listener = new ServiceListener({
      // 端口以 apply() 传进来的为准（设置里那份）；这里只是构造时占个位
      port: 18007,
      enabled: false,
      handlers: {
        request: (req, res) => void this.handle(req, res),
        // 不做 WebSocket：客户端握手只会用 POST
        upgrade: (_req, socket) => socket.destroy(),
      },
    })
  }

  /**
   * 按设置启动 / 应用端口。设置里的 `mcpEnabled` 与 `mcpPort` 是唯一来源 ——
   * 端口从设置传进来，不落 mcp.json（那把文件只存令牌）。
   * 传 0 = 让系统挑一个空闲端口（冒烟用），真实端口从 `view()` 里读。
   */
  async apply(enabled: boolean, port: number): Promise<void> {
    this.enabled = enabled
    // setPort 自己会把真实端口（0 的情况）记进监听器；之后再开关，界面读到的就是它
    if (port !== this.listener.status().port) await this.listener.setPort(port)
    if (enabled !== this.listener.status().enabled) await this.listener.setEnabled(enabled)
  }

  close(): Promise<void> {
    return this.listener.close()
  }

  /** 当前令牌（界面要显示、接入命令要用）。 */
  currentToken(): string {
    return this.token
  }

  /** 换一把新令牌：旧客户端会立刻失效，要在界面里说清楚。 */
  rotateToken(): string {
    this.token = createMcpToken()
    this.persist()
    return this.token
  }

  view(): McpStatusView {
    const status = this.listener.status()
    return {
      enabled: this.enabled,
      port: status.port,
      running: status.running,
      lastError: status.lastError,
      url: `http://127.0.0.1:${status.port}/mcp`,
      token: this.token,
      toolCount: this.tools.length,
    }
  }

  private persist(): void {
    try {
      writeJsonAtomic(this.file, { token: this.token })
    } catch (error) {
      this.log.warn('MCP 令牌写盘失败', { err: (error as Error).message })
    }
  }

  private async handle(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse): Promise<void> {
    try {
      await handleMcpHttpRequest(req, res, {
        token: () => this.token,
        tools: () => this.tools,
        serverInfo: { name: 'kura', title: 'Kura 蔵', version: this.options.version() },
        instructions:
          'Kura 是绿联 NAS 的 Windows 客户端。这里的路径都是 NAS 上的绝对路径（如 /volume1/docker）；' +
          '文件、容器、挂载的改动都落在**真实 NAS** 上。动手改东西之前先 kura_status 确认连接可用，' +
          '删除类操作（工具描述里带「永久删除」）要先跟用户确认。',
        log: this.log,
      })
    } catch (error) {
      // 处理器已经尽量自己回响应；能逃到这里说明是写响应之前就炸了，别让连接悬着
      this.log.warn('MCP 请求处理失败', { err: (error as Error).message })
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
        res.end('Kura MCP：内部错误\n')
      } else {
        res.destroy()
      }
    }
  }
}
