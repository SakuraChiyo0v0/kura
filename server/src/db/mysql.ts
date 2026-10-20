import net from 'node:net'
import { createHash } from 'node:crypto'
import { DockerError } from '../docker/engine.js'

/**
 * 一个够用的 MySQL / MariaDB 客户端（客户端/服务端协议 v10），只为「在 Kura 里看数据」而写。
 *
 * **为什么不引 mysql2**：kura-server 是 esbuild 打单文件、镜像里只放 Node 的形态
 * （server/build.mjs），加依赖要同时动构建与镜像两层。而这一版只需要：
 * 握手 → 认证 → COM_QUERY → 把结果集读成行。**不做**预处理语句、游标、压缩、SSL、多语句、LOAD DATA。
 *
 * 支持 `mysql_native_password` 与 `caching_sha2_password`（MySQL 8 的默认）。
 * 后者在「非 TLS 且还没有缓存」时会要求走「取公钥」那条路 —— 那要 RSA 加密，
 * 这里**明确拒绝并说清楚**，而不是静默失败（真机若遇到，把容器改成
 * `--default-authentication-plugin=mysql_native_password` 或开 TLS 即可）。
 *
 * 值一律回 `Buffer | null`：文本列的 `null` 与空串必须能分开（界面上一个显示 NULL、
 * 一个显示空白），而 BLOB 列不该被当成文本。
 */

/** 服务端能力位（只列用得到的）。 */
const CLIENT_LONG_PASSWORD = 1
const CLIENT_LONG_FLAG = 0x0000_0004
const CLIENT_CONNECT_WITH_DB = 0x0000_0008
const CLIENT_PROTOCOL_41 = 0x0000_0200
const CLIENT_TRANSACTIONS = 0x0000_2000
const CLIENT_SECURE_CONNECTION = 0x0000_8000
const CLIENT_MULTI_RESULTS = 0x0002_0000
const CLIENT_PLUGIN_AUTH = 0x0008_0000

/** 客户端发出的能力集。刻意不带 CLIENT_SSL / CLIENT_COMPRESS / CLIENT_LOCAL_FILES。 */
const clientFlags =
  CLIENT_LONG_PASSWORD |
  CLIENT_LONG_FLAG |
  CLIENT_CONNECT_WITH_DB |
  CLIENT_PROTOCOL_41 |
  CLIENT_TRANSACTIONS |
  CLIENT_SECURE_CONNECTION |
  CLIENT_MULTI_RESULTS |
  CLIENT_PLUGIN_AUTH

/** 命令号。 */
const COM_QUIT = 0x01
const COM_QUERY = 0x03
const COM_PING = 0x0e

/** 服务端状态位。 */
const SERVER_MORE_RESULTS_EXISTS = 0x0008

// ---------------------------------------------------------------- 字节读写

/** 一个只读的包体游标。协议里全是小端长度前缀，手写比引库清楚。 */
class Reader {
  constructor(
    readonly buf: Buffer,
    public off = 0,
  ) {}

  get remaining(): number {
    return this.buf.length - this.off
  }

  u8(): number {
    const value = this.buf[this.off] ?? 0
    this.off += 1
    return value
  }

  u16(): number {
    const value = this.buf.readUInt16LE(this.off)
    this.off += 2
    return value
  }

  u24(): number {
    const value = this.buf.readUIntLE(this.off, 3)
    this.off += 3
    return value
  }

  u32(): number {
    const value = this.buf.readUInt32LE(this.off)
    this.off += 4
    return value
  }

  /** 长度编码整数（1/3/4/9 字节）。 */
  lenenc(): number | null {
    const first = this.u8()
    if (first < 0xfb) return first
    if (first === 0xfb) return null // NULL（协议里的「这一列是 NULL」）
    if (first === 0xfc) return this.u16()
    if (first === 0xfd) return this.u24()
    if (first === 0xfe) {
      const value = this.buf.readBigUInt64LE(this.off)
      this.off += 8
      // 超过 2^53 的长度在这条路上不可能出现（包上限 16MB），截断到安全整数
      return value > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(value)
    }
    // 0xff 在长度编码里是未定义；当 NULL 处理并把游标推过去，总比读到歪的地方好
    return null
  }

  /** 带长度前缀的字符串；NULL 长度返回 null。**保留原始字节**（不转 utf8）。 */
  lenencBytes(): Buffer | null {
    const len = this.lenenc()
    if (len === null) return null
    const value = this.buf.subarray(this.off, this.off + len)
    this.off += len
    return value
  }

  /** NUL 结尾的字符串（握手里那一堆）。 */
  nulString(): string {
    const end = this.buf.indexOf(0, this.off)
    const stop = end < 0 ? this.buf.length : end
    const value = this.buf.toString('utf8', this.off, stop)
    this.off = stop + 1
    return value
  }

  /** 剩下的全部字节。 */
  rest(): Buffer {
    const value = this.buf.subarray(this.off)
    this.off = this.buf.length
    return value
  }
}

/** 长度编码整数写进数组。 */
function writeLenenc(value: number): Buffer {
  if (value < 0xfb) return Buffer.from([value])
  if (value < 0x1_0000) {
    const b = Buffer.alloc(3)
    b[0] = 0xfc
    b.writeUInt16LE(value, 1)
    return b
  }
  const b = Buffer.alloc(4)
  b[0] = 0xfd
  b.writeUIntLE(value, 1, 3)
  return b
}

function nulString(value: string): Buffer {
  return Buffer.concat([Buffer.from(value, 'utf8'), Buffer.from([0])])
}

// ---------------------------------------------------------------- 握手

export interface MySqlHandshake {
  protocolVersion: number
  serverVersion: string
  connectionId: number
  salt: Buffer
  capabilityFlags: number
  authPlugin: string
}

export function parseHandshake(payload: Buffer): MySqlHandshake {
  const r = new Reader(payload)
  const protocolVersion = r.u8()
  if (protocolVersion !== 10) {
    throw new DockerError(502, `MySQL 握手版本是 ${protocolVersion}，这个客户端只认 10（MySQL 5.0+）`)
  }
  const serverVersion = r.nulString()
  const connectionId = r.u32()
  const salt1 = r.buf.subarray(r.off, r.off + 8)
  r.off += 8
  r.u8() // filler
  const capsLow = r.u16()
  let capabilityFlags = capsLow
  let authPlugin = 'mysql_native_password'
  let salt = Buffer.from(salt1)
  if (r.remaining > 0) {
    r.u8() // character set
    r.u16() // status
    const capsHigh = r.u16()
    capabilityFlags = capsLow | (capsHigh << 16)
    const authDataLen = r.u8()
    r.off += 10 // reserved
    if (capabilityFlags & CLIENT_SECURE_CONNECTION) {
      // 第二段 salt：长度是 authDataLen - 8，末尾还有个 NUL
      const takeLen = Math.max(13, authDataLen - 8)
      salt = Buffer.concat([salt, r.buf.subarray(r.off, r.off + takeLen - 1)])
      r.off += takeLen
    }
    if (capabilityFlags & CLIENT_PLUGIN_AUTH) authPlugin = r.nulString()
  }
  return { protocolVersion, serverVersion, connectionId, salt, capabilityFlags, authPlugin }
}

/**
 * `mysql_native_password`：SHA1(pw) XOR SHA1(salt + SHA1(SHA1(pw)))。空口令回空。
 */
export function scrambleNative(password: string, salt: Buffer): Buffer {
  if (!password) return Buffer.alloc(0)
  const stage1 = createHash('sha1').update(password, 'utf8').digest()
  const stage2 = createHash('sha1').update(stage1).digest()
  const seeded = createHash('sha1').update(Buffer.concat([salt, stage2])).digest()
  const out = Buffer.alloc(stage1.length)
  for (let i = 0; i < stage1.length; i += 1) out[i] = (stage1[i] ?? 0) ^ (seeded[i] ?? 0)
  return out
}

/**
 * `caching_sha2_password` 的快速认证：SHA256(pw) XOR SHA256(SHA256(SHA256(pw)) + salt)。
 *
 * **只做 fast auth**。服务端回 `0x04`（full authentication required）时不继续：
 * 那条路要先拿到服务端的 RSA 公钥、再用它加密口令 —— 在非 TLS 上等于自己实现一遍
 * `openssl rsautl`，这一版不值得，明确报错让用户改用 native_password 或开 TLS。
 */
export function scrambleCachingSha2(password: string, salt: Buffer): Buffer {
  if (!password) return Buffer.alloc(0)
  const stage1 = createHash('sha256').update(password, 'utf8').digest()
  const stage2 = createHash('sha256').update(stage1).digest()
  const seeded = createHash('sha256').update(Buffer.concat([stage2, salt])).digest()
  const out = Buffer.alloc(stage1.length)
  for (let i = 0; i < stage1.length; i += 1) out[i] = (stage1[i] ?? 0) ^ (seeded[i] ?? 0)
  return out
}

/** 按认证插件名算应答字节。认不出的插件明确报错，不猜。 */
export function scramble(plugin: string, password: string, salt: Buffer): Buffer {
  if (plugin === 'mysql_native_password' || plugin === '') return scrambleNative(password, salt)
  if (plugin === 'caching_sha2_password') return scrambleCachingSha2(password, salt)
  throw new DockerError(
    401,
    `这个 MySQL 用「${plugin}」认证，Kura 还不支持。让容器改用 mysql_native_password 再试（或用命令行连接）。`,
  )
}

/** 构造 HandshakeResponse41。 */
export function buildHandshakeResponse(handshake: MySqlHandshake, options: { user: string; password: string; database?: string }): Buffer {
  const authResponse = scramble(handshake.authPlugin, options.password, handshake.salt)
  const parts: Buffer[] = []
  const head = Buffer.alloc(4)
  // 只声明服务端也支持的能力，否则服务端会按协议错误断开
  head.writeUInt32LE(clientFlags & handshake.capabilityFlags, 0)
  parts.push(head)
  parts.push(Buffer.from([0xff, 0xff, 0xff, 0x00])) // max packet size 16MB
  parts.push(Buffer.from([0x21])) // utf8_general_ci
  parts.push(Buffer.alloc(23)) // reserved
  parts.push(nulString(options.user))
  parts.push(writeLenenc(authResponse.length))
  parts.push(authResponse)
  if (head.readUInt32LE(0) & CLIENT_CONNECT_WITH_DB) parts.push(nulString(options.database ?? ''))
  parts.push(nulString(handshake.authPlugin))
  return Buffer.concat(parts)
}

/** OK 包（0x00）或 ERR 包（0xff）/ EOF 包（0xfe）。 */
export interface MySqlOk {
  affectedRows: number
  lastInsertId: number
  statusFlags: number
  warnings: number
  info: string
}

export function parseOk(payload: Buffer): MySqlOk {
  const r = new Reader(payload)
  r.u8() // header 0x00
  const affectedRows = r.lenenc() ?? 0
  const lastInsertId = r.lenenc() ?? 0
  const statusFlags = r.u16()
  const warnings = r.u16()
  const info = r.remaining > 0 ? r.rest().toString('utf8') : ''
  return { affectedRows, lastInsertId, statusFlags, warnings, info }
}

/** 服务端的错误包。MySQL 的报错信息很有用（`Table 'x' doesn't exist` 之类），原样透出去。 */
export function parseErr(payload: Buffer): { code: string; message: string; sqlState: string } {
  const r = new Reader(payload)
  r.u8() // 0xff
  const code = r.u16()
  // 有 SQL state 标记时（'#'）后跟 5 字节 state
  let sqlState = ''
  if (payload[r.off] === 0x23) {
    r.u8()
    sqlState = payload.toString('utf8', r.off, r.off + 5)
    r.off += 5
  }
  return { code: String(code), sqlState, message: r.rest().toString('utf8') }
}

/** 列定义包（结果集里每个列一个）。 */
export interface MySqlColumn {
  catalog: string
  schema: string
  table: string
  orgTable: string
  name: string
  orgName: string
  charset: number
  columnLength: number
  type: number
  flags: number
  decimals: number
}

/** MySQL 的列类型码（只列界面上要区分的那几个）。 */
export const MySqlType = {
  decimal: 0x00,
  tiny: 0x01,
  short: 0x02,
  long: 0x03,
  float: 0x04,
  double: 0x05,
  null: 0x06,
  timestamp: 0x07,
  longlong: 0x08,
  int24: 0x09,
  date: 0x0a,
  time: 0x0b,
  datetime: 0x0c,
  year: 0x0d,
  newdate: 0x0e,
  varchar: 0x0f,
  bit: 0x10,
  json: 0xf5,
  newdecimal: 0xf6,
  enum: 0xf7,
  set: 0xf8,
  tinyBlob: 0xf9,
  mediumBlob: 0xfa,
  longBlob: 0xfb,
  blob: 0xfc,
  varString: 0xfd,
  string: 0xfe,
  geometry: 0xff,
} as const

/** 二进制大对象类型（这些列的值按字节显示，不当文本）。 */
const blobTypes = new Set<number>([MySqlType.tinyBlob, MySqlType.mediumBlob, MySqlType.longBlob, MySqlType.blob, MySqlType.geometry, MySqlType.bit])

export function isBinaryType(type: number): boolean {
  return blobTypes.has(type)
}

/** 数字类型（界面上右对齐）。 */
const numericTypes = new Set<number>([
  MySqlType.decimal,
  MySqlType.tiny,
  MySqlType.short,
  MySqlType.long,
  MySqlType.float,
  MySqlType.double,
  MySqlType.longlong,
  MySqlType.int24,
  MySqlType.year,
  MySqlType.newdecimal,
])

export function isNumericTypeCode(type: number): boolean {
  return numericTypes.has(type)
}

export function parseColumn(payload: Buffer): MySqlColumn {
  const r = new Reader(payload)
  const catalog = r.lenencBytes()?.toString('utf8') ?? ''
  const schema = r.lenencBytes()?.toString('utf8') ?? ''
  const table = r.lenencBytes()?.toString('utf8') ?? ''
  const orgTable = r.lenencBytes()?.toString('utf8') ?? ''
  const name = r.lenencBytes()?.toString('utf8') ?? ''
  const orgName = r.lenencBytes()?.toString('utf8') ?? ''
  r.lenenc() // 固定 0x0c 的长度
  const charset = r.u16()
  const columnLength = r.u32()
  const type = r.u8()
  const flags = r.u16()
  const decimals = r.u8()
  return { catalog, schema, table, orgTable, name, orgName, charset, columnLength, type, flags, decimals }
}

/** 把列类型码翻成人读的类型名（界面与 SQL 结果都显示它）。 */
export function typeName(type: number, columnLength: number, decimals: number): string {
  const map: Record<number, string> = {
    [MySqlType.decimal]: 'decimal',
    [MySqlType.tiny]: 'tinyint',
    [MySqlType.short]: 'smallint',
    [MySqlType.long]: 'int',
    [MySqlType.float]: 'float',
    [MySqlType.double]: 'double',
    [MySqlType.null]: 'null',
    [MySqlType.timestamp]: 'timestamp',
    [MySqlType.longlong]: 'bigint',
    [MySqlType.int24]: 'mediumint',
    [MySqlType.date]: 'date',
    [MySqlType.time]: 'time',
    [MySqlType.datetime]: 'datetime',
    [MySqlType.year]: 'year',
    [MySqlType.newdate]: 'date',
    [MySqlType.varchar]: 'varchar',
    [MySqlType.bit]: 'bit',
    [MySqlType.json]: 'json',
    [MySqlType.newdecimal]: 'decimal',
    [MySqlType.enum]: 'enum',
    [MySqlType.set]: 'set',
    [MySqlType.tinyBlob]: 'tinyblob',
    [MySqlType.mediumBlob]: 'mediumblob',
    [MySqlType.longBlob]: 'longblob',
    [MySqlType.blob]: 'blob',
    [MySqlType.varString]: 'varchar',
    [MySqlType.string]: 'char',
    [MySqlType.geometry]: 'geometry',
  }
  const base = map[type] ?? `type-${type}`
  // varchar / char / decimal 之类带上长度，和 SHOW COLUMNS 显示的一致
  if ([MySqlType.varchar, MySqlType.varString, MySqlType.string].includes(type as 0x0f | 0xfd | 0xfe) && columnLength > 0) {
    return `${base}(${columnLength})`
  }
  if ([MySqlType.decimal, MySqlType.newdecimal].includes(type as 0 | 0xf6) && columnLength > 0) {
    return `${base}(${columnLength},${decimals})`
  }
  return base
}

// ---------------------------------------------------------------- 结果集

/** 一次 COM_QUERY 的结果：要么是一个结果集，要么是一条命令的状态。 */
export interface MySqlQueryResult {
  kind: 'rows' | 'command'
  columns: Array<{ name: string; type: string; numeric: boolean; binary: boolean }>
  /** 行数据：每个单元格是 `Buffer | null`（保留原始字节，由上层决定怎么显示） */
  rows: Array<Array<Buffer | null>>
  affected: number
  command: string
  warnings: number
}

/** 拆包：MySQL 每个包是 `3 字节长度 + 1 字节序号 + 包体`。 */
interface MySqlPacket {
  seq: number
  payload: Buffer
}

/**
 * 一条连接的读取缓冲。**必须按包边界累积**：TCP 会在任意位置切，
 * 一个包横跨两次 `data` 事件是常态。
 */
class PacketReader {
  private buf: Buffer = Buffer.alloc(0)

  feed(chunk: Buffer): void {
    this.buf = this.buf.length === 0 ? chunk : Buffer.concat([this.buf, chunk])
  }

  next(): MySqlPacket | undefined {
    if (this.buf.length < 4) return undefined
    const len = this.buf.readUIntLE(0, 3)
    if (this.buf.length < 4 + len) return undefined
    const seq = this.buf[3] ?? 0
    const payload = this.buf.subarray(4, 4 + len)
    this.buf = this.buf.subarray(4 + len)
    return { seq, payload }
  }

  get pending(): number {
    return this.buf.length
  }
}

export interface MySqlOptions {
  host: string
  port: number
  user: string
  password?: string
  database?: string
  timeoutMs?: number
  connect?: (host: string, port: number) => net.Socket
}

export class MySqlClient {
  private readonly reader = new PacketReader()
  /**
   * 等着被读走的包。
   *
   * **必须缓冲，不能「没人在等就丢掉」**：TCP 一次 `data` 事件里常常带好几个完整的包
   * （一个 5 行的结果集全挤在 70 字节里就是这种情况），而调用方是一条一条 `read()` 的。
   * 早期版本在这里写 `if (!pending) continue`，等于把多出来的包扔了 ——
   * 表现是「第一个包收到了，后面永远等不到」，非常难查（这里踩过）。
   */
  private readonly inbox: MySqlPacket[] = []
  private readonly queue: Array<{ resolve: (packet: MySqlPacket) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }> = []
  private broken: Error | undefined
  private seq = 0

  private constructor(
    private readonly socket: net.Socket,
    readonly handshake: MySqlHandshake,
  ) {
    socket.setNoDelay(true)
    socket.on('data', (chunk: Buffer) => this.onData(chunk))
    socket.on('error', (error) => this.fail(new DockerError(502, `MySQL 连接出错：${error.message}`)))
    socket.on('close', () => this.fail(new DockerError(502, 'MySQL 连接被关闭')))
  }

  /** 连上、握手、认证。失败时套接字一定被关掉（否则调用方拿不到 client，连接就漏了）。 */
  static async connect(options: MySqlOptions): Promise<MySqlClient> {
    const socket = (options.connect ?? ((host, port) => net.connect({ host, port })))(options.host, options.port)
    let client: MySqlClient | undefined
    try {
      const greeting = await readFirstPacket(socket, options.timeoutMs ?? 10_000)
      const handshake = parseHandshake(greeting)
      client = new MySqlClient(socket, handshake)
      // 握手包是 seq 0，我们的应答必须是 seq 1
      client.seq = 1
      const response = buildHandshakeResponse(handshake, {
        user: options.user,
        password: options.password ?? '',
        database: options.database,
      })
      client.write(response)
      await client.authenticate(handshake, options)
      return client
    } catch (error) {
      client?.close()
      socket.destroy()
      throw error
    }
  }

  private async authenticate(handshake: MySqlHandshake, options: MySqlOptions): Promise<void> {
    for (;;) {
      const packet = await this.read(options.timeoutMs ?? 10_000)
      const head = packet.payload[0]
      if (head === 0x00) return // OK
      if (head === 0xff) {
        const err = parseErr(packet.payload)
        throw new DockerError(401, `MySQL 认证失败（${err.code}）：${err.message}`)
      }
      if (head === 0xfe) {
        // AuthSwitchRequest：服务端要换一种插件
        const r = new Reader(packet.payload, 1)
        const plugin = r.nulString()
        const salt = r.rest()
        this.write(scramble(plugin, options.password ?? '', salt))
        continue
      }
      if (head === 0x01) {
        // caching_sha2_password 的后续：0x03 = fast auth 成功，0x04 = 要 full authentication
        const step = packet.payload[1]
        if (step === 0x03) continue
        if (step === 0x04) {
          throw new DockerError(
            401,
            '这个 MySQL 的口令走的是 caching_sha2_password 的「完整认证」，需要在非 TLS 上加密口令，Kura 这一版没做。' +
              '让容器改用 mysql_native_password（--default-authentication-plugin=mysql_native_password）或用命令行连接。',
          )
        }
        continue
      }
      throw new DockerError(502, `MySQL 认证阶段回了一个认不出的包（0x${(head ?? 0).toString(16)}）`)
    }
  }

  private onData(chunk: Buffer): void {
    this.reader.feed(chunk)
    for (;;) {
      const packet = this.reader.next()
      if (!packet) break
      this.seq = (packet.seq + 1) & 0xff
      const pending = this.queue.shift()
      if (pending) {
        clearTimeout(pending.timer)
        pending.resolve(packet)
      } else {
        // 没人在等（调用方还没发出下一条 read）：**存起来**，等下一条 read() 来取
        this.inbox.push(packet)
      }
    }
  }

  private fail(error: Error): void {
    if (this.broken) return
    this.broken = error
    for (const pending of this.queue.splice(0)) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.socket.destroy()
  }

  private write(payload: Buffer): void {
    const head = Buffer.alloc(4)
    head.writeUIntLE(payload.length, 0, 3)
    head[3] = this.seq
    this.seq = (this.seq + 1) & 0xff
    this.socket.write(Buffer.concat([head, payload]))
  }

  private read(timeoutMs: number): Promise<MySqlPacket> {
    if (this.broken) return Promise.reject(this.broken)
    // 已经缓冲着的包直接给（同一个 chunk 里到的那几个就是从这里出去的）
    const buffered = this.inbox.shift()
    if (buffered) return Promise.resolve(buffered)
    return new Promise<MySqlPacket>((resolve, reject) => {
      const timer = setTimeout(() => {
        const at = this.queue.findIndex((p) => p.timer === timer)
        if (at >= 0) this.queue.splice(at, 1)
        reject(new DockerError(504, 'MySQL 应答超时'))
      }, timeoutMs)
      this.queue.push({ resolve, reject, timer })
    })
  }

  /** 跑一条查询。`limit` 给了就由上层负责拼进 SQL（这里不替你改 SQL）。 */
  async query(sql: string, timeoutMs = 30_000): Promise<MySqlQueryResult> {
    this.write(Buffer.concat([Buffer.from([COM_QUERY]), Buffer.from(sql, 'utf8')]))
    const first = await this.read(timeoutMs)

    if (first.payload[0] === 0xff) {
      const err = parseErr(first.payload)
      throw new DockerError(400, `MySQL（${err.code}）：${err.message}`)
    }
    // OK 包 = 命令类语句（INSERT / UPDATE / DDL …）
    if (first.payload[0] === 0x00) {
      const ok = parseOk(first.payload)
      return { kind: 'command', columns: [], rows: [], affected: ok.affectedRows, command: ok.info || 'OK', warnings: ok.warnings }
    }
    // 0xfb = LOCAL INFILE，我们不带 CLIENT_LOCAL_FILES，理论上不会出现
    if (first.payload[0] === 0xfb) throw new DockerError(400, 'MySQL 要求传文件（LOCAL INFILE），不支持')

    // 否则是列数（lenenc）
    const countReader = new Reader(first.payload)
    const columnCount = countReader.lenenc() ?? 0
    if (columnCount === 0) throw new DockerError(502, 'MySQL 结果集的列数是 0，看不懂')

    const columns: MySqlQueryResult['columns'] = []
    for (let i = 0; i < columnCount; i += 1) {
      const packet = await this.read(timeoutMs)
      const column = parseColumn(packet.payload)
      columns.push({
        name: column.name,
        type: typeName(column.type, column.columnLength, column.decimals),
        numeric: isNumericTypeCode(column.type),
        binary: isBinaryType(column.type),
      })
    }

    // 列定义之后是一个 EOF 包（没有 CLIENT_DEPRECATE_EOF 时）；有的话直接就是行
    let packet = await this.read(timeoutMs)
    if (packet.payload[0] !== 0xfe || isRowPacket(packet.payload, columnCount)) {
      // 不是 EOF：说明这已经是第一行了（服务端没发 EOF 的变体）
    } else {
      packet = await this.read(timeoutMs)
    }

    const rows: Array<Array<Buffer | null>> = []
    for (;;) {
      const payload = packet.payload
      // EOF：0xfe 且长度 < 9（真的一行数据以一个长度前缀开头，不会这么短）
      if (payload[0] === 0xfe && payload.length < 9) break
      if (payload[0] === 0xff) {
        const err = parseErr(payload)
        throw new DockerError(400, `MySQL（${err.code}）：${err.message}`)
      }
      rows.push(parseRow(payload, columnCount))
      packet = await this.read(timeoutMs)
    }

    return { kind: 'rows', columns, rows, affected: -1, command: '', warnings: 0 }
  }

  /** 服务端 / 连接信息（界面「关于这个库」用）。 */
  async serverVersion(): Promise<string> {
    return this.handshake.serverVersion
  }

  close(): void {
    if (this.broken) return
    try {
      this.write(Buffer.from([COM_QUIT]))
    } catch {
      // 已经断了就算了
    }
    this.socket.destroy()
  }
}

/**
 * 一行数据：每列一个 lenenc 字节串（0xfb = NULL）。
 * **保留 Buffer**：BLOB 列是二进制，转 utf8 会坏。
 */
export function parseRow(payload: Buffer, columnCount: number): Array<Buffer | null> {
  const r = new Reader(payload)
  const row: Array<Buffer | null> = []
  for (let i = 0; i < columnCount; i += 1) row.push(r.lenencBytes())
  return row
}

/**
 * 判断一个 `0xfe` 包是「EOF」还是「第一行数据」。
 *
 * 歧义在于：一行的第一个字节也可能是 0xfe（表示长度 254 的字符串）。区分办法是看
 * 包长 —— 真 EOF 都是 5 字节（没有 CLIENT_DEPRECATE_EOF 时）。这里按包长判断。
 */
function isRowPacket(payload: Buffer, columnCount: number): boolean {
  void columnCount
  return payload.length > 5
}

/** 读握手包：连接刚建立，还没有 client 对象，只能裸读一次。 */
function readFirstPacket(socket: net.Socket, timeoutMs: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let buf: Buffer = Buffer.alloc(0)
    const cleanup = (): void => {
      clearTimeout(timer)
      socket.off('data', onData)
      socket.off('error', onError)
      socket.off('close', onClose)
    }
    const onError = (error: Error): void => {
      cleanup()
      reject(new DockerError(502, `连不上 MySQL：${error.message}`))
    }
    const onClose = (): void => {
      cleanup()
      reject(new DockerError(502, '连不上 MySQL：连接被关闭'))
    }
    const onData = (chunk: Buffer): void => {
      buf = Buffer.concat([buf, chunk])
      if (buf.length < 4) return
      const len = buf.readUIntLE(0, 3)
      if (buf.length < 4 + len) return
      cleanup()
      resolve(buf.subarray(4, 4 + len))
    }
    const timer = setTimeout(() => {
      cleanup()
      socket.destroy()
      reject(new DockerError(504, 'MySQL 握手超时'))
    }, timeoutMs)
    socket.on('data', onData)
    socket.on('error', onError)
    socket.on('close', onClose)
  })
}

export { COM_PING, SERVER_MORE_RESULTS_EXISTS }

/** 关掉连接用它（握手失败时也要能彻底断掉）。 */
export function destroySocket(socket: net.Socket): void {
  socket.destroy()
}

export { Reader, writeLenenc }
