import { request as defaultRequest, type HttpRequester } from './http.js'

/**
 * 由 UGREENlink ID 解析出设备域与局域网地址。
 *
 * 用户在绿联 App / UGOS 里看到的「远程访问」只有两样东西：
 *   UGREENlink ID   <设备ID>
 *   网页端          https://ug.link/<设备ID>
 * 但登录链要求的是**带节点域**的 `https://<设备ID>.<节点>.ug.link`（实测：不带节点域的
 * `<设备ID>.ug.link` 打到 nginx 返回 405，只有带节点域那一份会吐 X-Rsa-Token）。
 * 节点域用户看不到，所以不能让人手填设备域 —— 由这个接口查出来。
 *
 * 同一个响应里还有 netInfo.ipv4，正好是局域网地址，省掉一次手填。
 * 接口不需要认证，只发一个 alias。
 * （对应 Go 版 config 里的 _base 注释「取自登录响应的 uglink 字段」，那条路要先用设备域登录才能拿到；
 *   这里换个方向，先查 ID，因此引导里第一次就能自动带出。2026-10-14 实测。）
 */
export interface UglinkInfo {
  /** 规范化后的 UGREENlink ID，形如 <设备ID> */
  id: string
  /** 设备域 https://<id>.<节点>.ug.link */
  base: string
  /** 局域网地址；查不到就是空串（只走外网中继也能用） */
  lanHost: string
}

/** 查询接口的地址与响应形状（响应 code=7022 表示 ID 不存在）。 */
const byAliasUrl = 'https://api.ugnas.com/api/p2p/v2/ta/nodeInfo/byAlias'

interface ByAliasResponse {
  code: number
  msg: string
  data?: {
    alias?: string
    relayDomain?: string
    appDomain?: string
    dockerDomain?: string
    netInfo?: { ipv4?: string[] }
  }
}

/**
 * 把用户可能粘贴进来的各种形态收敛成一个裸 ID。
 * 实测用户会从这些地方复制，所以四种都认：
 *   <设备ID>
 *   https://ug.link/<设备ID>
 *   https://<设备ID>.<节点>.ug.link/desktop/?os=ugospro#/   （登录后跳转的地址）
 *   https://app-<端口>-<设备ID>.<节点>.ugdocker.link
 */
export function normalizeAlias(input: string): string {
  const raw = input.trim()
  if (!raw) return ''
  const withoutScheme = raw.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').toLowerCase()
  const [host = '', ...rest] = withoutScheme.split(/[/?#]/)
  const pathSegment = rest[0] ?? ''

  // 门户形态：ID 在路径里 —— ug.link/<id>、www.ug.link/<id>
  if (/^(www\.)?ug\.link$/.test(host)) return pathSegment

  // 域形态：<设备>.<节点>.ug.link、app-<端口>-<设备>.<节点>.ugdocker.link、<设备>.ugapp.link
  let text = host
  text = text.replace(/^www\./, '')
  text = text.replace(/\.(ugapp|ugdocker|ug)\.link$/, '')
  text = text.replace(/^app-\d+-/, '')
  // 剩下 <设备> 或 <设备>.<节点>；节点段（cn30 一类）不是 ID，只保留第一段
  return text.split('.')[0] ?? ''
}

/** ID 的合法形状：绿联下发的是小写字母数字加连字符。 */
const aliasRe = /^[a-z0-9][a-z0-9-]{2,62}$/

/** 查一个 ID 的设备域与局域网地址；ID 不存在、网络失败都抛出可读的错误。 */
export async function lookupUglink(id: string, request: HttpRequester = defaultRequest): Promise<UglinkInfo> {
  const alias = normalizeAlias(id)
  if (!alias) throw new Error('请填写 UGREENlink ID')
  if (!aliasRe.test(alias)) throw new Error(`UGREENlink ID 格式不对：${JSON.stringify(alias)}`)

  let res
  try {
    res = await request({
      url: byAliasUrl,
      method: 'POST',
      headers: { 'content-type': 'application/json', lang: 'zh-CN' },
      body: JSON.stringify({ alias }),
      timeoutMs: 20_000,
    })
  } catch (error) {
    throw new Error(`查询 UGREENlink ID 失败：${(error as Error).message}`)
  }

  let env: ByAliasResponse
  try {
    env = JSON.parse(res.body.toString('utf8')) as ByAliasResponse
  } catch {
    throw new Error(`查询 UGREENlink ID 响应无法解析（HTTP ${res.status}）`)
  }
  if (env.code === 7022) throw new Error(`绿联那边没有这个 UGREENlink ID：${alias}（去绿联 App 的「远程访问」里核对）`)
  if (env.code !== 200) throw new Error(`查询 UGREENlink ID 失败：code=${env.code} msg=${env.msg}`)

  const relay = env.data?.relayDomain?.trim()
  if (!relay) throw new Error('查询结果里没有中继域，无法推出设备地址')
  const device = env.data?.alias?.trim() || alias
  const lanHost = env.data?.netInfo?.ipv4?.find((ip) => ip.trim())?.trim() ?? ''
  return { id: device, base: `https://${device}.${relay}`, lanHost }
}
