import { DockerError } from '../docker/engine.js'
import {
  clampPageSize,
  maxPageSize,
  type DbCell,
  type DbColumn,
  type DbQueryResult,
  type DbRowsPage,
  type DbSchemaNode,
  type DbTableDetail,
  type DbTableNode,
} from '../../../src/core/db-browse.js'
import { MySqlClient, type MySqlQueryResult } from './mysql.js'

/**
 * 把 MySQL / MariaDB 的库/表/列/数据翻成 Kura 的浏览形状。
 *
 * 只用 `information_schema` 与普通 SQL（**不依赖任何驱动特性**）：raw 字节 → `DbCell`
 * 的转换在这一层做，界面那边只认 `DbCell`。
 */

/** 系统库：界面上默认不展示（切进去看也行，但别塞进树里干扰）。 */
const systemSchemas = new Set(['information_schema', 'performance_schema', 'mysql', 'sys'])

/** 一页最多多少行由共用上限决定（见 db-browse.ts）。 */
export { maxPageSize }

/** 引号包住标识符：MySQL 用反引号，内部反引号要成对。 */
export function qi(name: string): string {
  return '`' + name.replace(/`/g, '``') + '`'
}

/** 字面量字符串（只用于我们自己拼的 SQL，不进用户输入路径）。 */
function ql(value: string): string {
  return "'" + value.replace(/\\/g, '\\\\').replace(/'/g, "''") + "'"
}

/**
 * 把一个原始单元格转成界面用的 `DbCell`。
 *
 * **二进制列按十六进制显示**：把 BLOB 当 utf8 解释是静默损坏数据（看起来有字符、实际全错）。
 */
function toCell(value: Buffer | null, numeric: boolean, binary: boolean): DbCell {
  if (value === null) return { text: 'NULL', kind: 'null' }
  if (binary) {
    // 只显示前面一段；完整的几十兆 blob 塞进 JSON 会把服务端与界面一起拖死
    const shown = value.subarray(0, 4096)
    return {
      text: `0x${shown.toString('hex')}${value.length > shown.length ? '…' : ''}`,
      kind: 'binary',
      ...(value.length > shown.length ? { truncated: true } : {}),
      bytes: value.length,
    }
  }
  const text = value.toString('utf8')
  if (numeric) return { text, kind: 'number' }
  // 看着像 JSON 的就按 JSON 标（界面上用等宽、能折行）
  const trimmed = text.trim()
  if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
    return { text: clipText(text), kind: 'json' }
  }
  return { text: clipText(text), kind: 'text' }
}

function clipText(text: string): string {
  return text.length > 4000 ? text.slice(0, 4000) + '…' : text
}

/** 列出所有库（schema）与每个库里的表数。 */
export async function listSchemas(client: MySqlClient, options: { includeSystem?: boolean } = {}): Promise<DbSchemaNode[]> {
  const result = await client.query(
    'SELECT table_schema AS name, COUNT(*) AS tables FROM information_schema.tables GROUP BY table_schema ORDER BY table_schema',
  )
  const out: DbSchemaNode[] = []
  for (const row of result.rows) {
    const name = row[0]?.toString('utf8') ?? ''
    if (!name) continue
    if (!options.includeSystem && systemSchemas.has(name.toLowerCase())) continue
    out.push({ name, tableCount: Number(row[1]?.toString('utf8') ?? '0') })
  }
  return out
}

/** 列一个库里的表 / 视图。 */
export async function listTables(client: MySqlClient, schema: string): Promise<DbTableNode[]> {
  const result = await client.query(
    `SELECT table_name, table_type, table_rows FROM information_schema.tables WHERE table_schema = ${ql(schema)} ORDER BY table_name`,
  )
  return result.rows.map((row) => ({
    schema,
    name: row[0]?.toString('utf8') ?? '',
    // information_schema 里是 'BASE TABLE' / 'VIEW'，界面上按小写认
    kind: (row[1]?.toString('utf8') ?? 'BASE TABLE').toLowerCase() === 'view' ? 'view' : 'table',
    // TABLE_ROWS 对 InnoDB 是估计值，可能差很多 —— 界面上要标明「估计」
    rowEstimate: row[2] === null || row[2] === undefined ? -1 : Number(row[2].toString('utf8')),
  }))
}

/** 一张表的结构：列 + 主键 + 行数估计。 */
export async function describeTable(client: MySqlClient, schema: string, table: string): Promise<DbTableDetail> {
  const columns = await client.query(
    `SELECT column_name, column_type, is_nullable, column_default, column_key
       FROM information_schema.columns
      WHERE table_schema = ${ql(schema)} AND table_name = ${ql(table)}
      ORDER BY ordinal_position`,
  )
  const primaryKey: string[] = []
  const list: DbColumn[] = columns.rows.map((row) => {
    const name = row[0]?.toString('utf8') ?? ''
    // column_key 是 'PRI' / 'UNI' / 'MUL' / ''
    const isPk = (row[4]?.toString('utf8') ?? '') === 'PRI'
    if (isPk) primaryKey.push(name)
    return {
      name,
      type: row[1]?.toString('utf8') ?? '',
      nullable: (row[2]?.toString('utf8') ?? 'YES') === 'YES',
      defaultValue: row[3] === null || row[3] === undefined ? null : row[3].toString('utf8'),
      primaryKey: isPk,
    }
  })

  const info = await client.query(
    `SELECT table_type, table_rows FROM information_schema.tables WHERE table_schema = ${ql(schema)} AND table_name = ${ql(table)}`,
  )
  const first = info.rows[0]
  const kind = (first?.[0]?.toString('utf8') ?? 'BASE TABLE').toLowerCase() === 'view' ? 'view' : 'table'
  const rowEstimate = first?.[1] === null || first?.[1] === undefined ? -1 : Number(first[1].toString('utf8'))

  return { schema, name: table, kind, columns: list, primaryKey, rowEstimate }
}

/** 把一次查询结果拍成 `DbRowsPage`（分页与 SQL 编辑共用）。 */
export function toPage(result: MySqlQueryResult, options: { schema: string; table: string; offset: number; limit: number; sql: string; ms: number }): DbRowsPage {
  const columns = result.columns.map((c) => ({ name: c.name, type: c.type }))
  const rows: DbCell[][] = []
  let hasMore = false
  for (let i = 0; i < result.rows.length; i += 1) {
    // 多取一行用来判断「后面还有没有」—— 这一行只用于判断，不返回
    if (i >= options.limit) {
      hasMore = true
      break
    }
    const raw = result.rows[i]!
    rows.push(raw.map((value, index) => toCell(value, result.columns[index]?.numeric ?? false, result.columns[index]?.binary ?? false)))
  }
  return {
    schema: options.schema,
    table: options.table,
    columns,
    rows,
    count: rows.length,
    offset: options.offset,
    hasMore,
    rowEstimate: -1,
    ms: options.ms,
    sql: options.sql,
  }
}

/**
 * 读一页表数据。
 *
 * **多取一行来判断「后面还有没有」**：`LIMIT n+1` 比再跑一次 `COUNT(*)` 便宜得多
 * （InnoDB 的 COUNT 是全表扫描），而精确总数在浏览数据时并没有用 —— 用户要的是「下一页」。
 */
export async function readRows(
  client: MySqlClient,
  options: { schema: string; table: string; offset?: number; limit?: number; orderBy?: string; timeoutMs?: number },
): Promise<DbRowsPage> {
  const limit = clampPageSize(options.limit)
  const offset = Math.max(0, Math.round(options.offset ?? 0))
  const order = options.orderBy ? ` ORDER BY ${qi(options.orderBy)}` : ''
  const sql = `SELECT * FROM ${qi(options.schema)}.${qi(options.table)}${order} LIMIT ${limit + 1} OFFSET ${offset}`

  const startedAt = Date.now()
  const result = await client.query(sql, options.timeoutMs)
  const page = toPage(result, { schema: options.schema, table: options.table, offset, limit, sql, ms: Date.now() - startedAt })

  // 表行数估计（界面上给一句「大概多少行」）
  try {
    const estimate = await client.query(
      `SELECT table_rows FROM information_schema.tables WHERE table_schema = ${ql(options.schema)} AND table_name = ${ql(options.table)}`,
    )
    const raw = estimate.rows[0]?.[0]
    if (raw !== null && raw !== undefined) page.rowEstimate = Number(raw.toString('utf8'))
  } catch {
    // 估计拿不到就不给（界面显示 —），不该让整个请求失败
  }

  return page
}

/**
 * 跑一条用户写的 SQL，结果转成 `DbQueryResult`。
 *
 * 行数上限用**读到一个上限就断开**的方式：MySQL 会把整个结果集推过来，没法在协议层中途喊停，
 * 所以超了之后把剩下的包读掉再截断 —— 不读会让连接错位，比截断更糟。
 */
export async function runQuery(client: MySqlClient, sql: string, options: { timeoutMs?: number; maxRows?: number } = {}): Promise<DbQueryResult> {
  const maxRows = Math.max(1, options.maxRows ?? 2000)
  const startedAt = Date.now()
  const result = await client.query(sql, options.timeoutMs)

  if (result.kind === 'command') {
    return {
      kind: 'command',
      columns: [],
      rows: [],
      affected: result.affected,
      command: result.command,
      truncated: false,
      ms: Date.now() - startedAt,
      sql,
    }
  }

  const truncated = result.rows.length > maxRows
  const rows: DbCell[][] = result.rows.slice(0, maxRows).map((raw) =>
    raw.map((value, index) => toCell(value, result.columns[index]?.numeric ?? false, result.columns[index]?.binary ?? false)),
  )
  return {
    kind: 'rows',
    columns: result.columns.map((c) => ({ name: c.name, type: c.type })),
    rows,
    affected: -1,
    command: '',
    truncated,
    ms: Date.now() - startedAt,
    sql,
  }
}

/** 界面上「这个库是哪来的」用（版本号）。 */
export async function serverInfo(client: MySqlClient): Promise<{ version: string }> {
  return { version: await client.serverVersion() }
}

/** schema 或表名不合规时早报错（避免拼出一句奇怪的 SQL）。 */
export function assertIdentifier(value: string, what: string): void {
  if (!value || value.length > 64) throw new DockerError(400, `${what}名不合法`)
}
