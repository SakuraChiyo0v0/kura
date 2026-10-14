import { request as realRequest, type HttpRequester } from '../core/http.js'
import type { Mirror } from '../core/mirror.js'

/**
 * 冒烟专用的两个接缝，只在 KURA_SMOKE=1 且给了假 NAS 地址时生效：
 * 1. 发往绿联域（*.ug.link / *.ugdocker.link）与绿联云（api.ugnas.com）的查询、登录、令牌、
 *    网关请求改拨到本地假 NAS，Host 照原样带上；
 * 2. 反代的上游改指本地假应用（反代用的是真实 node:http，连不到公网域名）。
 * 其余代码路径——引导、加密保存、会话、监听、清单、界面——全是真实的。
 */
export function smokeRequester(): HttpRequester | undefined {
  const nas = process.env.KURA_SMOKE === '1' ? process.env.KURA_SMOKE_NAS : undefined
  if (!nas) return undefined
  const target = new URL(nas)
  return (req) => {
    const url = new URL(req.url)
    // 一次性授权页地址是假 NAS 自己编的 http://smoke-nas/...，同样改拨
    if (
      url.hostname.endsWith('.ug.link') ||
      url.hostname.endsWith('.ugdocker.link') ||
      url.hostname === 'api.ugnas.com' ||
      url.hostname === 'smoke-nas'
    ) {
      return realRequest({ ...req, url: `${target.origin}${url.pathname}${url.search}`, host: req.host ?? url.host })
    }
    return realRequest(req)
  }
}

export function applySmokeRoute(mirror: Mirror | undefined): void {
  const app = process.env.KURA_SMOKE === '1' ? process.env.KURA_SMOKE_APP : undefined
  if (!app || !mirror) return
  // 假应用按 X-Nas-Service 分流（像真网关那样）：webdav、nas-console 各自是一个假服务
  const route = mirror.router.route.bind(mirror.router)
  mirror.router.route = (svc) => ({ ...route(svc), upstream: app })
}
