import { errorMessage } from '../core/errors.js'
import { request as defaultRequest, type HttpRequester } from '../core/http.js'
import { tcpReachable } from '../core/link.js'
import type { Logger } from '../core/log.js'
import { Mirror, type ConnectionConfig, type MirrorOptions } from '../core/mirror.js'
import { UgreenClient, appBase } from '../core/ugreen.js'
import { lookupUglink, normalizeAlias, type UglinkInfo } from '../core/uglink.js'
import type { ConnectionForm, ConnectionSummary, ConnectionTestResult, ConnectionTestStep } from '../shared/ipc.js'
import type { CredentialVault } from './vault.js'

/**
 * 校验并规范化表单；密码留空表示沿用已保存的值。
 *
 * 设备域由 `info`（查 UGREENlink ID 的结果）带进来，不在表单里 —— 用户填的是 ID。
 * 局域网地址优先用用户填的（家里网段可能和绿联记的不一样），留空才用查询结果。
 */
export function mergeForm(form: ConnectionForm, saved: ConnectionConfig | undefined, info: UglinkInfo): ConnectionConfig {
  const uglinkId = info.id
  const base = info.base.replace(/\/+$/, '')
  appBase(base, 1) // 设备域不对直接报错（必须是 https://<设备>.<节点>.ug.link）
  const ugreenUser = form.ugreenUser.trim()
  if (!ugreenUser) throw new Error('请填写绿联账号')
  const ugreenPassword = form.ugreenPassword || saved?.ugreenPassword || ''
  if (!ugreenPassword) throw new Error('请填写绿联密码')
  const gatewayPort = Number(form.gatewayPort) || 0
  if (gatewayPort < 0 || gatewayPort > 65535) throw new Error(`网关端口 ${form.gatewayPort} 不合法`)
  // 局域网地址不是必填：查不到、或用户不想用，就纯走外网中继。
  // 只有明确要求「局域网」模式才必须有 —— 那个模式没地址根本没法工作。
  const lanHost = form.lanHost.trim() || info.lanHost
  if (form.mode === 'lan' && !lanHost) throw new Error('局域网模式必须有 NAS 局域网地址；不知道就选「自动」或「外网」')
  return {
    uglinkId,
    base,
    ugreenUser,
    ugreenPassword,
    lanHost,
    mode: form.mode,
    gatewayPort,
  }
}

export function summarize(config: ConnectionConfig | undefined): ConnectionSummary {
  return {
    configured: config !== undefined,
    uglinkId: config?.uglinkId ?? '',
    base: config?.base ?? '',
    ugreenUser: config?.ugreenUser ?? '',
    hasUgreenPassword: Boolean(config?.ugreenPassword),
    lanHost: config?.lanHost ?? '',
    mode: config?.mode ?? 'auto',
    gatewayPort: config?.gatewayPort ?? 8898,
  }
}

/** 测试过程中的进度：先给整份「要做哪些步」，再每完成一步推一条，最后 done。 */
export type TestProgress =
  | { phase: 'plan'; names: string[] }
  | { phase: 'step'; step: ConnectionTestStep }
  | { phase: 'done' }

export type TestProgressSink = (progress: TestProgress) => void

/**
 * 按配置实际走一遍：查 UGREENlink ID → 绿联登录 → 网关端口会话 → 局域网可达。
 * 每一步只报「通过 / 失败 + 原因」，不回传任何令牌。后面的步骤依赖前面的，失败就停。
 *
 * `onProgress` 每完成一步回调一次（界面靠它逐条点亮；不传就只拿最终结果）。
 * `info` 是已经查好的解析结果；不传就自己查（设置页改密码时不必再查一遍，直接复用已保存的 base）。
 */
export async function testConnection(
  config: ConnectionConfig,
  request: HttpRequester = defaultRequest,
  info?: UglinkInfo,
  onProgress?: TestProgressSink,
): Promise<ConnectionTestResult> {
  const steps: ConnectionTestStep[] = []
  const push = (step: ConnectionTestStep): void => {
    steps.push(step)
    onProgress?.({ phase: 'step', step })
  }

  if (info && config.uglinkId) {
    push({
      name: 'UGREENlink ID',
      ok: true,
      detail: `${info.id} → ${info.base}${info.lanHost ? ` · 局域网 ${info.lanHost}` : ''}`,
    })
  }

  // 先把后面的步骤名一次性报给界面，让它们一开始就以「转圈」出现，而不是一条条蹦出来
  const plan = ['绿联账号登录']
  if (config.gatewayPort) plan.push(`网关端口 ${config.gatewayPort} 会话`)
  if (config.lanHost) plan.push('局域网可达')
  onProgress?.({ phase: 'plan', names: plan })

  const ugreen = new UgreenClient({ base: config.base, username: config.ugreenUser, password: config.ugreenPassword }, request)

  let apiToken = ''
  try {
    apiToken = await ugreen.login()
    push({ name: '绿联账号登录', ok: true, detail: '登录成功' })
  } catch (error) {
    push({ name: '绿联账号登录', ok: false, detail: errorMessage(error) })
    return { ok: false, steps }
  }

  if (config.gatewayPort) {
    try {
      const redirect = await ugreen.dockerToken(config.gatewayPort, apiToken)
      await ugreen.fetchSsoCookie(redirect)
      push({ name: `网关端口 ${config.gatewayPort} 会话`, ok: true, detail: '已建立' })
    } catch (error) {
      push({ name: `网关端口 ${config.gatewayPort} 会话`, ok: false, detail: errorMessage(error) })
      return { ok: false, steps }
    }
  }

  if (config.lanHost) {
    const port = config.gatewayPort || 80
    const ok = await tcpReachable(config.lanHost, port, 1_500)
    // 局域网不可达不算失败：人在外面时本来就连不上，auto 模式会自动走外网
    push({
      name: '局域网可达',
      ok,
      detail: ok ? `${config.lanHost}:${port} 可连接` : `当前连不上 ${config.lanHost}:${port}（不在家时正常，自动模式会走外网）`,
    })
  }

  const required = steps.filter((step) => step.name !== '局域网可达')
  return { ok: required.every((step) => step.ok), steps }
}

/**
 * 主进程里的连接服务：持有加密存储与当前的 Mirror 实例。
 * 保存新配置 = 停掉旧 Mirror、按新配置重建（端口、凭据、链路都可能变了）。
 */
/** 查 ID 的结果在这么久之内可以复用（测试连接 → 保存，用户一般几秒内就点）。 */
const resolveReuseMs = 5 * 60_000

export class ConnectionService {
  private mirror: Mirror | undefined
  private config: ConnectionConfig | undefined
  private lastResolved: { info: UglinkInfo; at: number } | undefined
  private readonly mirrorListeners = new Set<(mirror: Mirror | undefined) => void>()

  /** 映射实例换了（启动、保存新配置、清除）时回调：主进程借此重新挂推送。 */
  onMirrorChange(listener: (mirror: Mirror | undefined) => void): () => void {
    this.mirrorListeners.add(listener)
    return () => this.mirrorListeners.delete(listener)
  }

  private emitMirror(): void {
    for (const listener of this.mirrorListeners) listener(this.mirror)
  }

  /** 配置读过没有；undefined = 还没读（见下面 loadConfig 的说明） */
  private loaded = false

  constructor(
    private readonly vault: CredentialVault,
    private readonly mirrorOptions: Omit<MirrorOptions, 'config'>,
    private readonly log: Logger,
    /** 测试接缝：Mirror 建好、启动前调用 */
    private readonly onMirrorCreated?: (mirror: Mirror) => void,
  ) {}

  /**
   * 惰性读配置，而不是在构造函数里读。
   *
   * 坑：连接服务是在模块顶层 `new` 的，那时 `app.whenReady()` 还没发生，而
   * `safeStorage` 在 ready 之前**不可用**（实测抛 “safeStorage cannot be used before app is ready”，
   * `isEncryptionAvailable()` 也返回 false）。在构造函数里读的话，`vault.load()` 每次都失败，
   * 磁盘上明明存着凭据，却每次都当没配置 —— 表现就是「每次启动都弹引导页让你重填」。
   * 现在改成第一次真正要用时才读，调用点全在 ready 之后。
   */
  private loadConfig(): ConnectionConfig | undefined {
    if (!this.loaded) {
      this.config = this.vault.load()
      this.loaded = true
    }
    return this.config
  }

  summary(): ConnectionSummary {
    return summarize(this.loadConfig())
  }

  current(): Mirror | undefined {
    return this.mirror
  }

  async start(): Promise<void> {
    const config = this.loadConfig()
    if (!config || this.mirror) return
    this.mirror = new Mirror({ ...this.mirrorOptions, config })
    this.onMirrorCreated?.(this.mirror)
    // 先告诉订阅方「换实例了」再启动：启动过程中的变化（缓存挂上、清单到达）也要推得出去
    this.emitMirror()
    await this.mirror.start()
    this.log.info('映射已启动', { 模式: config.mode, 网关端口: config.gatewayPort })
  }

  async stop(): Promise<void> {
    const mirror = this.mirror
    this.mirror = undefined
    if (mirror) this.emitMirror()
    await mirror?.stop()
  }

  /**
   * 查 ID 拿设备域与局域网地址。
   * 已经存过同一个 ID 时就复用存下来的 base —— 设置页改密码、改链路模式不该因为
   * 绿联云接口一时不通就改不了配置（base 是我们自己存过的事实，不是要重新猜的东西）。
   * 局域网地址仍然用新查到的：换网段、换路由器后它会变，而这个值本来就是可选的。
   */
  private async resolve(form: ConnectionForm): Promise<UglinkInfo> {
    const id = normalizeAlias(form.uglinkId)
    // 「测试连接」刚查过同一个 ID：保存时直接用那次的结果，省掉一次外网往返
    const recent = this.lastResolved
    if (recent && id && recent.info.id === id && Date.now() - recent.at < resolveReuseMs) return recent.info
    const info = await this.lookup(form, id)
    this.lastResolved = { info, at: Date.now() }
    return info
  }

  private async lookup(form: ConnectionForm, id: string): Promise<UglinkInfo> {
    const saved = this.loadConfig()
    if (saved?.base && saved.uglinkId === id && id) {
      let lanHost = saved.lanHost
      try {
        lanHost = (await lookupUglink(id, this.mirrorOptions.request)).lanHost || saved.lanHost
      } catch {
        // 查不到就沿用存下来的（只走外网也能跑）
      }
      return { id, base: saved.base, lanHost }
    }
    return lookupUglink(form.uglinkId, this.mirrorOptions.request)
  }

  /**
   * 逐条测一遍。`onProgress` 让界面能「先转圈、再打勾」：查 ID 之前就先告诉它要做哪些步。
   *
   * 注意顺序：先报 plan（含最后那步，让整列立刻以转圈出现），再逐步报结果。
   */
  async test(form: ConnectionForm, onProgress?: TestProgressSink): Promise<ConnectionTestResult> {
    // 解析 ID 是第一步，先把它报出来，界面才有「开始转圈」的时机
    onProgress?.({ phase: 'step', step: { name: 'UGREENlink ID', ok: true, detail: '查询中…', pending: true } })

    let info: UglinkInfo
    try {
      info = await this.resolve(form)
    } catch (error) {
      const step = { name: 'UGREENlink ID', ok: false, detail: errorMessage(error) }
      onProgress?.({ phase: 'step', step })
      return { ok: false, steps: [step] }
    }
    onProgress?.({
      phase: 'step',
      step: {
        name: 'UGREENlink ID',
        ok: true,
        detail: `${info.id} → ${info.base}${info.lanHost ? ` · 局域网 ${info.lanHost}` : ''}`,
      },
    })

    let config: ConnectionConfig
    try {
      config = mergeForm(form, this.loadConfig(), info)
    } catch (error) {
      const step = { name: '检查填写', ok: false, detail: errorMessage(error) }
      onProgress?.({ phase: 'step', step })
      return { ok: false, steps: [step] }
    }
    try {
      return await testConnection(config, this.mirrorOptions.request, info, onProgress)
    } finally {
      onProgress?.({ phase: 'done' })
    }
  }

  async save(form: ConnectionForm): Promise<ConnectionSummary> {
    const info = await this.resolve(form)
    const config = mergeForm(form, this.loadConfig(), info)
    this.vault.save(config)
    this.config = config
    this.loaded = true // 刚写下去的这份就是当前配置，别再去读盘覆盖它
    await this.stop()
    await this.start()
    return this.summary()
  }

  async clear(): Promise<void> {
    await this.stop()
    this.vault.clear()
    this.config = undefined
    this.lastResolved = undefined
    this.loaded = true // 已清空；这个状态也是「读过了」的一种，避免又被 load() 拽回旧值
  }
}
