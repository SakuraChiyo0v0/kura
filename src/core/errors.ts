/**
 * 上游**明确拒绝**了凭据（401 / 403 / status=KO）。
 *
 * 必须和「链路抖动」区分开：重试不可能成功，而且认证侧的防爆破按「用户 + 来源 IP」
 * 累计失败次数，持续重试会把一次失败放大成整段时间不可用。会话管理器据此停止自动重试。
 */
export class AuthRejectedError extends Error {
  readonly status: number
  readonly portal: string

  constructor(status: number, portal: string, message: string) {
    super(`凭据被上游拒绝：HTTP ${status} status=${portal} ${message}`.trimEnd())
    this.name = 'AuthRejectedError'
    this.status = status
    this.portal = portal
  }
}

export function isAuthRejected(error: unknown): error is AuthRejectedError {
  return error instanceof AuthRejectedError
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
