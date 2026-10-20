import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { CircleStop, Copy, Database, Ellipsis, KeyRound, Play, Plus, RefreshCw, RotateCcw, Server, Table2, Trash2 } from 'lucide-react'
import {
  ActionMenu,
  Banner,
  Button,
  ConfirmDialog,
  DataTable,
  EmptyState,
  MotionTabs,
  Section,
  SelectField,
  StatusBadge,
  SwitchField,
  TextField,
  useToast,
  type DataTableColumn,
  type StatusTone,
} from '@sakura-ui/react'
import { useSettings } from '@sakura-ui/electron-react'
import type { DatabaseTemplate, DatabaseView as DbView, DbEngine, TunnelStatus, VersionList } from '../shared/ipc.js'
import { kuraSettingsDefaults, type KuraSettings } from '../shared/settings.js'
import { DatabasesRedisView } from './DatabasesRedisView.js'
import { DatabasesRelView } from './DatabasesRelView.js'

/**
 * 「数据库」页：NAS 上 Docker 里的 PostgreSQL / MySQL / MariaDB / Redis。
 *
 * 四块：**数据库**（状态 + 本机隧道）、**连接信息**（复制连接串）、**命令台**（跑 SQL / Redis 命令）、
 * **安装**（模板一键装）。
 *
 * 本页的主要使用方是 AI（MCP 那一侧工具更全）；界面上的命令台是给人看结果、做手边操作的。
 * 隧道把数据库端口开在本机回环上，本地程序（psql / DBeaver / 应用）直连就能用 —— 外网也能连。
 *
 * 关键约束（见 docs/数据库管理 设计.md）：数据库**不发布到 NAS 的局域网**，隧道连的是容器名，
 * 走 kura-server 所在的共享网络。
 */

const icon = { size: 16, strokeWidth: 1.7, 'aria-hidden': true } as const

const engineLabel: Record<DbEngine | '', string> = {
  postgres: 'PostgreSQL',
  mysql: 'MySQL',
  mariadb: 'MariaDB',
  redis: 'Redis',
  '': '未识别',
}

/** 每个引擎的官方 CLI 与一句能跑通的例子（命令台的默认值）。 */
const engineCli: Record<DbEngine, { cli: string; example: string }> = {
  postgres: { cli: 'psql', example: '-c "SELECT version()"' },
  mysql: { cli: 'mysql', example: '-e "SELECT version()"' },
  mariadb: { cli: 'mariadb', example: '-e "SELECT version()"' },
  redis: { cli: 'redis-cli', example: 'PING' },
}

function stateTone(db: DbView): { tone: StatusTone; label: string } {
  if (db.state === 'running') {
    if (db.health === 'unhealthy') return { tone: 'danger', label: '运行中 · 不健康' }
    if (db.health === 'starting') return { tone: 'accent', label: '启动中' }
    return { tone: 'success', label: '运行中' }
  }
  if (db.state === 'missing') return { tone: 'danger', label: '容器不在了' }
  return { tone: 'neutral', label: '已停止' }
}

/** 命令台把一行参数切成 argv —— 引号里的空格算一个参数（`-c "SELECT 1"`）。 */
function splitArgs(line: string): string[] {
  const out: string[] = []
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g
  for (let m = re.exec(line); m; m = re.exec(line)) out.push(m[1] ?? m[2] ?? m[3] ?? '')
  return out
}

/** 没有口令时把 URI 里的口令段换成掩码（界面上默认就不显示口令）。 */
function maskSecret(uri: string): string {
  return uri.replace(/:[^:@/]*@/, ':••••@')
}

/** 一条现成的连接串。口令给了就写进去，没给就留空（界面自己打掩码）。 */
function connectionUri(db: DbView, host: string, port: number, password: string | undefined): string {
  const where = host + ':' + port
  if (db.engine === 'redis') {
    const head = password ? 'redis://:' + password + '@' : 'redis://'
    return head + where + '/0'
  }
  const user = db.user || 'user'
  const scheme = db.engine === 'postgres' ? 'postgresql' : db.engine
  const auth = password ? user + ':' + password : user
  return scheme + '://' + auth + '@' + where + '/' + (db.database || '')
}

/** 给这个数据库的一条现成命令行（连接信息里可以复制的「试试」）。 */
function cliExample(db: DbView, host: string, port: number): string {
  switch (db.engine) {
    case 'redis':
      return 'redis-cli -h ' + host + ' -p ' + port
    case 'mysql':
      return 'mysql -h ' + host + ' -P ' + port + ' -u ' + (db.user || 'root') + ' -p'
    case 'mariadb':
      return 'mariadb -h ' + host + ' -P ' + port + ' -u ' + (db.user || 'root') + ' -p'
    case 'postgres':
      return 'psql -h ' + host + ' -p ' + port + ' -U ' + (db.user || 'postgres') + ' -d ' + (db.database || 'postgres')
    default:
      return ''
  }
}

/** 字节数显示（镜像大小用）。 */
function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(0)} MB`
  return `${(n / 1024 / 1024 / 1024).toFixed(1)} GB`
}

/** 复制一行：左边标签 + 值，右边一个复制按钮。 */
function CopyRow({ label, value, onCopy }: { label: string; value: string; onCopy: () => void }): React.JSX.Element {
  return (
    <div className="kura-db-copy" data-testid={`copy-${label}`}>
      <div>
        <span className="kura-form__note">{label}</span>
        <code className="kura-db-copy__value">{value}</code>
      </div>
      <Button size="sm" variant="ghost" icon={<Copy {...icon} />} onClick={onCopy} aria-label={`复制${label}`}>
        复制
      </Button>
    </div>
  )
}

interface DatabasesState {
  databases: DbView[]
  templates: DatabaseTemplate[]
  tunnels: TunnelStatus[]
  /** 服务端认不认隧道（没登记任何数据库时为 false） */
  tunnelAvailable: boolean
  /** 服务端有没有数据库接口（老镜像没有） */
  supported: boolean
  error: string
}

export function DatabasesView(): React.JSX.Element {
  const toast = useToast()
  const [tab, setTab] = useState('list')
  const [state, setState] = useState<DatabasesState>({ databases: [], templates: [], tunnels: [], tunnelAvailable: false, supported: true, error: '' })
  const [loading, setLoading] = useState(true)
  const [selected, setSelected] = useState('')
  const [removing, setRemoving] = useState<DbView | null>(null)

  const refresh = useCallback(async () => {
    if (!window.kura) return
    try {
      const supported = await window.kura.databases.available()
      if (!supported) {
        setState({ databases: [], templates: [], tunnels: [], tunnelAvailable: false, supported: false, error: '' })
        return
      }
      const [list, templates, tunnels] = await Promise.all([window.kura.databases.list(), window.kura.databases.templates(), window.kura.databases.tunnels()])
      setState({ databases: list.databases, templates, tunnels, tunnelAvailable: list.tunnelAvailable, supported: true, error: '' })
      setSelected((prev) => (prev && list.databases.some((d) => d.name === prev) ? prev : (list.databases[0]?.name ?? '')))
    } catch (caught) {
      setState((prev) => ({ ...prev, error: (caught as Error).message }))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const tunnels = useMemo(() => new Map(state.tunnels.map((t) => [t.name, t])), [state.tunnels])

  if (!state.supported && !loading) {
    return (
      <div className="kura-placeholder">
        <EmptyState
          icon={<Database size={22} aria-hidden />}
          title="NAS 上还没有开数据库管理"
          description="kura-server 需要升级到带数据库管理的版本（服务端清单里出现数据库接口后这里就能用；watchtower 会自动换新镜像）。"
          action={
            <Button variant="secondary" icon={<RefreshCw {...icon} />} onClick={() => void refresh()}>
              重新检测
            </Button>
          }
        />
      </div>
    )
  }

  const openRemove = (db: DbView): void => setRemoving(db)

  // 列表里点库名直接切到它的连接信息：先选中，再跳页
  const openConnect = (name: string): void => {
    setSelected(name)
    setTab('connect')
  }

  return (
    <div className="kura-db" data-testid="db-page">
      {state.error ? <Banner tone="warning" description={`刷新失败：${state.error}（显示的是上一次的状态）`} /> : null}

      <MotionTabs
        label="数据库管理"
        value={tab}
        onValueChange={setTab}
        items={[
          {
            value: 'list',
            label: `数据库 ${state.databases.length}`,
            icon: <Database {...icon} />,
            content: (
              <DatabasesTab
                databases={state.databases}
                tunnels={tunnels}
                onRefresh={refresh}
                onRemove={openRemove}
                onOpenConnect={openConnect}
              />
            ),
          },
          {
            value: 'connect',
            label: '连接信息',
            icon: <Server {...icon} />,
            content: (
              <ConnectTab
                databases={state.databases}
                selected={selected}
                onSelect={setSelected}
                tunnels={tunnels}
                tunnelAvailable={state.tunnelAvailable}
                onRefresh={refresh}
              />
            ),
          },
          {
            value: 'data',
            label: '数据',
            icon: <KeyRound {...icon} />,
            // 两套界面按引擎分派：关系库是「库→表→列 + 表数据 + SQL」，Redis 是「key 列表 + 值」。
            // 硬合成一套两边都别扭（设计文档 §十一）。
            content: <DataTab databases={state.databases} />,
          },
          {
            value: 'query',
            label: '命令台',
            icon: <Play {...icon} />,
            content: <QueryTab databases={state.databases} selected={selected} onSelect={setSelected} />,
          },
          {
            value: 'install',
            label: '安装',
            icon: <Plus {...icon} />,
            content: <InstallTab templates={state.templates} onDone={refresh} />,
          },
        ]}
      />

      {/* 删除确认：由列表里的菜单打开；ConfirmDialog 要求给一个 triggerLabel，那个按钮用 CSS 藏掉 */}
      <div className="kura-db-confirm">
        <ConfirmDialog
          triggerLabel="删除数据库"
          open={removing !== null}
          onOpenChange={(next) => {
            if (!next) setRemoving(null)
          }}
          title={`删除数据库「${removing?.name ?? ''}」？`}
          description="会先停掉容器并移除。数据目录与项目文件都保留 —— 之后点「启动」还能原样建回来（要连数据一起删得去容器页）。"
          confirmLabel="停止并移除容器"
          tone="danger"
          onConfirm={async () => {
            const target = removing
            setRemoving(null)
            if (!target) return
            try {
              await window.kura!.databases.remove(target.name, { volumes: false, files: false })
              toast.notify({ title: '已移除容器', description: `${target.name} 的数据与项目文件都留着`, tone: 'success' })
              await refresh()
            } catch (caught) {
              toast.notify({ title: '删除失败', description: (caught as Error).message, tone: 'error', duration: 0 })
            }
          }}
        />
      </div>
    </div>
  )
}

// ---------------------------------------------------------------- 数据（按引擎分派）

/**
 * 「数据」页：按引擎分派到两套界面。
 *
 * 关系库（MySQL / MariaDB）与 Redis 的数据形状完全不同 —— 一个是 库→表→列 + 行，
 * 一个是扁平的 key→value。硬塞进同一套组件会让两边都不顺手，所以分成两个组件，
 * 这里只做「有没有这类库」的判断。
 */
function DataTab({ databases }: { databases: DbView[] }): React.JSX.Element {
  const relation = databases.filter((d) => d.engine === 'mysql' || d.engine === 'mariadb' || d.engine === 'postgres')
  const redis = databases.filter((d) => d.engine === 'redis')
  const [kind, setKind] = useState('relation')

  if (relation.length === 0 && redis.length === 0) {
    return (
      <div className="kura-placeholder">
        <EmptyState
          icon={<KeyRound size={22} aria-hidden />}
          title="还没有能浏览数据的数据库"
          description="数据浏览支持 PostgreSQL、MySQL、MariaDB 与 Redis。去「安装」装一个，或先启动已有的那个。"
        />
      </div>
    )
  }

  // 两种都有时给一排切换；只有一种就直出那一套
  if (relation.length > 0 && redis.length > 0) {
    return (
      <MotionTabs
        label="数据类型"
        value={kind}
        onValueChange={setKind}
        items={[
          { value: 'relation', label: '表数据', icon: <Table2 {...icon} />, content: <DatabasesRelView databases={databases} /> },
          { value: 'redis', label: 'Redis', icon: <KeyRound {...icon} />, content: <DatabasesRedisView databases={databases} /> },
        ]}
      />
    )
  }

  return relation.length > 0 ? <DatabasesRelView databases={databases} /> : <DatabasesRedisView databases={databases} />
}

// ---------------------------------------------------------------- 列表

function DatabasesTab({
  databases,
  tunnels,
  onRefresh,
  onRemove,
  onOpenConnect,
}: {
  databases: DbView[]
  tunnels: Map<string, TunnelStatus>
  onRefresh: () => Promise<void>
  onRemove: (db: DbView) => void
  /** 点名字直接跳到这个库的「连接信息」 */
  onOpenConnect: (name: string) => void
}): React.JSX.Element {
  const toast = useToast()
  const [busy, setBusy] = useState('')

  const act = async (db: DbView, action: 'start' | 'stop' | 'restart'): Promise<void> => {
    const label = action === 'start' ? '启动' : action === 'stop' ? '停止' : '重启'
    setBusy(`${db.name}:${action}`)
    try {
      await window.kura!.databases.action(db.name, action)
      toast.notify({ title: `${label}：完成`, tone: 'success' })
      await onRefresh()
    } catch (caught) {
      toast.notify({ title: `${label}失败`, description: (caught as Error).message, tone: 'error', duration: 0 })
    } finally {
      setBusy('')
    }
  }

  if (databases.length === 0) {
    return (
      <div className="kura-placeholder">
        <EmptyState
          icon={<Database size={22} aria-hidden />}
          title="还没有发现数据库"
          description="NAS 上 Docker 里的 PostgreSQL / MySQL / MariaDB / Redis 会自动出现在这里；也可以去「安装」一键装一个。"
        />
      </div>
    )
  }

  const columns: DataTableColumn<DbView>[] = [
    {
      id: 'name',
      header: '名称',
      sortValue: (d) => d.name,
      cell: (d) => (
        <div className="kura-db-name">
          <button
            type="button"
            className="kura-db-name__open"
            title="看这个库的连接信息"
            onClick={() => onOpenConnect(d.name)}
          >
            {d.name}
          </button>
          <span className="kura-form__note">
            {engineLabel[d.engine]} · {d.user || '—'}
            {d.managed ? '' : ' · 接管的已有容器'}
          </span>
        </div>
      ),
    },
    {
      id: 'state',
      header: '状态',
      sortValue: (d) => d.state,
      cell: (d) => {
        const t = stateTone(d)
        return (
          <StatusBadge tone={t.tone} dot size="sm">
            {t.label}
          </StatusBadge>
        )
      },
    },
    {
      id: 'port',
      header: '容器端口',
      align: 'end',
      sortValue: (d) => d.port,
      cell: (d) => <code className="kura-docker-image">{d.port || '—'}</code>,
    },
    {
      id: 'tunnel',
      header: '本机隧道',
      cell: (d) => {
        const t = tunnels.get(d.name)
        if (!t) return <span className="kura-form__note">—</span>
        if (t.running) return <code className="kura-docker-image">127.0.0.1:{t.port}</code>
        return <span className="kura-form__note">{t.enabled ? `监听失败${t.lastError ? `：${t.lastError}` : ''}` : '未开启'}</span>
      },
    },
  ]

  return (
    <DataTable
      label="数据库"
      rows={databases}
      columns={columns}
      getRowId={(d) => d.name}
      getRowLabel={(d) => d.name}
      searchText={(d) => `${d.name} ${d.engine} ${d.container}`}
      searchPlaceholder="名字、引擎、容器"
      defaultSort={{ columnId: 'name', direction: 'asc' }}
      pageSize={50}
      rowActions={(d) => (
        <ActionMenu
          label={`${d.name} 的操作`}
          icon={<Ellipsis {...icon} />}
          items={[
            { id: 'start', label: '启动', icon: <Play {...icon} />, disabled: d.state === 'running' },
            { id: 'restart', label: '重启', icon: <RotateCcw {...icon} />, disabled: d.state !== 'running' },
            { id: 'stop', label: '停止', icon: <CircleStop {...icon} />, disabled: d.state !== 'running' },
            // 只删 Kura 自己装的：接管的容器归别的 compose / 应用商店管，Kura 不碰
            { id: 'remove', label: '移除容器（保留数据）', icon: <Trash2 {...icon} />, tone: 'danger', disabled: !d.managed, separatorBefore: true },
          ]}
          onAction={(id) => {
            if (id === 'remove') onRemove(d)
            else void act(d, id as 'start' | 'stop' | 'restart')
          }}
        />
      )}
      toolbar={
        busy ? (
          <span className="kura-form__note" data-testid="db-busy">
            正在执行…
          </span>
        ) : undefined
      }
      emptyLabel="没有数据库"
    />
  )
}

// ---------------------------------------------------------------- 连接信息

function ConnectTab({
  databases,
  selected,
  onSelect,
  tunnels,
  tunnelAvailable,
  onRefresh,
}: {
  databases: DbView[]
  selected: string
  onSelect: (name: string) => void
  tunnels: Map<string, TunnelStatus>
  tunnelAvailable: boolean
  onRefresh: () => Promise<void>
}): React.JSX.Element {
  const toast = useToast()
  const db = databases.find((d) => d.name === selected)
  const tunnel = db ? tunnels.get(db.name) : undefined
  const [password, setPassword] = useState('')

  useEffect(() => setPassword(''), [selected])

  if (!db) {
    return (
      <div className="kura-placeholder">
        <EmptyState icon={<Server size={22} aria-hidden />} title="先选一个数据库" description="装一个，或从列表里挑一个。" />
      </div>
    )
  }

  const host = '127.0.0.1'
  const port = tunnel?.running ? tunnel.port : 0
  const uri = connectionUri(db, host, port || db.port, password || undefined)
  const shownUri = port ? (password ? uri : maskSecret(uri)) : ''

  const copy = async (text: string, what: string): Promise<void> => {
    try {
      await navigator.clipboard.writeText(text)
      toast.notify({ title: `已复制${what}`, tone: 'success' })
    } catch {
      toast.notify({ title: '复制失败', description: '本机剪贴板不可用', tone: 'error' })
    }
  }

  const setEnabled = async (enabled: boolean): Promise<void> => {
    try {
      await window.kura!.databases.tunnelSetEnabled(db.name, enabled)
      await onRefresh()
    } catch (caught) {
      toast.notify({ title: '改隧道失败', description: (caught as Error).message, tone: 'error', duration: 0 })
    }
  }

  return (
    <Section title="连接信息" description="本机程序连这里的地址就能用这个数据库（在家直连、在外走中继，都一样）。">
      <div className="kura-db-connect">
        <SelectField
          label="数据库"
          data-testid="db-picker"
          value={selected || null}
          onValueChange={onSelect}
          options={databases.map((d) => ({ value: d.name, label: `${d.name}（${engineLabel[d.engine]}）` }))}
        />

        {!tunnelAvailable ? (
          <Banner tone="neutral" description="隧道只对 Kura 装过、或能认出引擎的数据库开放。先装一个，或从列表里挑一个。" />
        ) : null}

        <SwitchField
          label="开一条本机隧道"
          description={`把 NAS 上这个数据库的端口开在本机 127.0.0.1 上。数据库本身不会发布到 NAS 的局域网，只有这台电脑上的程序能连。${tunnel?.lastError ? `（上次失败：${tunnel.lastError}）` : ''}`}
          checked={tunnel?.enabled ?? false}
          onCheckedChange={(enabled) => void setEnabled(enabled)}
        />

        {tunnel?.enabled && !tunnel.running ? (
          <Banner tone="warning" title="隧道没有监听成功" description={`本机 ${tunnel.port} 端口绑不上（可能被别的程序占了）。换一个端口再试。`} />
        ) : null}

        <div className="kura-db-portrow">
          <TextField
            label="本机端口"
            value={String(tunnel?.port ?? '')}
            inputMode="numeric"
            onChange={(e) => {
              const next = Number(e.target.value)
              if (!Number.isInteger(next) || next < 1 || next > 65535) return
              void window
                .kura!.databases.tunnelSetPort(db.name, next)
                .then(onRefresh)
                .catch((caught: Error) => toast.notify({ title: '改端口失败', description: caught.message, tone: 'error', duration: 0 }))
            }}
          />
          <Button
            variant="ghost"
            icon={<RefreshCw {...icon} />}
            onClick={() => {
              void window.kura!.databases
                .tunnelPickPort()
                .then((free) => window.kura!.databases.tunnelSetPort(db.name, free))
                .then(onRefresh)
                .catch((caught: Error) => toast.notify({ title: '挑端口失败', description: caught.message, tone: 'error', duration: 0 }))
            }}
          >
            自动挑一个空闲端口
          </Button>
        </div>

        {port ? (
          <div className="kura-db-copies">
            <CopyRow label="连接地址" value={`${host}:${port}`} onCopy={() => void copy(`${host}:${port}`, '地址')} />
            <CopyRow label="连接串" value={shownUri} onCopy={() => void copy(uri, '连接串')} />
            {cliExample(db, host, port) ? <CopyRow label="命令行" value={cliExample(db, host, port)} onCopy={() => void copy(cliExample(db, host, port), '命令')} /> : null}
            <div className="kura-db-copies__foot">
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  if (password) {
                    setPassword('')
                    return
                  }
                  void window.kura!.databases
                    .info(db.name, true)
                    .then((info) => {
                      setPassword(info.password ?? '')
                      if (!info.password) toast.notify({ title: '读不到口令', description: '这个数据库不是 Kura 装的，或项目 .env 里没有口令', tone: 'warning' })
                    })
                    .catch((caught: Error) => toast.notify({ title: '读口令失败', description: caught.message, tone: 'error', duration: 0 }))
                }}
              >
                {password ? '隐藏口令' : '显示口令'}
              </Button>
              <span className="kura-form__note">口令存在 NAS 上项目的 .env 里（唯一真相），Kura 不另存一份。</span>
            </div>
          </div>
        ) : (
          <Banner tone="neutral" description="打开上面的「开一条本机隧道」，这里就会出现可以直接用的连接地址。" />
        )}

        {db.managed && db.port ? (
          <p className="kura-form__note">
            容器内部监听 <code>{db.port}</code>
            {db.user ? ` · 用户名 ${db.user}` : ''}
            {db.database ? ` · 默认库 ${db.database}` : ''}
            {db.dir ? ` · 项目目录 ${db.dir}` : ''}
          </p>
        ) : null}
      </div>
    </Section>
  )
}

// ---------------------------------------------------------------- 命令台

function QueryTab({ databases, selected, onSelect }: { databases: DbView[]; selected: string; onSelect: (name: string) => void }): React.JSX.Element {
  const db = databases.find((d) => d.name === selected)
  const [args, setArgs] = useState('')
  const [output, setOutput] = useState('')
  const [busy, setBusy] = useState(false)
  const pre = useRef<HTMLPreElement>(null)

  const engine = db?.engine || ''
  // engineCli 只按 DbEngine 索引：空串（认不出引擎）时不能直接取
  const engineHelp = engine ? engineCli[engine] : undefined
  useEffect(() => {
    setArgs(engineHelp ? engineHelp.example : '')
    setOutput('')
  }, [selected, engineHelp])

  if (!db) {
    return (
      <div className="kura-placeholder">
        <EmptyState icon={<Play size={22} aria-hidden />} title="先选一个数据库" description="命令在这个数据库的容器里跑（用它自带的官方 CLI）。" />
      </div>
    )
  }

  const cli = engineHelp?.cli ?? ''

  const run = async (): Promise<void> => {
    if (!cli) return
    setBusy(true)
    setOutput('')
    try {
      const result = await window.kura!.databases.exec(db.name, cli, splitArgs(args))
      const parts = [result.stdout.trimEnd()]
      if (result.stderr.trim()) parts.push(`--- stderr ---\n${result.stderr.trimEnd()}`)
      if (result.error) parts.push(`[错误] ${result.error}`)
      parts.push(`（退出码 ${result.exitCode}，${result.durationMs} ms）`)
      setOutput(parts.filter(Boolean).join('\n'))
      requestAnimationFrame(() => pre.current?.scrollTo(0, pre.current.scrollHeight))
    } catch (caught) {
      setOutput(`[失败] ${(caught as Error).message}`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Section
      title="命令台"
      description={`直接在这个数据库里跑命令（用容器自带的 ${cli || 'CLI'}，账号与口令自动带上，不用自己写 -U / -u）。输出是文本；结构化的活建议交给 AI —— Kura 的 MCP 工具更全。`}
    >
      <div className="kura-db-connect">
        <SelectField
          label="数据库"
          data-testid="db-picker-query"
          value={selected || null}
          onValueChange={onSelect}
          options={databases.map((d) => ({ value: d.name, label: `${d.name}（${engineLabel[d.engine]}）` }))}
        />
        <form
          className="kura-rules__add"
          onSubmit={(e) => {
            e.preventDefault()
            void run()
          }}
        >
          <TextField
            label={`${cli} 的参数`}
            value={args}
            onChange={(e) => setArgs(e.target.value)}
            placeholder={engineHelp?.example ?? ''}
            spellCheck={false}
          />
          <Button type="submit" variant="secondary" icon={<Play {...icon} />} disabled={busy || !cli}>
            {busy ? '执行中…' : '执行'}
          </Button>
        </form>
        {output ? (
          <pre className="kura-docker-output__text" ref={pre} data-testid="db-output">
            {output}
          </pre>
        ) : (
          <p className="kura-form__note">命令经 argv 直接发给容器里的 CLI，不经过任何 shell —— 没有注入面。</p>
        )}
      </div>
    </Section>
  )
}

// ---------------------------------------------------------------- 安装

function InstallTab({ templates, onDone }: { templates: DatabaseTemplate[]; onDone: () => Promise<void> }): React.JSX.Element {
  const toast = useToast()
  const [engine, setEngine] = useState<DbEngine>('postgres')
  const [name, setName] = useState('')
  const [installing, setInstalling] = useState(false)
  const [log, setLog] = useState('')

  // 版本与变体：从 Docker Hub 拉，拉不到就回退到模板默认镜像
  const [versions, setVersions] = useState<VersionList | null>(null)
  const [loadingVersions, setLoadingVersions] = useState(false)
  // 镜像站点从设置里读：查版本要经 NAS 出去，国内网络通常只有加速器那条路能通
  const { settings } = useSettings<KuraSettings>(kuraSettingsDefaults)
  const mirror = settings.dbRegistryMirror
  /** 用户选中的完整镜像名；空串 = 用模板默认 */
  const [image, setImage] = useState('')

  const chosen = templates.find((t) => t.engine === engine) ?? templates[0]

  // 切引擎时重新拉版本，并把选择重置回默认
  useEffect(() => {
    setVersions(null)
    setImage('')
    if (!engine) return
    let alive = true
    setLoadingVersions(true)
    void window.kura!.databases
      .versions(engine, mirror)
      .then((list) => {
        if (alive) setVersions(list)
      })
      .catch((caught: Error) => {
        if (alive) {
          setVersions({ engine, repository: engine, versions: [], defaultImage: chosen?.image ?? '', source: 'builtin', error: caught.message })
        }
      })
      .finally(() => {
        if (alive) setLoadingVersions(false)
      })
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engine, mirror])

  /** 实际要装的镜像：用户选了就用它，没选用模板默认。 */
  const effectiveImage = image || chosen?.image || ''

  const install = async (): Promise<void> => {
    const trimmed = name.trim()
    if (!/^[a-z0-9][a-z0-9-]*$/.test(trimmed)) {
      toast.notify({ title: '名字不合规', description: '用小写字母、数字、连字符，字母或数字开头', tone: 'warning' })
      return
    }
    setInstalling(true)
    setLog('')
    try {
      const result = await window.kura!.databases.install(engine, trimmed, effectiveImage || undefined)
      setLog(result.output)
      if (result.ok) {
        toast.notify({ title: '装好了', description: `${trimmed}（${result.image}）已启动，去「连接信息」开隧道拿地址`, tone: 'success' })
        setName('')
        await onDone()
      } else {
        toast.notify({ title: '安装没有成功', description: '看下面的输出', tone: 'error', duration: 0 })
      }
    } catch (caught) {
      setLog(`[失败] ${(caught as Error).message}`)
      toast.notify({ title: '安装失败', description: (caught as Error).message, tone: 'error', duration: 0 })
    } finally {
      setInstalling(false)
    }
  }

  if (templates.length === 0) {
    return (
      <div className="kura-placeholder">
        <EmptyState icon={<Plus size={22} aria-hidden />} title="没有可用的模板" description="服务端没给出任何数据库模板（镜像太旧？）。" />
      </div>
    )
  }

  /** 从模板默认镜像里取仓库名（`postgres:17-alpine` → `postgres`），用来把 tag 拼回完整镜像名。 */
  const repository = (chosen?.image ?? '').split(':')[0] ?? ''
  const imageOfTag = (tag: string): string => (repository ? `${repository}:${tag}` : tag)

  return (
    <Section title="快捷安装" description="用官方镜像装一个数据库：自动生成强口令、建好数据目录、接到共享网络上启动。装完去「连接信息」开本机隧道。">
      <div className="kura-db-connect">
        <div className="kura-db-portrow">
          <SelectField
            label="类型"
            data-testid="db-engine-picker"
            value={engine}
            onValueChange={(v) => setEngine(v as DbEngine)}
            options={templates.map((t) => ({ value: t.engine, label: t.label }))}
          />
          <TextField label="名字" value={name} onChange={(e) => setName(e.target.value)} placeholder="如 my-pg" spellCheck={false} />
        </div>

        {/* 版本选择：从 Docker Hub 拉；拉不到就只显示默认镜像（离线也能装） */}
        <div className="kura-db-portrow">
          {versions && versions.versions.length > 0 ? (
            <SelectField
              label="版本"
              data-testid="db-version-picker"
              value={image || (chosen?.image ?? '')}
              onValueChange={(value) => setImage(value === chosen?.image ? '' : value)}
              options={[
                // 默认镜像放最前：用户不选就是它
                ...(chosen ? [{ value: chosen.image, label: `${chosen.image}（默认）` }] : []),
                ...versions.versions.map((v) => ({
                  value: imageOfTag(v.tag),
                  label: `${v.tag}${v.size ? ` · ${formatBytes(v.size)}` : ''}`,
                })),
              ]}
            />
          ) : (
            // 只有「还在查」或「连内置列表都空」时才会走到这里（listVersions 承诺永远不返空）
            <TextField
              label="版本"
              value={loadingVersions ? '正在查可用版本…' : '用默认镜像'}
              onChange={() => {}}
              disabled
            />
          )}
          <Button
            variant="ghost"
            icon={<RefreshCw {...icon} />}
            onClick={() => {
              if (!engine) return
              setLoadingVersions(true)
              void window.kura!.databases
                .versions(engine, mirror)
                .then(setVersions)
                .catch(() => {})
                .finally(() => setLoadingVersions(false))
            }}
            disabled={loadingVersions}
          >
            重新查
          </Button>
        </div>

        {/* 版本列表的来源说清楚：用兜底列表时告诉用户为什么、以及怎么拿到完整列表 */}
        {versions?.source === 'builtin' ? (
          <Banner
            tone="warning"
            title="列的是内置的常用版本，不是实时的"
            description={
              <>
                NAS 上的 kura-server 查不到 Docker Hub
                {versions.error ? `（${versions.error}）` : ''}。下面这几个版本一定存在、装得起来，但可能不是最新的。
                <br />
                想看到完整列表：在「设置 → 数据库」里填一个镜像站点（如 <code>docker.1ms.run</code>）再回来点「重新查」。
              </>
            }
          />
        ) : null}
        {versions?.source === 'registry' ? (
          <Banner tone="neutral" description={`版本列表来自你配的镜像站点（${mirror}）。`} />
        ) : null}

        {chosen ? (
          <p className="kura-form__note">
            要装的是 <code className="kura-docker-image">{effectiveImage}</code> · 容器内监听 <code>{chosen.port}</code>
            {chosen.username ? ` · 用户名 ${chosen.username}` : ''}
            {chosen.database ? ` · 默认库 ${chosen.database}` : ''}
          </p>
        ) : null}

        <div className="kura-form__actions">
          <Button variant="secondary" icon={<Plus {...icon} />} disabled={installing} onClick={() => void install()}>
            {installing ? '安装中…（拉镜像可能要一两分钟）' : '安装'}
          </Button>
        </div>

        {log ? (
          <pre className="kura-docker-output__text" data-testid="db-install-log">
            {log}
          </pre>
        ) : null}

        <Banner
          tone="neutral"
          description={
            <>
              项目文件落在 NAS 的项目目录里（与容器页同一处），可以用「容器 → 项目」编辑它的 compose；
              数据存在项目目录的 <code>./data</code>，能在「文件」页看到。<strong>数据库不会发布到 NAS 的局域网</strong>
              —— 只有本机隧道这一条路。
            </>
          }
        />
      </div>
    </Section>
  )
}
