/**
 * 上游**明确拒绝**了凭据（Authelia 401 / 403 / status=KO / 已被封禁）。
 *
 * 必须和「链路抖动」区分开：重试不可能成功，而且 Authelia 的 regulation 按「用户 + 来源 IP」
 * 累计失败次数，持续重试会把一次失败放大成整段时间不可用（Go 版实测：5 次失败触发封禁，
 * 每 5 秒重试一次会让 5 分钟封禁被无限续期）。会话管理器据此停止自动重试。
 */
export class AuthRejectedError extends Error {
  readonly status: number
  readonly portal: string
  readonly bannedUntil: string

  constructor(status: number, portal: string, message: string, bannedUntil = '') {
    let text = `凭据被上游拒绝：HTTP ${status} status=${portal} ${message}`.trimEnd()
    if (bannedUntil) text += `（上游封禁至 ${bannedUntil}）`
    super(text)
    this.name = 'AuthRejectedError'
    this.status = status
    this.portal = portal
    this.bannedUntil = bannedUntil
  }
}

export function isAuthRejected(error: unknown): error is AuthRejectedError {
  return error instanceof AuthRejectedError
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
