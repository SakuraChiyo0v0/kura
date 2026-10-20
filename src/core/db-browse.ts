/**
 * 数据浏览的形状：kura-server 产出、客户端「数据」页消费，两边共用这一份。
 * 只放类型与纯函数，不碰网络（server/ 也会打包它）。设计见 docs/数据库管理 设计.md 的 M2。
 *
 * 和 `db-types.ts` 的分工：那个是「这个数据库存在吗、怎么连」，这个是「库里有什么数据」。
 */

// ---------------------------------------------------------------- 关系库

/** 一棵库→表树的节点。schema 在 PG 里是 schema（public），MySQL 里就是库名。 */
export interface DbSchemaNode {
  /** 显示名（PG 的 schema 名 / MySQL 的库名） */
  name: string
  /** 这个库里有多少张表；查不出时为 -1 */
  tableCount: number
}

/** 一张表（或视图）的概览 —— 树上的一个叶子。 */
export interface DbTableNode {
  schema: string
  name: string
  /** 'table' / 'view' / 'materialized view' / 'partitioned table' … */
  kind: string
  /** 估计行数；-1 = 不知道（PG 没 ANALYZE 过的表统计是 0，MySQL 的 TABLE_ROWS 也是估计） */
  rowEstimate: number
}

/** 一列的结构。 */
export interface DbColumn {
  name: string
  /** 后端原样的类型名（`character varying(255)`、`int unsigned`、`uuid`…） */
  type: string
  nullable: boolean
  /** 默认值表达式；没有就是 null */
  defaultValue: string | null
  /** 是不是主键的一部分 */
  primaryKey: boolean
}

/** 一张表的完整结构。 */
export interface DbTableDetail {
  schema: string
  name: string
  kind: string
  columns: DbColumn[]
  /** 主键列（按顺序）；没有主键就是空数组 */
  primaryKey: string[]
  rowEstimate: number
}

/**
 * 一页数据。
 *
 * **值一律是「已经定好怎么显示」的形状**，不是原始类型：界面不做类型判断，
 * 服务端把 `null`、二进制、超长文本、时间戳都在这里处理掉 —— 两处各判一遍必然漂移。
 */
export interface DbRowsPage {
  schema: string
  table: string
  columns: Array<{ name: string; type: string }>
  rows: DbCell[][]
  /** 这一页有多少行 */
  count: number
  /** 跳过多少行 */
  offset: number
  /** 后面还有没有（有就说明可能还有更多，不是精确总数） */
  hasMore: boolean
  /** 估计总行数；-1 = 不知道 */
  rowEstimate: number
  /** 这条查询花了多少毫秒（界面给一句提示，慢的时候用户能看出来） */
  ms: number
  /** 实际执行的 SQL（界面上「看看跑了什么」用；含 offset/limit 之后的样子） */
  sql: string
}

/** 一个单元格。`kind` 决定界面怎么画。 */
export interface DbCell {
  /** 显示出来的文本（null 会显示成 `NULL`，但那要跟真的空串区分开） */
  text: string
  /** 值的种类：决定要不要用等宽/灰色/斜体 */
  kind: 'text' | 'number' | 'null' | 'binary' | 'json' | 'bool' | 'time'
  /** 被截断了没有（超长文本只显示前面一段） */
  truncated?: boolean
  /** 原始字节数（二进制/截断时有用） */
  bytes?: number
}

/** 一条 SQL 的执行结果：可能是结果集，也可能只是「影响了 N 行」。 */
export interface DbQueryResult {
  /** 'rows' = 有结果集；'command' = INSERT/UPDATE/DDL 之类 */
  kind: 'rows' | 'command'
  /** 有结果集时的列 */
  columns: Array<{ name: string; type: string }>
  /** 有结果集时的行 */
  rows: DbCell[][]
  /** 命令类语句的影响行数；不知道就是 -1 */
  affected: number
  /** 后端原样的一句话（`INSERT 0 1`、`Query OK, 3 rows affected`） */
  command: string
  /** 结果被截断了没有（行数或列数超上限） */
  truncated: boolean
  ms: number
  /** 实际执行的 SQL */
  sql: string
}

// ---------------------------------------------------------------- 上限

/**
 * 一页最多多少行。用户能改，但有上限 —— 界面是虚拟滚动的，
 * 真拉 10 万行进来浏览器会卡死，而用户其实只看前几屏。
 */
export const maxPageSize = 500
export const defaultPageSize = 100
/**
 * 一条 SQL 最多回多少行。超过就截断并明说 ——
 * 静默截断比报错更坏：用户会以为「这个表就这么多数据」。
 */
export const maxQueryRows = 2000
/** 一个文本单元格最多显示多少字符。 */
export const maxCellChars = 4000
/** 一个值最多取多少字节（二进制/blob）。 */
export const maxCellBytes = 64 * 1024

export function clampPageSize(value: unknown): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : defaultPageSize
  return Math.max(1, Math.min(n, maxPageSize))
}

// ---------------------------------------------------------------- 值 → 单元格

/**
 * 把一个后端值变成单元格。
 *
 * **`null` 与空串必须能区分开**：它们在界面上一个显示 `NULL`（灰色斜体），一个显示空。
 * 混在一起会让人以为「这里没值」而实际是空串，排查数据问题时这是经典的一步走错。
 */
export function toCell(value: unknown): DbCell {
  if (value === null || value === undefined) return { text: 'NULL', kind: 'null' }
  if (typeof value === 'boolean') return { text: value ? 'true' : 'false', kind: 'bool' }
  if (typeof value === 'number') return { text: String(value), kind: 'number' }
  if (typeof value === 'bigint') return { text: value.toString(), kind: 'number' }
  if (value instanceof Date) return { text: value.toISOString(), kind: 'time' }

  if (Buffer.isBuffer(value)) {
    const bytes = value.length
    const shown = value.subarray(0, maxCellBytes)
    return {
      text: `\\x${shown.toString('hex')}${bytes > maxCellBytes ? '…' : ''}`,
      kind: 'binary',
      truncated: bytes > maxCellBytes,
      bytes,
    }
  }

  if (Array.isArray(value)) {
    const text = JSON.stringify(value.map((v) => (Buffer.isBuffer(v) ? `\\x${v.toString('hex')}` : v)))
    return clip(text, 'json')
  }
  if (typeof value === 'object') {
    // JSON / JSONB 列：驱动会解析成对象
    let text: string
    try {
      text = JSON.stringify(value)
    } catch {
      text = String(value)
    }
    return clip(text, 'json')
  }

  const text = String(value)
  // 看着像 JSON 的字符串（PG 的 json 列有些驱动会以字符串给）就按 JSON 显示
  const trimmed = text.trim()
  if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
    return clip(text, 'json')
  }
  return clip(text, 'text')
}

function clip(text: string, kind: DbCell['kind']): DbCell {
  if (text.length <= maxCellChars) return { text, kind }
  return { text: text.slice(0, maxCellChars) + '…', kind, truncated: true, bytes: text.length }
}

/** 整数类型的列名/类型判断（界面右对齐用）。 */
export function isNumericType(type: string): boolean {
  return /^(int|bigint|smallint|tinyint|mediumint|numeric|decimal|real|double|float|serial|bigserial|money)/i.test(type)
}

// ---------------------------------------------------------------- Redis

/**
 * Redis 的一个 key。
 *
 * 和关系库刻意长得不一样：Redis 没有表也没有列，key 是扁平的一坨。
 * 硬塞进「库→表→列」那套界面两边都别扭，所以单独一套形状。
 */
export interface RedisKeyEntry {
  key: string
  /** string / list / set / zset / hash / stream / none */
  type: string
  /** 元素个数（string 是字节数） */
  size: number
  /** 过期还剩多少秒；-1 = 不过期，-2 = 不存在 */
  ttl: number
  /** 预览（string 的前若干字节，其它类型为空） */
  preview: string
  /** 预览是不是二进制（界面据此不显示乱码） */
  binary: boolean
}

export interface RedisKeyPage {
  keys: RedisKeyEntry[]
  /** 这次的游标；'0' = 扫完了 */
  cursor: string
  scanned: number
}

export type RedisValueBody =
  | { kind: 'string'; text: string; binary: boolean; bytes: number }
  | { kind: 'list'; items: Array<{ text: string; binary: boolean }> }
  | { kind: 'set'; items: Array<{ text: string; binary: boolean }> }
  | { kind: 'hash'; entries: Array<{ field: string; text: string; binary: boolean }> }
  | { kind: 'zset'; members: Array<{ member: string; score: number }> }
  | { kind: 'stream'; entries: Array<{ id: string; fields: Array<{ field: string; text: string; binary: boolean }> }> }
  | { kind: 'other'; extra: string }

export interface RedisValue {
  key: string
  type: string
  ttl: number
  size: number
  value: RedisValueBody
  /** 截断了没有（元素超上限、或值的字节超上限） */
  truncated: boolean
  /** 认不出的类型时的说明 */
  note?: string
}

/** 口令是从哪来的：界面据此决定要不要弹「输一次口令」的框。 */
export type PasswordSource = 'container' | 'env' | 'client' | ''

/** 口令拿不到时抛的那个错里带的标记（客户端据此弹输入框，而不是当成普通失败）。 */
export const needPasswordCode = 'DB_NEED_PASSWORD'
