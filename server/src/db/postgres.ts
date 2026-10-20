import net from 'node:net'
import { createHash, createHmac, pbkdf2Sync, randomBytes } from 'node:crypto'
import { DockerError } from '../docker/engine.js'

/**
 * 一个够用的 PostgreSQL 客户端（前端/后端协议 v3），只为「在 Kura 里看数据」而写。
 *
 * **为什么不引 pg**：kura-server 是 esbuild 打单文件、镜像里只放 Node 的形态
 * （server/build.mjs），加依赖要同时动构建与镜像两层。这一版只需要：
 * StartupMessage → 认证 → 扩展查询（Parse/Bind/Describe/Execute/Sync）→ 把 DataRow 读成行。
 *
 * 支持的认证：`AuthenticationOk`（trust）、`cleartext`、`md5`、`SASL/SCRAM-SHA-256`。
 * **不支持的明确拒绝**（`SASL/SCRAM-SHA-256-PLUS` 需要 TLS 通道绑定，`GSSAPI` / `SSPI`
 * 要 Kerberos）。拒绝时说清楚要用哪种，而不是给一个「密码错误」的假象。
 *
 * 为什么用**扩展查询**（带参数化的那条）而不是简单查询：
 * 1. 参数走 Bind，客户端自己转义 —— 用户输入的 SQL 里若含字面量，简单查询也安全，
 *    但参数化路径让我们以后加「按主键过滤」时不必再改协议层。
 * 2. Describe 会把结果的**类型 OID** 带回来，界面上能显示真实类型（而不是一律当文本）。
 * 3. 简单查询的 `P` 路径在服务端出错时整个连接进 error 状态，要额外处理；扩展查询有 Sync 兜底。
 */

// ---------------------------------------------------------------- 协议常量

/** 前端消息类型。 */
const FE = {
  startup: 0x00, // 没有类型字节
  password: 0x70, // 'p'
  query: 0x51, // 'Q'
  parse: 0x50, // 'P'
  bind: 0x42, // 'B'
  describe: 0x44, // 'D'
  execute: 0x45, // 'E'
  sync: 0x53, // 'S'
  terminate: 0x58, // 'X'
} as const

/** 后端消息类型（只列认得的）。 */
const BE = {
  authentication: 0x52, // 'R'
  backendKeyData: 0x4b, // 'K'
  parameterStatus: 0x53, // 'S'
  readyForQuery: 0x5a, // 'Z'
  rowDescription: 0x54, // 'T'
  dataRow: 0x44, // 'D'
  commandComplete: 0x43, // 'C'
  errorResponse: 0x45, // 'E'
  noticeResponse: 0x4e, // 'N'
  parseComplete: 0x31, // '1'
  bindComplete: 0x32, // '2'
  noData: 0x6e, // 'n'
  emptyQuery: 0x49, // 'I'
  parameterDescription: 0x74, // 't'
} as const

/** PostgreSQL 的认证方式（AuthenticationXxx 的第二个 int32）。 */
export const AuthMethod = {
  ok: 0,
  kerberosV5: 2,
  cleartext: 3,
  md5: 5,
  scmCredential: 6,
  gss: 7,
  gssContinue: 8,
  sspi: 9,
  sasl: 10,
  saslContinue: 11,
  saslFinal: 12,
} as const

// ---------------------------------------------------------------- 字节读写

/** 前端消息缓冲：`类型(1) + 长度(4，含自己) + 内容`。 */
class Writer {
  private parts: Buffer[] = []
  private body: Buffer[] = []

  constructor(private readonly type: number) {}

  cstr(text: string): this {
    this.body.push(Buffer.from(text, 'utf8'), Buffer.from([0]))
    return this
  }

  cstrRaw(value: Buffer): this {
    this.body.push(value, Buffer.from([0]))
    return this
  }

  int16(n: number): this {
    const b = Buffer.alloc(2)
    b.writeInt16BE(n)
    this.body.push(b)
    return this
  }

  int32(n: number): this {
    const b = Buffer.alloc(4)
    b.writeInt32BE(n)
    this.body.push(b)
    return this
  }

  raw(buffer: Buffer): this {
    this.body.push(buffer)
    return this
  }

  done(): Buffer {
    const body = Buffer.concat(this.body)
    const head = Buffer.alloc(5)
    head[0] = this.type
    head.writeInt32BE(body.length + 4, 1)
    this.parts.push(head, body)
    return Buffer.concat(this.parts)
  }
}

/** 读后端消息的内容（只读，越界返回 0 / 空，不抛 —— 解析出错要在上层变成清楚的错误）。 */
class Reader {
  constructor(
    readonly buf: Buffer,
    public off = 0,
  ) {}

  get remaining(): number {
    return this.buf.length - this.off
  }

  int16(): number {
    if (this.off + 2 > this.buf.length) return 0
    const value = this.buf.readInt16BE(this.off)
    this.off += 2
    return value
  }

  int32(): number {
    if (this.off + 4 > this.buf.length) return 0
    const value = this.buf.readInt32BE(this.off)
    this.off += 4
    return value
  }

  byte(): number {
    const value = this.buf[this.off] ?? 0
    this.off += 1
    return value
  }

  cstr(): string {
    const end = this.buf.indexOf(0, this.off)
    const stop = end < 0 ? this.buf.length : end
    const value = this.buf.toString('utf8', this.off, stop)
    this.off = stop + 1
    return value
  }

  bytes(n: number): Buffer {
    const value = this.buf.subarray(this.off, this.off + n)
    this.off += n
    return value
  }
}

// ---------------------------------------------------------------- MD5 认证

/**
 * `md5` 认证：`"md5" + md5(md5(password + user) + salt)`。
 * 注意里层是**口令 + 用户名**、外层是**前一次的十六进制 + salt**，很容易把顺序写反。
 */
export function md5Response(user: string, password: string, salt: Buffer): string {
  const inner = createHash('md5').update(password + user, 'utf8').digest('hex')
  const outer = createHash('md5').update(Buffer.concat([Buffer.from(inner, 'ascii'), salt])).digest('hex')
  return `md5${outer}`
}

// ---------------------------------------------------------------- SCRAM-SHA-256

/**
 * SCRAM-SHA-256（RFC 5802 + RFC 7677），PostgreSQL 用的那条不带通道绑定的变体。
 *
 * 步骤：
 * 1. 客户端发 `client-first-message`：`n,,n=<user>,r=<nonce>`
 * 2. 服务端回 `server-first-message`：`r=<nonce+serverNonce>,s=<salt>,i=<迭代数>`
 * 3. 客户端算 `SaltedPassword = PBKDF2(password, salt, i)`
 *    `ClientKey = HMAC(SaltedPassword, "Client Key")`
 *    `StoredKey = SHA256(ClientKey)`
 *    `ClientSignature = HMAC(StoredKey, authMessage)`
 *    `ClientProof = ClientKey XOR ClientSignature`
 * 4. 客户端发 `client-final-message`：`c=biws,r=<nonce>,p=<proof>`
 * 5. 服务端回 `v=<ServerSignature>`；客户端算一遍比对（**必须验**，否则是在和一个冒充者说话）
 *
 * 几个容易错到"只是连不上、看不出为什么"的点：
 * - `authMessage` 是三段用逗号拼：`client-first-bare,server-first,client-final-without-proof`
 * - `client-first-bare` **不含** `n,,` 前缀
 * - 用户名里的 `=` 要转义成 `=3D`、`,` 转成 `=2C`
 */
export interface ScramState {
  clientNonce: string
  clientFirstBare: string
  serverFirst?: string
  saltedPassword?: Buffer
  authMessage?: string
}

/** 用户名在 SCRAM 里的转义（RFC 5802 §5.1）。 */
export function saslName(user: string): string {
  return user.replace(/=/g, '=3D').replace(/,/g, '=2C')
}

/** 第一步：构造 client-first-message 并记下状态。 */
export function scramClientFirst(user: string, nonceSeed?: string): { message: string; state: ScramState } {
  const clientNonce = nonceSeed ?? randomBytes(18).toString('base64')
  const clientFirstBare = `n=${saslName(user)},r=${clientNonce}`
  return { message: `n,,${clientFirstBare}`, state: { clientNonce, clientFirstBare } }
}

/** 第二步：吃 server-first-message，算出 client-final-message。 */
export function scramClientFinal(state: ScramState, password: string, serverFirst: string): { message: string; state: ScramState } {
  const attrs = parseAttributes(serverFirst)
  const combinedNonce = attrs.r ?? ''
  const salt = Buffer.from(attrs.s ?? '', 'base64')
  const iterations = Number(attrs.i ?? '4096')
  if (!combinedNonce.startsWith(state.clientNonce)) {
    throw new DockerError(502, 'SCRAM：服务端回的 nonce 不以客户端 nonce 开头（可能被中间人改了）')
  }
  if (!salt.length || !Number.isFinite(iterations) || iterations < 1) {
    throw new DockerError(502, 'SCRAM：服务端给的 salt 或迭代数不合法')
  }

  // 口令先按 SASLprep 处理；这里做最小集（PostgreSQL 自己也不严格要求完整 SASLprep）
  const saltedPassword = pbkdf2Sync(password, salt, iterations, 32, 'sha256')
  const clientKey = createHmac('sha256', saltedPassword).update('Client Key').digest()
  const storedKey = createHash('sha256').update(clientKey).digest()

  // client-final-message-without-proof 的 c=biws（"n,," 的 base64）
  const channelBinding = 'c=biws'
  const clientFinalWithoutProof = `${channelBinding},r=${combinedNonce}`
  const authMessage = `${state.clientFirstBare},${serverFirst},${clientFinalWithoutProof}`

  const clientSignature = createHmac('sha256', storedKey).update(authMessage).digest()
  const clientProof = Buffer.alloc(32)
  for (let i = 0; i < 32; i += 1) clientProof[i] = (clientKey[i] ?? 0) ^ (clientSignature[i] ?? 0)

  return {
    message: `${clientFinalWithoutProof},p=${clientProof.toString('base64')}`,
    state: { ...state, serverFirst, saltedPassword, authMessage },
  }
}

/** 第三步：验服务端的 `v=<ServerSignature>`。**不验就等于没做认证**（对方可能是冒充者）。 */
export function scramVerify(state: ScramState, serverFinal: string): void {
  const attrs = parseAttributes(serverFinal)
  if (attrs.e) throw new DockerError(401, `SCRAM 认证失败：${attrs.e}`)
  const expected = attrs.v
  if (!expected) throw new DockerError(502, 'SCRAM：服务端的最终消息里没有 v=')
  if (!state.saltedPassword || !state.authMessage) throw new DockerError(502, 'SCRAM：状态不完整')

  const serverKey = createHmac('sha256', state.saltedPassword).update('Server Key').digest()
  const serverSignature = createHmac('sha256', serverKey).update(state.authMessage).digest()
  const got = Buffer.from(expected, 'base64')
  if (got.length !== serverSignature.length || !got.equals(serverSignature)) {
    throw new DockerError(502, 'SCRAM：服务端签名不匹配（连接可能被篡改）')
  }
}

/** `a=b,c=d` 形式的属性串解析（SCRAM 消息就是这个形状）。 */
export function parseAttributes(message: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const part of message.split(',')) {
    const at = part.indexOf('=')
    if (at <= 0) continue
    out[part.slice(0, at)] = part.slice(at + 1)
  }
  return out
}

// ---------------------------------------------------------------- 类型 OID → 名字

/**
 * 常见类型 OID → 名字。**不追求全**：认不出的显示 `oid:1234`，
 * 界面上至少知道「这不是文本」，而不是假装成字符串。
 */
const typeNames: Record<number, string> = {
  16: 'bool',
  17: 'bytea',
  18: 'char',
  19: 'name',
  20: 'int8',
  21: 'int2',
  23: 'int4',
  25: 'text',
  26: 'oid',
  114: 'json',
  142: 'xml',
  700: 'float4',
  701: 'float8',
  1042: 'char(n)',
  1043: 'varchar',
  1082: 'date',
  1083: 'time',
  1114: 'timestamp',
  1184: 'timestamptz',
  1186: 'interval',
  1266: 'timetz',
  1700: 'numeric',
  2950: 'uuid',
  3802: 'jsonb',
}

export function typeNameOfOid(oid: number): string {
  return typeNames[oid] ?? `oid:${oid}`
}

/** 二进制类型（bytea）：值按十六进制显示。 */
export function isBinaryOid(oid: number): boolean {
  return oid === 17
}

/** 数字类型（界面上右对齐）。 */
const numericOids = new Set([20, 21, 23, 26, 700, 701, 1700])
export function isNumericOid(oid: number): boolean {
  return numericOids.has(oid)
}

// ---------------------------------------------------------------- 结果

export interface PgColumn {
  name: string
  /** 类型的 OID（原始值，界面上再翻成名字） */
  typeOid: number
  type: string
  numeric: boolean
  binary: boolean
}

export interface PgResult {
  /** 有结果集 / 只是命令 */
  kind: 'rows' | 'command'
  columns: PgColumn[]
  /** 每个单元格是 `Buffer | null`（保留原始字节） */
  rows: Array<Array<Buffer | null>>
  /** 命令标签，如 `SELECT 42` / `INSERT 0 1` / `CREATE TABLE` */
  command: string
  /** 影响的（或返回的）行数；-1 = 标签里没说 */
  affected: number
}

/** 把一个后端的 DataRow 解成 `Buffer | null` 数组（int32 长度 + 内容，-1 = NULL）。 */
export function parseDataRow(payload: Buffer): Array<Buffer | null> {
  const r = new Reader(payload)
  const count = r.int16()
  const out: Array<Buffer | null> = []
  for (let i = 0; i < count; i += 1) {
    const len = r.int32()
    if (len < 0) out.push(null)
    else out.push(r.bytes(len))
  }
  return out
}

/** 从 `SELECT 42` / `INSERT 0 1` / `UPDATE 3` 这样的标签里抽出影响行数。 */
export function affectedFromTag(tag: string): number {
  const parts = tag.trim().split(/\s+/)
  const last = parts[parts.length - 1]
  const n = Number(last)
  if (Number.isFinite(n)) return n
  // `CREATE TABLE` 之类没有数字
  return -1
}

/** RowDescription 里的一个字段。 */
interface FieldDescription {
  name: string
  tableOid: number
  columnAttr: number
  typeOid: number
  typeSize: number
  typeModifier: number
  format: number
}

export function parseRowDescription(payload: Buffer): FieldDescription[] {
  const r = new Reader(payload)
  const count = r.int16()
  const fields: FieldDescription[] = []
  for (let i = 0; i < count; i += 1) {
    const name = r.cstr()
    const tableOid = r.int32()
    const columnAttr = r.int16()
    const typeOid = r.int32()
    const typeSize = r.int16()
    const typeModifier = r.int32()
    const format = r.int16()
    fields.push({ name, tableOid, columnAttr, typeOid, typeSize, typeModifier, format })
  }
  return fields
}

// ---------------------------------------------------------------- 包缓冲

/** 后端消息：`类型(1) + 长度(4) + 内容`。**必须按边界累积**（TCP 会随便切）。 */
interface PgMessage {
  type: number
  payload: Buffer
}

class MessageReader {
  private buf: Buffer = Buffer.alloc(0)

  feed(chunk: Buffer): void {
    this.buf = this.buf.length === 0 ? chunk : Buffer.concat([this.buf, chunk])
  }

  next(): PgMessage | undefined {
    if (this.buf.length < 5) return undefined
    const len = this.buf.readInt32BE(1)
    if (len < 4) throw new DockerError(502, `PostgreSQL 消息长度不合法（${len}）`)
    if (this.buf.length < 1 + len) return undefined
    const type = this.buf[0] ?? 0
    const payload = this.buf.subarray(5, 1 + len)
    this.buf = this.buf.subarray(1 + len)
    return { type, payload }
  }
}

// ---------------------------------------------------------------- 客户端

export interface PgOptions {
  host: string
  port: number
  user: string
  password?: string
  database?: string
  /** 建立连接的超时 */
  timeoutMs?: number
  /** 测试注入 */
  connect?: (host: string, port: number) => net.Socket
}

/** 服务端回的错误（`ErrorResponse`）。 */
export interface PgServerError {
  severity: string
  code: string
  message: string
  detail?: string
  hint?: string
}

export function parseErrorResponse(payload: Buffer): PgServerError {
  const r = new Reader(payload)
  const fields: Record<string, string> = {}
  for (;;) {
    const code = r.byte()
    if (code === 0) break
    const value = r.cstr()
    fields[String.fromCharCode(code)] = value
  }
  return {
    severity: fields.S ?? 'ERROR',
    code: fields.C ?? '',
    message: fields.M ?? '（服务端没有给出消息）',
    ...(fields.D ? { detail: fields.D } : {}),
    ...(fields.H ? { hint: fields.H } : {}),
  }
}

export class PgClient {
  private readonly reader = new MessageReader()
  /**
   * 已经收到、还没被读走的消息。
   *
   * **必须缓冲**：一条 `SELECT` 的应答可能几十条消息（RowDescription + 每个 DataRow + CommandComplete
   * + ReadyForQuery），它们经常挤在一两个 TCP 段里到达。MySQL 那边在这里踩过坑
   * （`if (!pending) continue` 把多出来的消息丢了 → 永远等不到），这边一开始就按缓冲写。
   */
  private readonly inbox: PgMessage[] = []
  private readonly waiters: Array<{ resolve: (message: PgMessage) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }> = []
  private broken: Error | undefined
  /** 服务端在 ReadyForQuery 里给的事务状态（I = idle） */
  private transactionStatus = 'I'
  readonly serverParameters = new Map<string, string>()

  private constructor(
    private readonly socket: net.Socket,
    readonly backendPid: number | undefined,
  ) {
    socket.setNoDelay(true)
    socket.on('data', (chunk: Buffer) => this.onData(chunk))
    socket.on('error', (error) => this.fail(new DockerError(502, `PostgreSQL 连接出错：${error.message}`)))
    socket.on('close', () => this.fail(new DockerError(502, 'PostgreSQL 连接被关闭')))
  }

  /** 连上、握手、认证。失败时套接字一定关掉。 */
  static async connect(options: PgOptions): Promise<PgClient> {
    const socket = (options.connect ?? ((host, port) => net.connect({ host, port })))(options.host, options.port)
    let client: PgClient | undefined
    try {
      // StartupMessage：长度 + 协议版本(3.0) + 键值对 + 结束 NUL。**没有类型字节。**
      const body = Buffer.concat([
        (() => {
          const b = Buffer.alloc(4)
          b.writeInt32BE(196608) // 3 << 16
          return b
        })(),
        Buffer.from('user\0', 'utf8'),
        Buffer.from(options.user, 'utf8'),
        Buffer.from([0]),
        ...(options.database ? [Buffer.from('database\0', 'utf8'), Buffer.from(options.database, 'utf8'), Buffer.from([0])] : []),
        Buffer.from('client_encoding\0UTF8\0', 'utf8'),
        Buffer.from('application_name\0kura\0', 'utf8'),
        Buffer.from([0]),
      ])
      const head = Buffer.alloc(4)
      head.writeInt32BE(body.length + 4)
      socket.write(Buffer.concat([head, body]))

      client = new PgClient(socket, undefined)
      await client.authenticate(options)
      return client
    } catch (error) {
      client?.close()
      socket.destroy()
      throw error
    }
  }

  /** 握手之后的认证循环。 */
  private async authenticate(options: PgOptions): Promise<void> {
    let scramState: ScramState | undefined
    for (;;) {
      const message = await this.read(options.timeoutMs ?? 15_000)
      const type = message.type

      if (type === BE.errorResponse) {
        const err = parseErrorResponse(message.payload)
        throw new DockerError(401, `PostgreSQL 认证失败（${err.code}）：${err.message}${err.hint ? ` —— ${err.hint}` : ''}`)
      }

      if (type === BE.authentication) {
        const r = new Reader(message.payload)
        const method = r.int32()
        switch (method) {
          case AuthMethod.ok:
            // 认证通过，继续等 ReadyForQuery
            continue
          case AuthMethod.cleartext: {
            const w = new Writer(FE.password)
            w.cstrRaw(Buffer.from(options.password ?? '', 'utf8'))
            this.socket.write(w.done())
            continue
          }
          case AuthMethod.md5: {
            const salt = r.bytes(4)
            const w = new Writer(FE.password)
            w.cstrRaw(Buffer.from(md5Response(options.user, options.password ?? '', salt), 'ascii'))
            this.socket.write(w.done())
            continue
          }
          case AuthMethod.sasl: {
            // 后面是若干个以 NUL 结尾的机制名
            const mechanisms: string[] = []
            for (;;) {
              const name = r.cstr()
              if (!name) break
              mechanisms.push(name)
            }
            if (!mechanisms.includes('SCRAM-SHA-256')) {
              throw new DockerError(
                401,
                `PostgreSQL 要求的认证方式是 ${mechanisms.join('、')}，Kura 只支持 SCRAM-SHA-256（以及 md5 / 明文）。` +
                  '把 pg_hba.conf 里的这条改成 scram-sha-256 或 md5。',
              )
            }
            const first = scramClientFirst(options.user)
            scramState = first.state
            const w = new Writer(FE.password)
            w.cstr('SCRAM-SHA-256')
            const body = Buffer.from(first.message, 'utf8')
            w.int32(body.length)
            w.raw(body)
            this.socket.write(w.done())
            continue
          }
          case AuthMethod.saslContinue: {
            if (!scramState) throw new DockerError(502, 'SCRAM：服务端发了 continue 但我们没开始')
            const serverFirst = r.bytes(r.remaining).toString('utf8')
            const final = scramClientFinal(scramState, options.password ?? '', serverFirst)
            scramState = final.state
            const w = new Writer(FE.password)
            w.raw(Buffer.from(final.message, 'utf8'))
            this.socket.write(w.done())
            continue
          }
          case AuthMethod.saslFinal: {
            if (!scramState) throw new DockerError(502, 'SCRAM：服务端发了 final 但我们没开始')
            const serverFinal = r.bytes(r.remaining).toString('utf8')
            scramVerify(scramState, serverFinal)
            continue
          }
          default:
            throw new DockerError(
              401,
              `PostgreSQL 要求认证方式 #${method}（Kerberos / GSSAPI / SSPI 之类），Kura 不支持。改 pg_hba.conf 用 scram-sha-256 或 md5。`,
            )
        }
      }

      if (type === BE.backendKeyData) {
        const r = new Reader(message.payload)
        const pid = r.int32()
        this.serverParameters.set('__pid', String(pid))
        continue
      }
      if (type === BE.parameterStatus) {
        const r = new Reader(message.payload)
        const name = r.cstr()
        const value = r.cstr()
        this.serverParameters.set(name, value)
        continue
      }
      if (type === BE.noticeResponse) continue
      if (type === BE.readyForQuery) {
        this.transactionStatus = String.fromCharCode(message.payload[0] ?? 0x49)
        return
      }
      // 其它类型在认证阶段出现都算意外，但不至于致命（比如 NoticeResponse 的变体）
    }
  }

  private onData(chunk: Buffer): void {
    this.reader.feed(chunk)
    for (;;) {
      let message: PgMessage | undefined
      try {
        message = this.reader.next()
      } catch (error) {
        this.fail(error as Error)
        return
      }
      if (!message) break
      const waiter = this.waiters.shift()
      if (waiter) {
        clearTimeout(waiter.timer)
        waiter.resolve(message)
      } else {
        this.inbox.push(message)
      }
    }
  }

  private fail(error: Error): void {
    if (this.broken) return
    this.broken = error
    for (const waiter of this.waiters.splice(0)) {
      clearTimeout(waiter.timer)
      waiter.reject(error)
    }
    this.socket.destroy()
  }

  private read(timeoutMs: number): Promise<PgMessage> {
    if (this.broken) return Promise.reject(this.broken)
    const buffered = this.inbox.shift()
    if (buffered) return Promise.resolve(buffered)
    return new Promise<PgMessage>((resolve, reject) => {
      const timer = setTimeout(() => {
        const at = this.waiters.findIndex((w) => w.timer === timer)
        if (at >= 0) this.waiters.splice(at, 1)
        reject(new DockerError(504, 'PostgreSQL 应答超时'))
      }, timeoutMs)
      this.waiters.push({ resolve, reject, timer })
    })
  }

  /**
   * 跑一条 SQL（扩展查询：Parse / Bind / Describe / Execute / Sync）。
   *
   * 一次只发一条语句（简单查询允许多条用分号连，扩展查询不允许）——
   * 界面上一条语句一个结果更符合直觉，也避免了「一半成功一半失败」的状态。
   */
  async query(sql: string, timeoutMs = 30_000): Promise<PgResult> {
    const parse = new Writer(FE.parse).cstr('').cstr(sql).int16(0).done()
    const bind = new Writer(FE.bind).cstr('').cstr('').int16(0).int16(0).int16(0).done()
    const describe = new Writer(FE.describe).raw(Buffer.from('P')).cstr('').done()
    const execute = new Writer(FE.execute).cstr('').int32(0).done()
    const sync = new Writer(FE.sync).done()
    this.socket.write(Buffer.concat([parse, bind, describe, execute, sync]))

    const columns: PgColumn[] = []
    const rows: Array<Array<Buffer | null>> = []
    let command = ''
    let sawError: PgServerError | undefined

    for (;;) {
      const message = await this.read(timeoutMs)
      switch (message.type) {
        case BE.parseComplete:
        case BE.bindComplete:
        case BE.parameterDescription:
        case BE.noData:
          continue
        case BE.rowDescription: {
          for (const field of parseRowDescription(message.payload)) {
            columns.push({
              name: field.name,
              typeOid: field.typeOid,
              type: typeNameOfOid(field.typeOid),
              numeric: isNumericOid(field.typeOid),
              binary: isBinaryOid(field.typeOid),
            })
          }
          continue
        }
        case BE.dataRow:
          rows.push(parseDataRow(message.payload))
          continue
        case BE.commandComplete:
          command = message.payload.subarray(0, Math.max(0, message.payload.length - 1)).toString('utf8')
          continue
        case BE.emptyQuery:
          command = ''
          continue
        case BE.errorResponse:
          sawError = parseErrorResponse(message.payload)
          // 不立刻抛：服务端会紧接着发 ReadyForQuery，继续读到那里再抛，
          // 否则连接状态会错（下一条命令会读到上一条的残留）
          continue
        case BE.noticeResponse:
          continue
        case BE.readyForQuery:
          this.transactionStatus = String.fromCharCode(message.payload[0] ?? 0x49)
          if (sawError) {
            throw new DockerError(400, `PostgreSQL（${sawError.code}）：${sawError.message}${sawError.hint ? ` —— ${sawError.hint}` : ''}`)
          }
          return {
            kind: columns.length > 0 ? 'rows' : 'command',
            columns,
            rows,
            command,
            affected: affectedFromTag(command),
          }
        default:
          // 其它消息（NotificationResponse 之类）不影响这条查询
          continue
      }
    }
  }

  /** 服务端版本（`server_version` 参数里拿）。 */
  serverVersion(): string {
    return this.serverParameters.get('server_version') ?? ''
  }

  close(): void {
    if (this.broken) return
    try {
      this.socket.write(new Writer(FE.terminate).done())
    } catch {
      // 断都断了
    }
    this.socket.destroy()
  }
}
