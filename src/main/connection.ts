import { autheliaLogin } from '../core/authelia.js'
import { errorMessage } from '../core/errors.js'
import { request as defaultRequest, type HttpRequester } from '../core/http.js'
import { tcpReachable } from '../core/link.js'
import type { Logger } from '../core/log.js'
import { Mirror, type ConnectionConfig, type MirrorOptions } from '../core/mirror.js'
import { UgreenClient, appBase } from '../core/ugreen.js'
import type { ConnectionForm, ConnectionSummary, ConnectionTestResult, ConnectionTestStep } from '../shared/ipc.js'
import type { CredentialVault } from './vault.js'

/** 校验并规范化表单；密码留空表示沿用已保存的值。 */
export function mergeForm(form: ConnectionForm, saved: ConnectionConfig | undefined): ConnectionConfig {
  const base = form.base.trim().replace(/\/+$/, '')
  appBase(base, 1) // 设备域不对直接报错（必须是 https://<设备>.<节点>.ug.link）
  const ugreenUser = form.ugreenUser.trim()
  if (!ugreenUser) throw new Error('请填写绿联账号')
  const ugreenPassword = form.ugreenPassword || saved?.ugreenPassword || ''
  if (!ugreenPassword) throw new Error('请填写绿联密码')
  const gatewayPort = Number(form.gatewayPort) || 0
  if (gatewayPort < 0 || gatewayPort > 65535) throw new Error(`网关端口 ${form.gatewayPort} 不合法`)
  const lanHost = form.lanHost.trim()
  if (form.mode !== 'wan' && !lanHost) throw new Error('局域网 / 自动模式需要填写 NAS 局域网地址')
  return {
    base,
    ugreenUser,
    ugreenPassword,
    lanHost,
    mode: form.mode,
    gatewayPort,
    gatewayUser: gatewayPort ? form.gatewayUser.trim() : '',
    gatewayPassword: gatewayPort ? form.gatewayPassword || saved?.gatewayPassword || '' : '',
  }
}

export function summarize(config: ConnectionConfig | undefined): ConnectionSummary {
  return {
    configured: config !== undefined,
    base: config?.base ?? '',
    ugreenUser: config?.ugreenUser ?? '',
    hasUgreenPassword: Boolean(config?.ugreenPassword),
    lanHost: config?.lanHost ?? '',
    mode: config?.mode ?? 'auto',
    gatewayPort: config?.gatewayPort ?? 8897,
    gatewayUser: config?.gatewayUser ?? '',
    hasGatewayPassword: Boolean(config?.gatewayPassword),
  }
}

/**
 * 按配置实际走一遍：绿联登录 → 网关端口会话 → Authelia 登录 → 局域网可达。
 * 每一步只报「通过 / 失败 + 原因」，不回传任何令牌。后面的步骤依赖前面的，失败就停。
 */
export async function testConnection(config: ConnectionConfig, request: HttpRequester = defaultRequest): Promise<ConnectionTestResult> {
  const steps: ConnectionTestStep[] = []
  const ugreen = new UgreenClient({ base: config.base, username: config.ugreenUser, password: config.ugreenPassword }, request)

  let apiToken = ''
  try {
    apiToken = await ugreen.login()
    steps.push({ name: '绿联账号登录', ok: true, detail: '登录成功' })
  } catch (error) {
    steps.push({ name: '绿联账号登录', ok: false, detail: errorMessage(error) })
    return { ok: false, steps }
  }

  if (config.gatewayPort) {
    let ugreenCookie = ''
    try {
      const redirect = await ugreen.dockerToken(config.gatewayPort, apiToken)
      ugreenCookie = `ugreen-proxy-token=${await ugreen.fetchSsoCookie(redirect)}`
      steps.push({ name: `网关端口 ${config.gatewayPort} 会话`, ok: true, detail: '已建立' })
    } catch (error) {
      steps.push({ name: `网关端口 ${config.gatewayPort} 会话`, ok: false, detail: errorMessage(error) })
      return { ok: false, steps }
    }
    if (config.gatewayUser && config.gatewayPassword) {
      try {
        await autheliaLogin(
          { gatewayBase: appBase(config.base, config.gatewayPort), ugreenCookie, user: config.gatewayUser, password: config.gatewayPassword },
          request,
        )
        steps.push({ name: '网关（Authelia）登录', ok: true, detail: '登录成功' })
      } catch (error) {
        steps.push({ name: '网关（Authelia）登录', ok: false, detail: errorMessage(error) })
        return { ok: false, steps }
      }
    } else {
      steps.push({ name: '网关（Authelia）登录', ok: false, detail: '没有填写网关账号密码：走网关的服务会用不了' })
    }
  }

  if (config.lanHost) {
    const port = config.gatewayPort || 80
    const ok = await tcpReachable(config.lanHost, port, 1_500)
    // 局域网不可达不算失败：人在外面时本来就连不上，auto 模式会自动走外网
    steps.push({
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
export class ConnectionService {
  private mirror: Mirror | undefined
  private config: ConnectionConfig | undefined

  constructor(
    private readonly vault: CredentialVault,
    private readonly mirrorOptions: Omit<MirrorOptions, 'config'>,
    private readonly log: Logger,
    /** 测试接缝：Mirror 建好、启动前调用 */
    private readonly onMirrorCreated?: (mirror: Mirror) => void,
  ) {
    this.config = vault.load()
  }

  summary(): ConnectionSummary {
    return summarize(this.config)
  }

  current(): Mirror | undefined {
    return this.mirror
  }

  async start(): Promise<void> {
    if (!this.config || this.mirror) return
    this.mirror = new Mirror({ ...this.mirrorOptions, config: this.config })
    this.onMirrorCreated?.(this.mirror)
    await this.mirror.start()
    this.log.info('映射已启动', { 模式: this.config.mode, 网关端口: this.config.gatewayPort })
  }

  async stop(): Promise<void> {
    const mirror = this.mirror
    this.mirror = undefined
    await mirror?.stop()
  }

  async test(form: ConnectionForm): Promise<ConnectionTestResult> {
    let config: ConnectionConfig
    try {
      config = mergeForm(form, this.config)
    } catch (error) {
      return { ok: false, steps: [{ name: '检查填写', ok: false, detail: errorMessage(error) }] }
    }
    return testConnection(config, this.mirrorOptions.request)
  }

  async save(form: ConnectionForm): Promise<ConnectionSummary> {
    const config = mergeForm(form, this.config)
    this.vault.save(config)
    this.config = config
    await this.stop()
    await this.start()
    return this.summary()
  }

  async clear(): Promise<void> {
    await this.stop()
    this.vault.clear()
    this.config = undefined
  }
}
