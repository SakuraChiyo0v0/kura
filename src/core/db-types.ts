/**
 * 数据库管理的数据形状：kura-server 的 `db` 内置服务产出、客户端「数据库」页消费，两边共用这一份。
 * 只放类型与纯函数，不碰网络（server/ 也会打包它）。设计见 docs/数据库管理 设计.md。
 */

/** 引擎种类：隧道与命令执行都按它分派。 */
export type DbEngine = 'postgres' | 'mysql' | 'mariadb' | 'redis'

/**
 * 一个数据库实例。
 *
 * **端口是从容器实际读出来的**，不是按引擎硬编码：NAS 上的 sakura-pg 是 postgres:18 跑在 5444，
 * 不是 5432（见 docs/参考/nas-mirror/设计方案.md）。硬编码默认端口会连错。
 */
export interface DatabaseView {
  /** 实例名（Kura 装的 = 项目名；接管的 = 容器名） */
  name: string
  engine: DbEngine | ''
  /** 容器名（隧道与命令执行都按它定位） */
  container: string
  state: string
  /** Docker 给人话状态，如 "Up 3 hours (healthy)" */
  status: string
  health: 'healthy' | 'unhealthy' | 'starting' | ''
  /** 容器端口（数据库监听的端口） */
  port: number
  /** 发布到宿主的端口；0 = 没发布 */
  hostPort: number
  /** 应用使用的默认库名（PG/MySQL 用；Redis 为空） */
  database: string
  /** 用户名（Redis 为空） */
  username: string
  /** Kura 自己装的（有 Kura 的 compose 项目 + 标签），能改能删 */
  managed: boolean
  /** 容器接上了 kura-server 所在的共享网络没有；false 时隧道连不上 */
  networked: boolean
  /** 项目目录（宿主路径）；接管的外部容器为空 */
  dir: string
}

/** 一条连接信息：本地程序直连本机隧道端口用。 */
export interface DbConnectInfo {
  name: string
  engine: DbEngine | ''
  /** 本机隧道地址（回环）；隧道没开时为空 */
  host: string
  port: number
  database: string
  username: string
  /** 口令：只在客户端 vault 里，不由服务端返回 */
  password?: string
  /** 现成的一条连接串 / 命令，界面上可复制 */
  uri: string
  /** 隧道没开或不可用时的原因 */
  unavailable: string
}

/** 引擎的默认容器端口与默认用户名（生成连接信息时的兜底；实际以容器为准）。 */
export const engineDefaults: Record<DbEngine, { port: number; username: string; database: string }> = {
  postgres: { port: 5432, username: 'postgres', database: 'postgres' },
  mysql: { port: 3306, username: 'root', database: 'mysql' },
  mariadb: { port: 3306, username: 'root', database: 'mysql' },
  redis: { port: 6379, username: '', database: '' },
}

/** 官方镜像名：固定 tag，装出来的版本可复现。 */
export const engineImages: Record<DbEngine, string> = {
  postgres: 'postgres:17-alpine',
  mysql: 'mysql:8.4',
  mariadb: 'mariadb:11.4',
  redis: 'redis:7-alpine',
}

/**
 * 从镜像名推断引擎。接管已有数据库时用它 —— 不认识就返回空串，界面按「其它容器」只读列出。
 * 只认官方与常见 fork 的名字，不做模糊匹配（宁可漏判，不要认错引擎去连）。
 */
export function engineOfImage(image: string): DbEngine | '' {
  // 去掉仓库前缀与 tag：ghcr.io/foo/postgres:17 → postgres
  const name = image.toLowerCase().split('@')[0]!.split(':')[0]!.split('/').pop() ?? ''
  if (name === 'postgres' || name === 'postgresql' || name.startsWith('postgres-')) return 'postgres'
  if (name === 'mysql' || name.startsWith('mysql-')) return 'mysql'
  if (name === 'mariadb' || name.startsWith('mariadb-')) return 'mariadb'
  if (name === 'redis' || name.startsWith('redis-')) return 'redis'
  return ''
}

/** 引擎在容器里跑官方 CLI 的可执行文件名（命令执行用）。 */
export const engineCli: Record<DbEngine, string> = {
  postgres: 'psql',
  mysql: 'mysql',
  mariadb: 'mariadb',
  redis: 'redis-cli',
}

/**
 * 引擎支持的 CLI 白名单。**不接受调用方传任意命令** —— 和 docker 那边 shellCandidates 同一个道理：
 * 能执行任意命令就等于又开了一个终端。
 */
export const engineCliCandidates: Record<DbEngine, string[]> = {
  postgres: ['psql', 'pg_dump', 'pg_dumpall', 'pg_restore', 'vacuumdb', 'createdb', 'dropdb'],
  mysql: ['mysql', 'mysqldump', 'mysqladmin', 'mysqlcheck'],
  mariadb: ['mariadb', 'mariadb-dump', 'mariadb-admin', 'mariadb-check'],
  redis: ['redis-cli'],
}
