import type { ReactNode } from 'react'
import { Blocks, FolderOpen, LayoutDashboard, Network, Settings, SquareTerminal } from 'lucide-react'

export type PageId = 'overview' | 'mirror' | 'files' | 'terminal' | 'modules' | 'settings'

export interface PageDef {
  id: PageId
  label: string
  icon: ReactNode
  /** 页面一句话说明，未实现的页面也用它做空状态文案 */
  summary: string
  /** 哪个版本做，用于空状态提示 */
  plannedIn: string
}

const iconProps = { size: 18, strokeWidth: 1.65 } as const

export const pages: readonly PageDef[] = [
  {
    id: 'overview',
    label: '概览',
    icon: <LayoutDashboard {...iconProps} />,
    summary: '当前链路、账号状态与各项功能的健康度',
    plannedIn: 'v0.1',
  },
  {
    id: 'mirror',
    label: '服务映射',
    icon: <Network {...iconProps} />,
    summary: '把 NAS 上的服务映射到本机回环地址，开关、改端口、看流量与探测结果',
    plannedIn: 'v0.1',
  },
  {
    id: 'files',
    label: '文件',
    icon: <FolderOpen {...iconProps} />,
    summary: '浏览、上传、下载 NAS 上的文件；同时给本机其他程序提供 WebDAV',
    plannedIn: 'v0.2',
  },
  {
    id: 'terminal',
    label: '终端',
    icon: <SquareTerminal {...iconProps} />,
    summary: '连接 NAS 的命令行（经 nas-console），支持多标签',
    plannedIn: 'v0.2',
  },
  {
    id: 'modules',
    label: '模块',
    icon: <Blocks {...iconProps} />,
    summary: '按需安装的进阶功能，例如把 NAS 挂载为本机磁盘（rclone）',
    plannedIn: 'v0.3',
  },
  {
    id: 'settings',
    label: '设置',
    icon: <Settings {...iconProps} />,
    summary: '外观、托盘行为、账号与凭据',
    plannedIn: 'v0.1',
  },
]

export function findPage(id: string): PageDef {
  return pages.find((page) => page.id === id) ?? pages[0]!
}
