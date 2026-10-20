import net from 'node:net'
import { isUtf8 } from 'node:buffer'
import { DockerError } from '../docker/engine.js'

/**
 * 一个够用的 Redis 客户端（RESP2），只为「在 Kura 里看数据」而写。
 *
 * **为什么不引 ioredis**：kura-server 是 esbuild 打单文件、镜像里只放 Node 的形态
 * （server/build.mjs），加依赖要同时动构建与镜像两层，而 RESP 本身只有五种前缀 + 长度，
 * 子集实现比「多一个依赖 + 它自己的连接池/重连策略」更好控制。
 *
 * **只实现浏览需要的那几个命令**：扫描、认类型、取值、跑用户输入的只读/可写命令。
 * 不实现集群、哨兵、RESP3、订阅、管道流式。
 *
 * 值一律回 `Buffer`：Redis 是二进制安全的，`GET` 一个序列化对象是常见的，
 * 一律 `toString('utf8')` 会在展示层变成乱码而不报错 —— 宁可让调用方显式决定怎么显示。
 */

/** 解析出来的一个 RESP 值。`Error` 表示服务端回的 `-ERR`。 */
export type Resp = string | number | Buffer | null | Error | Resp[]

interface Parsed {
  value: Resp
  next: number
}

/**
 * 从 `off` 开始解析一个完整的 RESP 值；数据不够就返回 undefined（等更多字节）。
 *
 * 必须是「够不够」可判定的：TCP 会在任意位置切包，一个 bulk string 的长度行和内容
 * 经常落在两次 `data` 事件里。
 */
function parseAt(buf: Buffer, off: number): Parsed | undefined {
  if (off >= buf.length) return undefined
  const lineEnd = buf.indexOf('\r\n', off)
  if (lineEnd < 0) return undefined
  // off < buf.length 上面已经判过，这里只是让类型收窄
  const kind = buf[off] ?? 0
  const line = buf.toString('utf8', off + 1, lineEnd)
  switch (kind) {
    case 0x2b: // + 简单字符串
      return { value: line, next: lineEnd + 2 }
    case 0x2d: // - 错误
      return { value: new Error(line), next: lineEnd + 2 }
    case 0x3a: // : 整数
      return { value: Number(line), next: lineEnd + 2 }
    case 0x24: {
      // $ 批量字符串。长度 -1 = nil
      const len = Number(line)
      if (!Number.isFinite(len)) return undefined
      if (len < 0) return { value: null, next: lineEnd + 2 }
      const start = lineEnd + 2
      const end = start + len
      if (buf.length < end + 2) return undefined
      return { value: buf.subarray(start, end), next: end + 2 }
    }
    case 0x2a: {
      // * 数组。个数 -1 = nil（BLPOP 超时那类）
      const count = Number(line)
      if (!Number.isFinite(count)) return undefined
      if (count < 0) return { value: null, next: lineEnd + 2 }
      const items: Resp[] = []
      let cursor = lineEnd + 2
      for (let i = 0; i < count; i += 1) {
        const item = parseAt(buf, cursor)
        if (!item) return undefined
        items.push(item.value)
        cursor = item.next
      }
      return { value: items, next: cursor }
    }
    default:
      // 认不出的前缀：不能猜着往后跳，那会把流越读越歪。直接当协议错误。
      throw new DockerError(502, `Redis 回了一个认不出的应答前缀「${String.fromCharCode(kind)}」`)
  }
}

/** 增量解析器：`feed()` 塞字节，`read()` 取走已经完整的那些值。 */
export class RespReader {
  private buf: Buffer = Buffer.alloc(0)

  feed(chunk: Buffer): void {
    this.buf = this.buf.length === 0 ? chunk : Buffer.concat([this.buf, chunk])
  }

  read(): Resp | undefined {
    let parsed: Parsed | undefined
    try {
      parsed = parseAt(this.buf, 0)
    } catch (error) {
      this.buf = Buffer.alloc(0)
      throw error
    }
    if (!parsed) return undefined
    this.buf = this.buf.subarray(parsed.next)
    return parsed.value
  }

  /** 连接关了还剩半截：说明对端在协议中途断了。 */
  get pending(): number {
    return this.buf.length
  }
}

/** 把一条命令编成 RESP 数组（客户端一律用数组形式，避免内联命令的引号解析）。 */
export function encodeCommand(args: Array<string | Buffer>): Buffer {
  const parts: Buffer[] = [Buffer.from(`*${args.length}\r\n`)]
  for (const arg of args) {
    const body = Buffer.isBuffer(arg) ? arg : Buffer.from(arg, 'utf8')
    parts.push(Buffer.from(`$${body.length}\r\n`), body, Buffer.from('\r\n'))
  }
  return Buffer.concat(parts)
}

/** 一条回复转成人能看的文本（界面与 MCP 都要一个稳定的字符串形状）。 */
export function describeResp(value: Resp, depth = 0): string {
  if (value === null) return '(nil)'
  if (value instanceof Error) return `(error) ${value.message}`
  if (Buffer.isBuffer(value)) return decodeMaybe(value).text
  if (typeof value === 'number') return String(value)
  if (typeof value === 'string') return value
  if (depth > 8) return '(…)'
  return value.map((item, index) => `${index + 1}) ${describeResp(item, depth + 1)}`).join('\n')
}

/**
 * 一个字节串能不能当文本显示。
 *
 * 不能的话**明确说出来**（`binary`），而不是把乱码塞给用户 —— 二进制值在 Redis 里很常见
 * （序列化的 JSON 之外还有 protobuf、图片、pickle），静默显示乱码会让人以为数据坏了。
 */
export function decodeMaybe(value: Buffer): { text: string; binary: boolean; bytes: number } {
  const bytes = value.length
  if (bytes === 0) return { text: '', binary: false, bytes: 0 }
  // 用 node:buffer 的 isUtf8 做严格校验。
  // **注意不是 `Buffer.isUtf8`** —— 那个静态方法并不存在（Node 24 上仍是 undefined），
  // 写成 `typeof Buffer.isUtf8 === 'function' && ...` 会让整个判断静默变成「永远是文本」，
  // 二进制值就显示成一堆乱码而不报错。踩过，单测里有一条专门守这个。
  if (!isUtf8(value)) return { text: `（二进制，${bytes} 字节）`, binary: true, bytes }
  return { text: value.toString('utf8'), binary: false, bytes }
}

export interface RedisOptions {
  /** 容器名（Docker 内置 DNS）或 127.0.0.1 */
  host: string
  port: number
  password?: string
  /** 默认 0 */
  db?: number
  /** 单条命令的超时（毫秒） */
  timeoutMs?: number
  /** 测试注入 */
  connect?: (host: string, port: number) => net.Socket
}

/** 一条已发出、还没回的命令。 */
interface Pending {
  resolve: (value: Resp) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}

export class RedisClient {
  private socket: net.Socket
  private readonly reader = new RespReader()
  private readonly queue: Pending[] = []
  private closed = false
  private failure: Error | undefined

  private constructor(
    socket: net.Socket,
    private readonly options: RedisOptions,
  ) {
    this.socket = socket
    socket.setNoDelay(true)
    socket.on('data', (chunk: Buffer) => this.onData(chunk))
    socket.on('error', (error) => this.fail(new DockerError(502, `Redis 连接出错：${error.message}`)))
    socket.on('close', () => this.fail(new DockerError(502, 'Redis 连接被关闭')))
  }

  /**
   * 连上去并完成 AUTH / SELECT。
   *
   * 官方镜像设了 `requirepass` 就会拒绝所有未认证命令（`NOAUTH`），
   * 所以密码必须在连上后立刻发 —— 不能等调用方发第一条命令时才带。
   */
  static async connect(options: RedisOptions): Promise<RedisClient> {
    const socket = (options.connect ?? ((host, port) => net.connect({ host, port })))(options.host, options.port)
    const client = new RedisClient(socket, options)
    // 握手失败要把套接字关掉再抛：不然调用方拿不到这个 client、也就没人能关它，
    // 连接会一直挂着（假服务器的 close() 会因此永远等不到，真机上则是一条泄漏的连接）。
    try {
      await client.waitOpen()
      if (options.password) {
        const reply = await client.command(['AUTH', options.password])
        if (reply instanceof Error) throw new DockerError(401, `Redis 认证失败：${reply.message}`)
      }
      if (options.db) {
        const reply = await client.command(['SELECT', String(options.db)])
        if (reply instanceof Error) throw new DockerError(400, `切不到 db${options.db}：${reply.message}`)
      }
    } catch (error) {
      client.close()
      throw error
    }
    return client
  }

  private waitOpen(): Promise<void> {
    if (this.socket.readyState === 'open') return Promise.resolve()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.socket.destroy()
        reject(new DockerError(504, `连不上 Redis（${this.options.host}:${this.options.port}）`))
      }, this.options.timeoutMs ?? 10_000)
      const done = (): void => {
        clearTimeout(timer)
        this.socket.off('connect', done)
        this.socket.off('error', failed)
        this.socket.off('close', failed)
      }
      const failed = (error?: Error): void => {
        done()
        reject(new DockerError(502, error?.message ? `连不上 Redis：${error.message}` : '连不上 Redis：连接被关闭'))
      }
      this.socket.once('connect', () => {
        done()
        resolve()
      })
      this.socket.once('error', failed)
      this.socket.once('close', () => failed())
    })
  }

  private onData(chunk: Buffer): void {
    this.reader.feed(chunk)
    for (;;) {
      let value: Resp | undefined
      try {
        value = this.reader.read()
      } catch (error) {
        this.fail(error as Error)
        return
      }
      if (value === undefined) break
      const pending = this.queue.shift()
      if (!pending) continue // 没人在等这条（比如超时后被丢弃的），忽略
      clearTimeout(pending.timer)
      // 服务端的 -ERR 不当作连接级失败：一条命令写错不该把整条连接作废
      pending.resolve(value)
    }
  }

  private fail(error: Error): void {
    if (this.failure) return
    this.failure = error
    this.closed = true
    for (const pending of this.queue.splice(0)) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.socket.destroy()
  }

  /** 发一条命令。回 `Error` 表示服务端回的是 `-ERR`（连接仍然可用）。 */
  command(args: Array<string | Buffer>, timeoutMs?: number): Promise<Resp> {
    if (this.closed) return Promise.reject(this.failure ?? new DockerError(502, 'Redis 连接已经关了'))
    return new Promise<Resp>((resolve, reject) => {
      const timer = setTimeout(() => {
        const at = this.queue.findIndex((p) => p.timer === timer)
        if (at >= 0) this.queue.splice(at, 1)
        reject(new DockerError(504, `Redis 命令超时（${args[0]}）`))
      }, timeoutMs ?? this.options.timeoutMs ?? 15_000)
      this.queue.push({ resolve, reject, timer })
      this.socket.write(encodeCommand(args))
    })
  }

  /** 发命令，`-ERR` 直接当异常抛出（绝大多数调用方要的是这个）。 */
  async run(args: Array<string | Buffer>, timeoutMs?: number): Promise<Resp> {
    const reply = await this.command(args, timeoutMs)
    if (reply instanceof Error) throw new DockerError(400, `Redis：${reply.message}`)
    return reply
  }

  /** 把嵌套数组读成字符串列表（SCAN / KEYS / SMEMBERS 之类）。 */
  async runList(args: Array<string | Buffer>, timeoutMs?: number): Promise<string[]> {
    const reply = await this.run(args, timeoutMs)
    if (!Array.isArray(reply)) return []
    return reply.map((item) => (Buffer.isBuffer(item) ? item.toString('utf8') : String(item)))
  }

  close(): void {
    this.closed = true
    this.socket.destroy()
  }
}

/**
 * 跑一条用户输入的命令。
 *
 * **只做最粗的拦截**：`keys` 里出现 `MONITOR` / `SUBSCRIBE` 这类会把连接变成"流"的命令，
 * 会让「一问一答」的解析错位（订阅之后推来的消息没人认领，后面所有命令都对应错）。
 * 这不是安全边界 —— 能调这个接口的人本来就能 `docker exec` 进容器。
 */
const streamCommands = new Set(['MONITOR', 'SUBSCRIBE', 'PSUBSCRIBE', 'SSUBSCRIBE'])

export function assertNotStreamCommand(args: string[]): void {
  const head = (args[0] ?? '').toUpperCase()
  if (streamCommands.has(head)) {
    throw new DockerError(400, `${head} 会把连接变成推送流，Kura 的命令台不支持（用容器终端）`)
  }
}
