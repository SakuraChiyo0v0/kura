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
import type { PgClient, PgResult } from './postgres.js'

/**
 * 把 PostgreSQL 的 schema/表/列/数据翻成 Kura 的浏览形状。
 *
 * 和 MySQL 那份的分工一样：raw 字节 → `DbCell` 的转换都在这一层，
 * 界面只认 `DbCell`，不做任何类型判断。
 *
 * PostgreSQL 与 MySQL 的**根本差别**（界面要照顾）：
 * - PG 有 schema 这一层（`public` 之外），MySQL 的「库」等于 PG 的「库 + schema」；
 * - PG 的 `bigint` / `numeric` 走文本格式传过来（不走二进制），所以数字也是字节串；
 * - PG 的 `bytea` 在文本格式下是 `\x...` 十六进制，**不是原始字节**。
 */

/** 系统 schema：界面上默认不展示。 */
const systemSchemas = new Set(['pg_catalog', 'information_schema', 'pg_toast'])

/** 引号包住标识符：PG 用双引号，内部双引号要成对。 */
export function qi(name: string): string {
  return '"' + name.replace(/"/g, '""') + '"'
}

/** 字面量字符串（只用于我们自己拼的 SQL）。 */
function ql(value: string): string {
  return "'" + value.replace(/'/g, "''") + "'"
}

/**
 * 把一个原始单元格转成界面用的 `DbCell`。
 *
 * PG 的文本格式下：`bytea` 是 `\x` 开头的十六进制、NULL 是 null、
 * bool 是 `t`/`f`（不是 `true`/`false`）。这几处都要在这里统一掉。
 */
function toCell(value: Buffer | null, numeric: boolean, binary: boolean): DbCell {
  if (value === null) return { text: 'NULL', kind: 'null' }

  if (binary) {
    // PG 的文本格式下 bytea 已经是 `\x48656c6c6f` 这种，原样显示即可
    const text = value.toString('utf8')
    return { text, kind: 'binary', bytes: Math.floor(Math.max(0, text.length - 2) / 2) }
  }

  const text = value.toString('utf8')
  if (numeric) return { text, kind: 'number' }
  // PG 的 bool 在文本格式下是 t / f
  if (text === 't' || text === 'f') return { text: text === 't' ? 'true' : 'false', kind: 'bool' }

  const trimmed = text.trim()
  if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
    return { text: clipText(text), kind: 'json' }
  }
  // 时间戳：PG 的格式是 `2026-10-20 11:30:00+08`
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(trimmed)) {
    return { text: clipText(text), kind: 'time' }
  }
  return { text: clipText(text), kind: 'text' }
}

function clipText(text: string): string {
  return text.length > 4000 ? text.slice(0, 4000) + '…' : text
}

/** 列库（schema）。PG 的「库」是 schema；database 是连接时选的那个。 */
export async function listSchemas(client: PgClient, options: { includeSystem?: boolean } = {}): Promise<DbSchemaNode[]> {
  const result = await client.query(
    `SELECT n.nspname AS name,
            (SELECT COUNT(*) FROM pg_class c WHERE c.relnamespace = n.oid AND c.relkind IN ('r','v','m','p')) AS tables
       FROM pg_namespace n
      WHERE n.nspname NOT LIKE 'pg_temp%'
      ORDER BY n.nspname`,
  )
  const out: DbSchemaNode[] = []
  for (const row of result.rows) {
    const name = row[0]?.toString('utf8') ?? ''
    if (!name) continue
    if (!options.includeSystem && (systemSchemas.has(name) || name.startsWith('pg_'))) continue
    out.push({ name, tableCount: Number(row[1]?.toString('utf8') ?? '0') })
  }
  return out
}

/** 列一个 schema 里的表 / 视图 / 物化视图。 */
export async function listTables(client: PgClient, schema: string): Promise<DbTableNode[]> {
  const result = await client.query(
    `SELECT c.relname AS name,
            CASE c.relkind
              WHEN 'r' THEN 'table'
              WHEN 'v' THEN 'view'
              WHEN 'm' THEN 'materialized view'
              WHEN 'p' THEN 'partitioned table'
              WHEN 'f' THEN 'foreign table'
              ELSE 'table'
            END AS kind,
            c.reltuples::bigint AS rows
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = ${ql(schema)} AND c.relkind IN ('r','v','m','p','f')
      ORDER BY c.relname`,
  )
  return result.rows.map((row) => ({
    schema,
    name: row[0]?.toString('utf8') ?? '',
    kind: row[1]?.toString('utf8') ?? 'table',
    // reltuples 对没 ANALYZE 过的表是 -1 或 0 —— 界面上要标明「估计」
    rowEstimate: Number(row[2]?.toString('utf8') ?? '-1'),
  }))
}

/** 一张表的结构：列 + 主键 + 行数估计。 */
export async function describeTable(client: PgClient, schema: string, table: string): Promise<DbTableDetail> {
  const columns = await client.query(
    `SELECT a.attname AS name,
            format_type(a.atttypid, a.atttypmod) AS type,
            NOT a.attnotnull AS nullable,
            pg_get_expr(d.adbin, d.adrelid) AS default_value,
            COALESCE(pk.is_pk, false) AS is_pk,
            a.attnum
       FROM pg_attribute a
       JOIN pg_class c ON c.oid = a.attrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
       LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
       LEFT JOIN LATERAL (
         SELECT true AS is_pk
           FROM pg_index i
          WHERE i.indrelid = c.oid AND i.indisprimary AND a.attnum = ANY(i.indkey)
       ) pk ON true
      WHERE n.nspname = ${ql(schema)} AND c.relname = ${ql(table)} AND a.attnum > 0 AND NOT a.attisdropped
      ORDER BY a.attnum`,
  )

  const primaryKey: string[] = []
  const list: DbColumn[] = columns.rows.map((row) => {
    const name = row[0]?.toString('utf8') ?? ''
    const isPk = (row[4]?.toString('utf8') ?? 'f') === 't'
    if (isPk) primaryKey.push(name)
    return {
      name,
      type: row[1]?.toString('utf8') ?? '',
      nullable: (row[2]?.toString('utf8') ?? 't') === 't',
      defaultValue: row[3] === null || row[3] === undefined ? null : row[3].toString('utf8'),
      primaryKey: isPk,
    }
  })

  const info = await client.query(
    `SELECT CASE c.relkind WHEN 'v' THEN 'view' WHEN 'm' THEN 'materialized view' ELSE 'table' END AS kind,
            c.reltuples::bigint AS rows
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = ${ql(schema)} AND c.relname = ${ql(table)}`,
  )
  const first = info.rows[0]
  return {
    schema,
    name: table,
    kind: first?.[0]?.toString('utf8') ?? 'table',
    columns: list,
    primaryKey,
    rowEstimate: Number(first?.[1]?.toString('utf8') ?? '-1'),
  }
}

/** 把一次查询结果拍成 `DbRowsPage`。 */
export function toPage(result: PgResult, options: { schema: string; table: string; offset: number; limit: number; sql: string; ms: number }): DbRowsPage {
  const columns = result.columns.map((c) => ({ name: c.name, type: c.type }))
  const rows: DbCell[][] = []
  let hasMore = false
  for (let i = 0; i < result.rows.length; i += 1) {
    if (i >= options.limit) {
      hasMore = true
      break
    }
    rows.push(result.rows[i]!.map((value, index) => toCell(value, result.columns[index]?.numeric ?? false, result.columns[index]?.binary ?? false)))
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
 * `LIMIT n+1` 判断「后面还有没有」（和 MySQL 那边同一套理由：
 * `COUNT(*)` 在大表上是全表扫描，而浏览数据时用户要的是「下一页」不是精确总数）。
 */
export async function readRows(
  client: PgClient,
  options: { schema: string; table: string; offset?: number; limit?: number; orderBy?: string; timeoutMs?: number },
): Promise<DbRowsPage> {
  const limit = clampPageSize(options.limit)
  const offset = Math.max(0, Math.round(options.offset ?? 0))
  const order = options.orderBy ? ` ORDER BY ${qi(options.orderBy)}` : ''
  const sql = `SELECT * FROM ${qi(options.schema)}.${qi(options.table)}${order} LIMIT ${limit + 1} OFFSET ${offset}`

  const startedAt = Date.now()
  const result = await client.query(sql, options.timeoutMs)
  const page = toPage(result, { schema: options.schema, table: options.table, offset, limit, sql, ms: Date.now() - startedAt })

  try {
    const estimate = await client.query(
      `SELECT c.reltuples::bigint FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = ${ql(options.schema)} AND c.relname = ${ql(options.table)}`,
    )
    const raw = estimate.rows[0]?.[0]
    if (raw !== null && raw !== undefined) page.rowEstimate = Number(raw.toString('utf8'))
  } catch {
    // 估计拿不到就不给
  }

  return page
}

/** 跑一条用户写的 SQL。 */
export async function runQuery(client: PgClient, sql: string, options: { timeoutMs?: number; maxRows?: number } = {}): Promise<DbQueryResult> {
  const maxRows = Math.max(1, options.maxRows ?? 2000)
  const startedAt = Date.now()
  const result = await client.query(sql, options.timeoutMs)

  if (result.kind === 'command' || result.columns.length === 0) {
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

/** 服务端版本。 */
export function serverInfo(client: PgClient): { version: string } {
  return { version: client.serverVersion() }
}

/** schema 或表名不合规时早报错。 */
export function assertIdentifier(value: string, what: string): void {
  if (!value || value.length > 63) throw new DockerError(400, `${what}名不合法`)
}

export { maxPageSize }
