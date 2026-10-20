import { useCallback, useEffect, useState } from 'react'
import { Cpu, HardDrive, Info, RefreshCw, Server, Terminal } from 'lucide-react'
import { Banner, Button, EmptyState, Section, SwitchField, TextField, useToast } from '@sakura-ui/react'
import { useSettings } from '@sakura-ui/electron-react'
import type { DockerInfo } from '../core/docker-types.js'
import { kuraSettingsDefaults, type KuraSettings } from '../shared/settings.js'

/**
 * 「Docker → 配置」页。
 *
 * 两件事：
 * 1. **看**：NAS 上 Docker 守护进程的系统信息（版本、根目录、存储驱动、日志驱动、
 *    **镜像加速器**）。这些是排查「拉不动镜像」「磁盘满了」「日志去哪了」的第一手资料。
 * 2. **改**：镜像站点 —— 但它改的是 **Kura 查版本列表时用哪个站点**，
 *    不是 NAS 上 daemon.json 的 `registry-mirrors`。
 *
 * 为什么不去改 daemon.json：改它要重启 dockerd，等于停掉 NAS 上所有容器。
 * 一个桌面客户端的「配置页」不该有这种破坏力 —— 那该让用户在 NAS 上自己做。
 * 所以这里**只读**系统信息，同时把「两者的区别」在界面上说清楚。
 */

const icon = { size: 16, strokeWidth: 1.7, 'aria-hidden': true } as const

function formatBytes(n: number): string {
  if (!n) return '—'
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(0)} MB`
  return `${(n / 1024 ** 3).toFixed(1)} GB`
}

/** 一行只读信息：左标签、右值。 */
function InfoRow({ label, value, mono }: { label: string; value: string; mono?: boolean }): React.JSX.Element {
  return (
    <div className="kura-docker-config__row">
      <span className="kura-docker-config__label">{label}</span>
      <span className={mono ? 'kura-docker-config__value is-mono' : 'kura-docker-config__value'}>{value || '—'}</span>
    </div>
  )
}

export function DockerConfigTab(): React.JSX.Element {
  const toast = useToast()
  const [info, setInfo] = useState<DockerInfo | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const { settings, set } = useSettings<KuraSettings>(kuraSettingsDefaults)

  const load = useCallback(async (): Promise<void> => {
    setLoading(true)
    try {
      const next = await window.kura!.docker.info()
      setInfo(next)
      setError('')
    } catch (caught) {
      setError((caught as Error).message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  if (error) {
    return (
      <div className="kura-placeholder">
        <EmptyState
          icon={<Server size={22} aria-hidden />}
          title="读不到 Docker 的信息"
          description={`${error}（新版 kura-server 才有这个接口；旧镜像上这里读不到系统信息，但下面的镜像站点照样能填。）`}
          action={
            <Button variant="secondary" icon={<RefreshCw {...icon} />} onClick={() => void load()}>
              重新读
            </Button>
          }
        />
      </div>
    )
  }

  if (!info && loading) return <p className="kura-form__note">读取 Docker 信息…</p>

  const hasMirrors = (info?.registryMirrors.length ?? 0) > 0
  // kura-server 没配加速器时，用户填的这个站点就是唯一的来源 —— 分开说清楚
  const kuraMirror = settings.dbRegistryMirror.trim()

  return (
    <div className="kura-docker-config" data-testid="docker-config">
      <Section
        title="镜像站点"
        description="Kura 查「可装的数据库版本」时用哪个站点。留空走 Docker Hub 官方；都连不上时用内置的常用版本。"
      >
        <div className="kura-docker-config__form">
          <TextField
            label="镜像站点"
            value={settings.dbRegistryMirror}
            onChange={(e) => set('dbRegistryMirror', e.target.value)}
            placeholder="如 docker.1ms.run（留空走官方）"
            spellCheck={false}
          />
          <p className="kura-form__note">
            常见公共加速器：<code>docker.1ms.run</code>、<code>docker.m.daocloud.io</code>（后者不提供版本列表，只能拉镜像）。
          </p>
        </div>

        <Banner
          tone="neutral"
          title="这一项和「NAS 上的镜像加速器」不是一回事"
          description={
            <>
              这里填的只影响 <strong>Kura 查版本列表</strong>。
              NAS 上 docker 拉镜像走的是 <code>daemon.json</code> 里的 <code>registry-mirrors</code>
              （见下面「系统信息」里的实际配置）—— 那个要改得重启 dockerd，会停掉 NAS 上所有容器，
              所以 Kura 不代改，需要时请自己在 NAS 上操作。
            </>
          }
        />
      </Section>

      <Section title="系统信息" description="NAS 上 Docker 守护进程的实际情况（只读）。">
        <div className="kura-docker-config__grid">
          <InfoRow label="版本" value={info ? `${info.version}（API ${info.apiVersion}）` : ''} mono />
          <InfoRow label="系统" value={info ? `${info.os} · ${info.architecture}` : ''} />
          <InfoRow label="内核" value={info?.kernel ?? ''} mono />
          <InfoRow label="存储驱动" value={info?.storageDriver ?? ''} mono />
          <InfoRow label="日志驱动" value={info?.loggingDriver ?? ''} mono />
          <InfoRow label="cgroup" value={info?.cgroupVersion ?? ''} mono />
          <InfoRow label="根目录" value={info?.rootDir ?? ''} mono />
          <InfoRow
            label="资源"
            value={info ? `${info.cpus} 核 · ${formatBytes(info.memoryTotal)}` : ''}
          />
          <InfoRow
            label="容器"
            value={info ? `${info.containers} 个（${info.containersRunning} 运行 · ${info.containersStopped} 停止）` : ''}
          />
          <InfoRow label="镜像" value={info ? `${info.images} 个` : ''} />
        </div>

        <div className="kura-docker-config__mirrors">
          <div className="kura-docker-config__mirrors-head">
            <span className="kura-docker-config__label">NAS 上的镜像加速器（daemon.json）</span>
          </div>
          {hasMirrors ? (
            <ul className="kura-docker-config__mirrorlist">
              {info!.registryMirrors.map((mirror) => (
                <li key={mirror}>
                  <code>{mirror}</code>
                </li>
              ))}
            </ul>
          ) : (
            <p className="kura-form__note">
              没配（docker 拉镜像直接走 Docker Hub 官方）。国内网络下这会让拉镜像很慢或失败 ——
              想配的话要在 NAS 上改 <code>/etc/docker/daemon.json</code> 再重启 docker。
            </p>
          )}
          {!hasMirrors && kuraMirror ? (
            <p className="kura-form__note">
              你给 Kura 填的 <code>{kuraMirror}</code> 只用于查版本，<strong>没有配到 NAS 的 docker 上</strong>。
            </p>
          ) : null}
        </div>

        <div className="kura-form__actions">
          <Button variant="ghost" icon={<RefreshCw {...icon} />} disabled={loading} onClick={() => void load()}>
            {loading ? '读取中…' : '刷新'}
          </Button>
        </div>
      </Section>

      <Section title="说明" description="为什么这里没有「改 Docker 配置」的按钮。">
        <Banner
          tone="neutral"
          description={
            <>
              Kura 对 NAS 上的 Docker 只做<strong>容器与镜像层面的操作</strong>（起停、重建、拉取、清理），
              不碰守护进程本身的配置。<code>daemon.json</code> 里那些项（加速器、存储驱动、日志上限、data-root）
              改完都要重启 dockerd，而重启会停掉 NAS 上<strong>所有</strong>容器 ——
              包括正在给别的应用用的服务。这种操作应该由你在 NAS 上按自己的时间安排做，不该由一个客户端的按钮触发。
            </>
          }
        />
        <p className="kura-form__note">
          <Info {...icon} /> 需要看容器日志、跑 docker 命令的话：「终端」页直接给的是宿主 root shell。
        </p>
      </Section>
    </div>
  )
}
