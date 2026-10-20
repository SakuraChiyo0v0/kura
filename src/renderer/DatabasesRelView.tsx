import { useCallback, useEffect, useMemo, useState } from 'react'
import { ChevronDown, ChevronRight, Columns3, Play, RefreshCw, Search, Table2 } from 'lucide-react'
import { Banner, Button, EmptyState, Section, SelectField, TextField, useToast } from '@sakura-ui/react'
import type { DatabaseView as DbView } from '../shared/ipc.js'
import type { DbCell, DbColumn, DbQueryResult, DbRowsPage, DbSchemaNode, DbTableDetail, DbTableNode } from '../core/db-browse.js'

/**
 * 关系库（MySQL / MariaDB）的「数据」页：左边 库 → 表，右边表数据 + 结构 + SQL。
 *
 * 信息架构照 DBeaver / pgweb 的共同骨架（连接 → 库 → 表 → 列 → 数据分页 → SQL 与结果），
 * 这是这类工具二十年下来收敛出来的形状，自己发明一套只会让人找不到东西
 * （设计文档 §十一 的调研结论）。
 *
 * 两件这一页刻意做的事：
 * 1. **NULL 与空串分开显示** —— NULL 是灰色斜体，空串就是空白。混在一起排查数据问题是经典的一步走错。
 * 2. **二进制列按十六进制显示** —— 把 BLOB 当 utf8 解释是静默损坏数据（看着有字符、实际全错）。
 */

const icon = { size: 16, strokeWidth: 1.7, 'aria-hidden': true } as const

/** 一页多少行（可改，服务端还会再钳一次上限）。 */
const pageSizes = [50, 100, 200, 500]

function formatCount(n: number): string {
  if (n < 0) return '—'
  if (n < 1000) return String(n)
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`
  return `${(n / 1_000_000).toFixed(1)}M`
}

/** 单元格按 kind 给样式（null 灰斜体、数字右对齐、二进制等宽淡色）。 */
function Cell({ cell, numeric }: { cell: DbCell; numeric: boolean }): React.JSX.Element {
  const className = [
    'kura-rel-cell',
    `kura-rel-cell--${cell.kind}`,
    numeric && cell.kind !== 'null' ? 'is-num' : '',
    cell.truncated ? 'is-truncated' : '',
  ]
    .filter(Boolean)
    .join(' ')
  return (
    <td className={className} title={cell.text.length > 60 ? cell.text : undefined}>
      {cell.text}
    </td>
  )
}

/** 一张结果表：表头 + 行（分页与 SQL 结果共用）。 */
function ResultTable({ columns, rows }: { columns: Array<{ name: string; type: string }>; rows: DbCell[][] }): React.JSX.Element {
  return (
    <div className="kura-rel-tablewrap">
      <table className="kura-rel-table">
        <thead>
          <tr>
            <th className="kura-rel-table__gutter" aria-hidden />
            {columns.map((column, index) => (
              <th key={`${column.name}-${index}`} title={column.type}>
                <span className="kura-rel-table__name">{column.name}</span>
                <span className="kura-rel-table__type">{column.type}</span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, rowIndex) => (
            <tr key={rowIndex}>
              <td className="kura-rel-table__gutter">{rowIndex + 1}</td>
              {row.map((cell, cellIndex) => (
                <Cell key={cellIndex} cell={cell} numeric={/int|decimal|float|double|numeric|real/i.test(columns[cellIndex]?.type ?? '')} />
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length === 0 ? <p className="kura-form__note">这张表还没有数据。</p> : null}
    </div>
  )
}

/** 列结构表。 */
function ColumnsTable({ columns, primaryKey }: { columns: DbColumn[]; primaryKey: string[] }): React.JSX.Element {
  return (
    <table className="kura-rel-table kura-rel-table--cols">
      <thead>
        <tr>
          <th>列</th>
          <th>类型</th>
          <th>可空</th>
          <th>默认值</th>
        </tr>
      </thead>
      <tbody>
        {columns.map((column) => (
          <tr key={column.name}>
            <td>
              <span className="kura-rel-col">
                {primaryKey.includes(column.name) ? <span className="kura-rel-col__pk" title="主键">PK</span> : null}
                <code>{column.name}</code>
              </span>
            </td>
            <td>
              <code className="kura-form__note">{column.type}</code>
            </td>
            <td>{column.nullable ? '是' : '否'}</td>
            <td>{column.defaultValue === null ? <span className="kura-rel-null">NULL</span> : <code>{column.defaultValue}</code>}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

/** 口令输入（和 Redis 那页同一套语义：只留内存，不落盘）。 */
function PasswordPrompt({ onDone, busy }: { onDone: (password: string) => void; busy: boolean }): React.JSX.Element {
  const [value, setValue] = useState('')
  return (
    <Banner
      tone="warning"
      title="需要一个口令才能看数据"
      description={
        <div className="kura-redis-password">
          <p>
            这个数据库不是 Kura 装的，容器里也读不到口令。<strong>口令只留在本机内存里，不保存</strong>，关掉 Kura 就没了。
          </p>
          <form
            className="kura-redis-password__form"
            onSubmit={(e) => {
              e.preventDefault()
              if (value) onDone(value)
            }}
          >
            <TextField label="口令" type="password" value={value} onChange={(e) => setValue(e.target.value)} autoComplete="off" />
            <Button type="submit" variant="secondary" disabled={busy || !value}>
              {busy ? '连接中…' : '连一下'}
            </Button>
          </form>
        </div>
      }
    />
  )
}

export function DatabasesRelView({ databases }: { databases: DbView[] }): React.JSX.Element {
  const toast = useToast()
  // MySQL / MariaDB / PostgreSQL 共用这一套界面：三者都是「schema → 表 → 列 → 行」的形状，
  // 差别（PG 多一层 schema、MySQL 的「库」等于 PG 的库+schema）在服务端那一层已经抹平了。
  const relList = useMemo(
    () => databases.filter((d) => d.engine === 'mysql' || d.engine === 'mariadb' || d.engine === 'postgres'),
    [databases],
  )

  const [selected, setSelected] = useState('')
  const [password, setPassword] = useState('')
  const [needPassword, setNeedPassword] = useState(false)

  const [schemas, setSchemas] = useState<DbSchemaNode[]>([])
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [tablesBySchema, setTablesBySchema] = useState<Record<string, DbTableNode[]>>({})
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  const [current, setCurrent] = useState<{ schema: string; table: string } | null>(null)
  const [detail, setDetail] = useState<DbTableDetail | null>(null)
  const [page, setPage] = useState<DbRowsPage | null>(null)
  const [pageSize, setPageSize] = useState(100)
  const [offset, setOffset] = useState(0)
  const [tab, setTab] = useState<'data' | 'structure'>('data')

  const [sql, setSql] = useState('')
  const [queryResult, setQueryResult] = useState<DbQueryResult | null>(null)
  const [queryError, setQueryError] = useState('')
  const [running, setRunning] = useState(false)

  useEffect(() => {
    if (relList.length === 0) {
      setSelected('')
      return
    }
    setSelected((prev) => (prev && relList.some((d) => d.name === prev) ? prev : relList[0]!.name))
  }, [relList])

  /** 统一处理「可能要口令」的错误。 */
  const handleError = useCallback((caught: unknown, what: string): void => {
    const message = (caught as Error).message
    if (/口令|认证|Access denied|401/i.test(message)) setNeedPassword(true)
    setError(message)
    toast.notify({ title: what, description: message, tone: 'error', duration: 0 })
  }, [toast])

  const pw = password ? { password } : {}

  const loadSchemas = useCallback(async (): Promise<void> => {
    if (!selected) return
    setLoading(true)
    setError('')
    try {
      const list = await window.kura!.databases.schemas(selected, password ? { password } : {})
      setSchemas(list)
      setNeedPassword(false)
      // 只有一个库时自动展开，省一次点击。
      // **展开要连着把表拉回来** —— 只把 schema 塞进 expanded 的话，树上显示的是「读取中…」
      // 而没有任何东西去填（踩过：冒烟里表现为「库出来了、一张表都没有」）。
      if (list.length === 1) {
        const only = list[0]!.name
        setExpanded(new Set([only]))
        try {
          const tables = await window.kura!.databases.tables(selected, only, password ? { password } : {})
          setTablesBySchema((prev) => ({ ...prev, [only]: tables }))
        } catch (caught) {
          handleError(caught, '读不到表列表')
        }
      }
    } catch (caught) {
      handleError(caught, '读不到库列表')
    } finally {
      setLoading(false)
    }
  }, [selected, password, handleError])

  useEffect(() => {
    setSchemas([])
    setTablesBySchema({})
    setExpanded(new Set())
    setCurrent(null)
    setDetail(null)
    setPage(null)
    setQueryResult(null)
    setError('')
    if (selected) void loadSchemas()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected])

  const toggleSchema = async (schema: string): Promise<void> => {
    const next = new Set(expanded)
    if (next.has(schema)) {
      next.delete(schema)
      setExpanded(next)
      return
    }
    next.add(schema)
    setExpanded(next)
    if (tablesBySchema[schema]) return
    try {
      const tables = await window.kura!.databases.tables(selected, schema, pw)
      setTablesBySchema((prev) => ({ ...prev, [schema]: tables }))
    } catch (caught) {
      handleError(caught, '读不到表列表')
    }
  }

  const openTable = async (schema: string, table: string): Promise<void> => {
    setCurrent({ schema, table })
    setTab('data')
    setOffset(0)
    setQueryResult(null)
    setQueryError('')
    setDetail(null)
    setPage(null)
    setError('')
    try {
      const [structure, rows] = await Promise.all([
        window.kura!.databases.table(selected, schema, table, pw),
        window.kura!.databases.rows(selected, { schema, table, offset: 0, limit: pageSize, ...pw }),
      ])
      setDetail(structure)
      setPage(rows)
      // SQL 编辑框预填一句「看这张表」
      setSql(`SELECT * FROM \`${schema}\`.\`${table}\` LIMIT ${pageSize}`)
    } catch (caught) {
      handleError(caught, '读不到表数据')
    }
  }

  const goto = async (nextOffset: number): Promise<void> => {
    if (!current) return
    setError('')
    try {
      const rows = await window.kura!.databases.rows(selected, { schema: current.schema, table: current.table, offset: nextOffset, limit: pageSize, ...pw })
      setPage(rows)
      setOffset(nextOffset)
    } catch (caught) {
      handleError(caught, '翻页失败')
    }
  }

  const changePageSize = async (size: number): Promise<void> => {
    setPageSize(size)
    if (!current) return
    setError('')
    try {
      const rows = await window.kura!.databases.rows(selected, { schema: current.schema, table: current.table, offset: 0, limit: size, ...pw })
      setPage(rows)
      setOffset(0)
    } catch (caught) {
      handleError(caught, '改每页条数失败')
    }
  }

  const runSql = async (): Promise<void> => {
    const text = sql.trim()
    if (!text) return
    setRunning(true)
    setQueryError('')
    setQueryResult(null)
    try {
      const result = await window.kura!.databases.query(selected, text, { ...pw, ...(current?.schema ? { database: current.schema } : {}) })
      setQueryResult(result)
      if (result.kind === 'command') {
        toast.notify({ title: '执行完成', description: result.command || `影响了 ${result.affected} 行`, tone: 'success' })
        // 写了数据：如果正看着同一张表，刷新一下
        if (current) await goto(offset)
      }
    } catch (caught) {
      setQueryError((caught as Error).message)
    } finally {
      setRunning(false)
    }
  }

  if (relList.length === 0) {
    return (
      <div className="kura-placeholder">
        <EmptyState
          icon={<Table2 size={22} aria-hidden />}
          title="没有可浏览的关系库"
          description="NAS 上没有正在运行的 MySQL、MariaDB 或 PostgreSQL 容器。去「安装」装一个，或先启动已有的那个。"
        />
      </div>
    )
  }

  return (
    <Section
      title="数据"
      description="左边选库和表，右边看数据、结构和跑 SQL。数据分页读，不会一次把整张表拉进内存。"
    >
      <div className="kura-rel">
        <div className="kura-rel__bar">
          <SelectField
            label="数据库"
            data-testid="rel-picker"
            value={selected || null}
            onValueChange={setSelected}
            options={relList.map((d) => ({
              value: d.name,
              label: `${d.name}（${d.engine === 'mariadb' ? 'MariaDB' : d.engine === 'postgres' ? 'PostgreSQL' : 'MySQL'}）`,
            }))}
          />
          <SelectField
            label="每页"
            value={String(pageSize)}
            onValueChange={(v) => void changePageSize(Number(v))}
            options={pageSizes.map((n) => ({ value: String(n), label: `${n} 行` }))}
          />
          <Button variant="ghost" icon={<RefreshCw {...icon} />} onClick={() => void loadSchemas()} disabled={loading}>
            {loading ? '读库中…' : '刷新'}
          </Button>
        </div>

        {needPassword ? (
          <PasswordPrompt
            busy={loading}
            onDone={(next) => {
              setPassword(next)
              setNeedPassword(false)
            }}
          />
        ) : null}

        {error && !needPassword ? <Banner tone="danger" title="出错了" description={error} /> : null}

        <div className="kura-rel__body">
          {/* 左：库 → 表 */}
          <div className="kura-rel__tree" data-testid="rel-tree">
            {schemas.length === 0 && !loading ? <p className="kura-form__note">没有可看的库。</p> : null}
            <ul className="kura-rel-tree">
              {schemas.map((schema) => {
                const isOpen = expanded.has(schema.name)
                const tables = tablesBySchema[schema.name]
                return (
                  <li key={schema.name}>
                    <button type="button" className="kura-rel-tree__schema" onClick={() => void toggleSchema(schema.name)}>
                      {isOpen ? <ChevronDown {...icon} /> : <ChevronRight {...icon} />}
                      <span className="kura-rel-tree__name">{schema.name}</span>
                      <span className="kura-rel-tree__count">{schema.tableCount}</span>
                    </button>
                    {isOpen ? (
                      tables ? (
                        <ul className="kura-rel-tree__tables">
                          {tables.map((table) => (
                            <li key={table.name}>
                              <button
                                type="button"
                                className={`kura-rel-tree__table${current?.schema === schema.name && current.table === table.name ? ' is-active' : ''}`}
                                onClick={() => void openTable(schema.name, table.name)}
                                title={table.rowEstimate >= 0 ? `约 ${table.rowEstimate} 行` : undefined}
                              >
                                {table.kind === 'view' ? <Columns3 {...icon} /> : <Table2 {...icon} />}
                                <span className="kura-rel-tree__name">{table.name}</span>
                                <span className="kura-rel-tree__count">{formatCount(table.rowEstimate)}</span>
                              </button>
                            </li>
                          ))}
                        </ul>
                      ) : (
                        <p className="kura-form__note kura-rel-tree__loading">读取中…</p>
                      )
                    ) : null}
                  </li>
                )
              })}
            </ul>
          </div>

          {/* 右：数据 / 结构 / SQL */}
          <div className="kura-rel__main">
            {!current ? (
              <p className="kura-form__note">左边点一张表看数据。</p>
            ) : (
              <>
                <div className="kura-rel__head">
                  <code className="kura-rel__title">
                    {current.schema}.{current.table}
                  </code>
                  {detail ? (
                    <span className="kura-form__note">
                      {detail.kind === 'view' ? '视图' : '表'} · {detail.columns.length} 列 · 约 {formatCount(detail.rowEstimate)} 行
                    </span>
                  ) : null}
                  <div className="kura-rel__tabs">
                    <button type="button" className={`kura-rel__tab${tab === 'data' ? ' is-active' : ''}`} onClick={() => setTab('data')}>
                      数据
                    </button>
                    <button type="button" className={`kura-rel__tab${tab === 'structure' ? ' is-active' : ''}`} onClick={() => setTab('structure')}>
                      结构
                    </button>
                  </div>
                </div>

                {tab === 'data' ? (
                  <>
                    {page ? <ResultTable columns={page.columns} rows={page.rows} /> : <p className="kura-form__note">读取中…</p>}
                    {page ? (
                      <div className="kura-rel__pager">
                        <Button size="sm" variant="ghost" disabled={offset === 0} onClick={() => void goto(Math.max(0, offset - pageSize))}>
                          上一页
                        </Button>
                        <span className="kura-form__note">
                          第 {Math.floor(offset / pageSize) + 1} 页
                          {page.rowEstimate >= 0 ? ` · 共约 ${formatCount(page.rowEstimate)} 行` : ''}
                          {page.hasMore ? '' : ' · 已到最后一页'}
                        </span>
                        <Button size="sm" variant="ghost" disabled={!page.hasMore} onClick={() => void goto(offset + pageSize)}>
                          下一页
                        </Button>
                        {page.ms > 500 ? <span className="kura-form__note">查询用了 {page.ms} ms</span> : null}
                      </div>
                    ) : null}
                  </>
                ) : detail ? (
                  <>
                    <ColumnsTable columns={detail.columns} primaryKey={detail.primaryKey} />
                    {detail.primaryKey.length === 0 ? (
                      <Banner tone="neutral" description="这张表没有主键。翻页与去重会慢，改数据时也容易重复 —— 建议加一个。" />
                    ) : null}
                  </>
                ) : (
                  <p className="kura-form__note">读取中…</p>
                )}

                {/* SQL 编辑：结果直接是表格 */}
                <div className="kura-rel__sql">
                  <form
                    onSubmit={(e) => {
                      e.preventDefault()
                      void runSql()
                    }}
                  >
                    <TextField
                      label="SQL"
                      value={sql}
                      onChange={(e) => setSql(e.target.value)}
                      placeholder="SELECT * FROM ..."
                      spellCheck={false}
                      className="kura-rel__sqlfield"
                    />
                    <div className="kura-form__actions">
                      <Button type="submit" variant="secondary" icon={<Play {...icon} />} disabled={running || !sql.trim()}>
                        {running ? '执行中…' : '执行'}
                      </Button>
                      <span className="kura-form__note">
                        写操作（INSERT / UPDATE / DELETE / DDL）也会真的执行 —— 结果会显示影响行数。
                      </span>
                    </div>
                  </form>

                  {queryError ? <Banner tone="danger" title="SQL 执行失败" description={queryError} /> : null}
                  {queryResult ? (
                    queryResult.kind === 'command' ? (
                      <Banner
                        tone="success"
                        title="执行完成"
                        description={`${queryResult.command || 'OK'}${queryResult.affected >= 0 ? ` · 影响了 ${queryResult.affected} 行` : ''} · ${queryResult.ms} ms`}
                      />
                    ) : (
                      <>
                        {queryResult.truncated ? (
                          <Banner tone="neutral" description="结果太多，只显示了前面一部分。加个 LIMIT 或 WHERE 再查。" />
                        ) : null}
                        <ResultTable columns={queryResult.columns} rows={queryResult.rows} />
                        <p className="kura-form__note">
                          {queryResult.rows.length} 行 · {queryResult.ms} ms
                          <code className="kura-rel__executed"> {queryResult.sql}</code>
                        </p>
                      </>
                    )
                  ) : null}
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </Section>
  )
}

/** 给外面判断用：这一页管哪些引擎。 */
export function handlesRelationEngine(engine: string): boolean {
  return engine === 'mysql' || engine === 'mariadb' || engine === 'postgres'
}
