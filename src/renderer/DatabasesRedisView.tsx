import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ChevronRight, KeyRound, Play, RefreshCw, Search, Terminal } from 'lucide-react'
import { Banner, Button, EmptyState, Section, SelectField, TextField, useToast } from '@sakura-ui/react'
import type { DatabaseView as DbView } from '../shared/ipc.js'
import type { RedisKeyEntry, RedisKeyPage, RedisValue } from '../core/db-browse.js'

/**
 * Redis 的「数据」页：左边 key 列表（SCAN 分页 + 前缀过滤），右边选中 key 的值。
 *
 * 和关系库那边刻意不共用一套界面：Redis 没有表、没有列，key 是扁平的一坨。
 * 硬塞进「库→表→列」那套表格两边都别扭（设计文档 §十一 的共同信息架构在这里只借用
 * 「左树右结果」这个骨架，其余按 Redis 自己的形状来）。
 *
 * 一个绕不开的现实：**接管的容器拿不到口令**（没有项目 .env）。所以这一页会先试着连，
 * 拿不到口令时弹一个输入框，口令**只留在这个组件的内存里**，不落盘、不进设置。
 */

const icon = { size: 16, strokeWidth: 1.7, 'aria-hidden': true } as const

/** 一页扫多少（SCAN 的 COUNT 只是提示，服务端还会按条数再截）。 */
const scanCount = 200

/** TTL 显示成「还剩多久」，比一堆秒数好读。 */
function formatTtl(ttl: number): string {
  if (ttl === -1) return '永不过期'
  if (ttl === -2) return '已过期'
  if (ttl < 60) return `${ttl} 秒`
  if (ttl < 3600) return `${Math.round(ttl / 60)} 分钟`
  if (ttl < 86400) return `${Math.round(ttl / 3600)} 小时`
  return `${Math.round(ttl / 86400)} 天`
}

/** 字节数显示。 */
function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

/** 一个值的类型标签配色（按类型分组，扫一眼就知道这个库里有什么）。 */
const typeTone: Record<string, string> = {
  string: 'kura-redis-type--string',
  list: 'kura-redis-type--list',
  set: 'kura-redis-type--set',
  zset: 'kura-redis-type--zset',
  hash: 'kura-redis-type--hash',
  stream: 'kura-redis-type--stream',
}

/** 口令输入框：接管的容器拿不到 .env 时才出现。 */
function PasswordPrompt({ onDone, busy }: { onDone: (password: string) => void; busy: boolean }): React.JSX.Element {
  const [value, setValue] = useState('')
  return (
    <Banner
      tone="warning"
      title="需要一个口令才能看数据"
      description={
        <div className="kura-redis-password">
          <p>
            这个数据库不是 Kura 装的，容器里也读不到口令（可能启动后手动改过）。输一次就能看数据 ——
            <strong>口令只留在本机内存里，不保存</strong>，关掉 Kura 就没了。
          </p>
          <form
            className="kura-redis-password__form"
            onSubmit={(e) => {
              e.preventDefault()
              if (value) onDone(value)
            }}
          >
            <TextField
              label="口令"
              type="password"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder="Redis 的 requirepass"
              autoComplete="off"
            />
            <Button type="submit" variant="secondary" disabled={busy || !value}>
              {busy ? '连接中…' : '连一下'}
            </Button>
          </form>
        </div>
      }
    />
  )
}

interface RedisState {
  page: RedisKeyPage | null
  keys: RedisKeyEntry[]
  /** 翻页历史：点「上一页」要能退回去（SCAN 的游标是单向的，不能反过来算）。 */
  history: string[]
  cursor: string
  match: string
  loading: boolean
  error: string
  needPassword: boolean
}

export function DatabasesRedisView({ databases }: { databases: DbView[] }): React.JSX.Element {
  const toast = useToast()
  const [selected, setSelected] = useState('')
  const [password, setPassword] = useState('')
  const [state, setState] = useState<RedisState>({
    page: null,
    keys: [],
    history: [],
    cursor: '0',
    match: '',
    loading: false,
    error: '',
    needPassword: false,
  })
  const [picked, setPicked] = useState<string>('')
  const [value, setValue] = useState<RedisValue | null>(null)
  const [valueError, setValueError] = useState('')
  const [command, setCommand] = useState('')
  const [commandOut, setCommandOut] = useState('')

  const redisList = useMemo(() => databases.filter((d) => d.engine === 'redis'), [databases])

  useEffect(() => {
    if (redisList.length === 0) {
      setSelected('')
      return
    }
    setSelected((prev) => (prev && redisList.some((d) => d.name === prev) ? prev : redisList[0]!.name))
  }, [redisList])

  /** 扫一页。`cursor` 给了就从那开始，没给就从 0 重新开始。 */
  const scan = useCallback(
    async (options: { cursor?: string; match?: string; append?: boolean; withPassword?: string } = {}): Promise<void> => {
      const name = selected
      if (!name) return
      const cursor = options.cursor ?? '0'
      const match = options.match ?? state.match
      setState((prev) => ({ ...prev, loading: true, error: '', needPassword: false }))
      try {
        const page = await window.kura!.databases.redisKeys(name, {
          cursor,
          match,
          count: scanCount,
          ...(options.withPassword ? { password: options.withPassword } : password ? { password } : {}),
        })
        setState((prev) => ({
          page,
          keys: options.append ? [...prev.keys, ...page.keys] : page.keys,
          // 追加时（「加载更多」）把当前游标压进历史，好让「上一页」能退回来
          history: options.append && prev.cursor !== '0' ? [...prev.history, prev.cursor] : options.append ? prev.history : [],
          cursor: page.cursor,
          match,
          loading: false,
          error: '',
          needPassword: false,
        }))
      } catch (caught) {
        const message = (caught as Error).message
        // 服务端拿不到口令时给的是 401；界面据此弹输入框而不是当成一般失败
        const needPassword = /口令|认证|NOAUTH|401/i.test(message)
        setState((prev) => ({ ...prev, loading: false, error: message, needPassword }))
      }
    },
    [selected, state.match, password],
  )

  // 切库时重扫
  useEffect(() => {
    setValue(null)
    setValueError('')
    setCommandOut('')
    if (!selected) return
    void scan({ cursor: '0', match: '' })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected])

  const loadKey = async (key: string): Promise<void> => {
    setPicked(key)
    setValue(null)
    setValueError('')
    try {
      const result = await window.kura!.databases.redisValue(selected, key, password ? { password } : {})
      setValue(result)
    } catch (caught) {
      setValueError((caught as Error).message)
    }
  }

  const runCommand = async (): Promise<void> => {
    const args = splitCommand(command)
    if (args.length === 0) return
    setCommandOut('')
    try {
      const result = await window.kura!.databases.redisCommand(selected, args, password ? { password } : {})
      setCommandOut(result.text || '(空)')
    } catch (caught) {
      setCommandOut(`[失败] ${(caught as Error).message}`)
    }
  }

  if (redisList.length === 0) {
    return (
      <div className="kura-placeholder">
        <EmptyState
          icon={<KeyRound size={22} aria-hidden />}
          title="没有 Redis"
          description="NAS 上没有正在运行的 Redis 容器。去「安装」装一个，或先启动已有的那个。"
        />
      </div>
    )
  }

  return (
    <Section
      title="数据"
      description="直接看 Redis 里的 key 与值（不用敲命令）。左边的列表按 SCAN 分页扫描，不是一次拉全部 —— 大实例也不会把界面卡住。"
    >
      <div className="kura-redis">
        <div className="kura-redis__bar">
          <SelectField
            label="数据库"
            data-testid="redis-picker"
            value={selected || null}
            onValueChange={setSelected}
            options={redisList.map((d) => ({ value: d.name, label: d.name }))}
          />
          <form
            className="kura-redis__search"
            onSubmit={(e) => {
              e.preventDefault()
              void scan({ cursor: '0', match: state.match })
            }}
          >
            <TextField
              label="过滤（支持 * ? [abc]）"
              value={state.match}
              onChange={(e) => setState((prev) => ({ ...prev, match: e.target.value }))}
              placeholder="如 user:*，留空看全部"
              spellCheck={false}
            />
            <Button type="submit" variant="secondary" icon={<Search {...icon} />} disabled={state.loading}>
              {state.loading ? '扫描中…' : '扫描'}
            </Button>
          </form>
          <Button
            variant="ghost"
            icon={<RefreshCw {...icon} />}
            onClick={() => void scan({ cursor: '0', match: state.match })}
            disabled={state.loading}
          >
            刷新
          </Button>
        </div>

        {state.needPassword ? (
          <PasswordPrompt
            busy={state.loading}
            onDone={(next) => {
              setPassword(next)
              void scan({ cursor: '0', withPassword: next })
            }}
          />
        ) : null}

        {state.error && !state.needPassword ? <Banner tone="danger" title="扫描失败" description={state.error} /> : null}

        <div className="kura-redis__body">
          {/* 左：key 列表 */}
          <div className="kura-redis__keys" data-testid="redis-keys">
            {state.keys.length === 0 && !state.loading ? (
              <p className="kura-form__note">{state.match ? `没有匹配「${state.match}」的 key` : '这个库里还没有 key'}</p>
            ) : null}

            <ul className="kura-redis-list">
              {state.keys.map((entry) => (
                <li key={entry.key}>
                  <button
                    type="button"
                    className={`kura-redis-list__item${picked === entry.key ? ' is-active' : ''}`}
                    onClick={() => void loadKey(entry.key)}
                    title={entry.key}
                  >
                    <ChevronRight {...icon} className="kura-redis-list__chevron" />
                    <span className="kura-redis-list__key">{entry.key}</span>
                    <span className={`kura-redis-type ${typeTone[entry.type] ?? ''}`}>{entry.type}</span>
                    <span className="kura-redis-list__meta">
                      {entry.size}
                      {entry.ttl > 0 ? ` · ${formatTtl(entry.ttl)}` : ''}
                    </span>
                  </button>
                  {entry.preview ? <p className="kura-redis-list__preview">{entry.binary ? entry.preview : entry.preview}</p> : null}
                </li>
              ))}
            </ul>

            <div className="kura-redis__more">
              {state.cursor !== '0' ? (
                <Button variant="ghost" size="sm" disabled={state.loading} onClick={() => void scan({ cursor: state.cursor, append: true })}>
                  {state.loading ? '…' : '加载更多'}
                </Button>
              ) : state.keys.length > 0 ? (
                <span className="kura-form__note">已经扫完了（{state.keys.length} 个）</span>
              ) : null}
              {state.history.length > 0 ? (
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={state.loading}
                  onClick={() => {
                    const history = [...state.history]
                    const prev = history.pop() ?? '0'
                    setState((s) => ({ ...s, history }))
                    void scan({ cursor: prev })
                  }}
                >
                  回到上一页
                </Button>
              ) : null}
            </div>
          </div>

          {/* 右：值 */}
          <div className="kura-redis__value" data-testid="redis-value">
            {valueError ? <Banner tone="danger" title="读不到这个 key" description={valueError} /> : null}
            {!picked ? (
              <p className="kura-form__note">左边点一个 key 看它的值。</p>
            ) : value ? (
              <RedisValueView value={value} />
            ) : !valueError ? (
              <p className="kura-form__note">读取中…</p>
            ) : null}
          </div>
        </div>

        {/* 命令台：浏览之外想跑点别的时不用切页 */}
        <div className="kura-redis__command">
          <form
            className="kura-rules__add"
            onSubmit={(e) => {
              e.preventDefault()
              void runCommand()
            }}
          >
            <TextField
              label="跑一条命令"
              value={command}
              onChange={(e) => setCommand(e.target.value)}
              placeholder="如 LLEN my-list、HGETALL user:1、INFO memory"
              spellCheck={false}
            />
            <Button type="submit" variant="secondary" icon={<Play {...icon} />} disabled={!command.trim()}>
              执行
            </Button>
          </form>
          {commandOut ? (
            <pre className="kura-docker-output__text" data-testid="redis-command-out">
              {commandOut}
            </pre>
          ) : (
            <p className="kura-form__note">
              <Terminal {...icon} /> 命令按空格切分（引号里的算一个参数）。MONITOR / SUBSCRIBE 这类会把连接变成推送流的不支持。
            </p>
          )}
        </div>
      </div>
    </Section>
  )
}

/** 值渲染：每种类型一套排版。 */
function RedisValueView({ value }: { value: RedisValue }): React.JSX.Element {
  const body = value.value
  return (
    <div className="kura-redis-value">
      <div className="kura-redis-value__head">
        <code className="kura-redis-value__key">{value.key}</code>
        <span className={`kura-redis-type ${typeTone[value.type] ?? ''}`}>{value.type}</span>
        <span className="kura-form__note">
          {value.size} 个元素 · {formatTtl(value.ttl)}
        </span>
      </div>

      {value.note ? <Banner tone="neutral" description={value.note} /> : null}
      {value.truncated ? <Banner tone="neutral" description="只显示了前面一部分（元素或字节数超过上限）。要全部的话用下面的命令台。" /> : null}

      {body.kind === 'string' ? (
        body.binary ? (
          <p className="kura-form__note">
            这是一个二进制值（{formatBytes(body.bytes)}），不按文本显示 —— 直接显示会是乱码。
          </p>
        ) : (
          <pre className="kura-docker-output__text">{body.text}</pre>
        )
      ) : null}

      {(body.kind === 'list' || body.kind === 'set') && (
        <ol className="kura-redis-elements">
          {body.items.map((item, index) => (
            <li key={index}>
              <span className="kura-redis-elements__index">{index + 1}</span>
              <code>{item.binary ? `（二进制，${formatBytes(item.text.length)}）` : item.text}</code>
            </li>
          ))}
        </ol>
      )}

      {body.kind === 'hash' && (
        <table className="kura-redis-table">
          <thead>
            <tr>
              <th>字段</th>
              <th>值</th>
            </tr>
          </thead>
          <tbody>
            {body.entries.map((entry) => (
              <tr key={entry.field}>
                <td>
                  <code>{entry.field}</code>
                </td>
                <td>{entry.binary ? <span className="kura-form__note">（二进制）</span> : <code>{entry.text}</code>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {body.kind === 'zset' && (
        <table className="kura-redis-table">
          <thead>
            <tr>
              <th>成员</th>
              <th className="is-num">分数</th>
            </tr>
          </thead>
          <tbody>
            {body.members.map((entry) => (
              <tr key={entry.member}>
                <td>
                  <code>{entry.member}</code>
                </td>
                <td className="is-num">{entry.score}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {body.kind === 'stream' && (
        <div className="kura-redis-stream">
          {body.entries.map((entry) => (
            <div key={entry.id} className="kura-redis-stream__entry">
              <code className="kura-redis-stream__id">{entry.id}</code>
              <table className="kura-redis-table">
                <tbody>
                  {entry.fields.map((field) => (
                    <tr key={field.field}>
                      <td>
                        <code>{field.field}</code>
                      </td>
                      <td>{field.binary ? <span className="kura-form__note">（二进制）</span> : field.text}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

/** 命令按空格切，引号里的算一个参数（和 shell 的最小集一样）。 */
function splitCommand(line: string): string[] {
  const out: string[] = []
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g
  for (let m = re.exec(line); m; m = re.exec(line)) out.push(m[1] ?? m[2] ?? m[3] ?? '')
  return out
}
