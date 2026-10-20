import { randomInt } from 'node:crypto'
import type { DbEngine } from '../../../src/core/db-types.js'

/**
 * 快捷安装的 compose 模板。
 *
 * 几条会决定「装完能不能用」的写法，都在这里定死：
 *
 * 1. **卷用绑定挂载 `./data`，不用具名卷。** compose 里的相对路径是按**执行目录**解析后交给 dockerd 的，
 *    而 kura-server 一律在宿主原路径下执行（见 docker/compose.ts 顶部注释），所以 `./data` 会落到
 *    `/volume1/docker/<名字>/data` —— 用户能在文件页里看见、能备份、能迁移。
 *    反过来，具名卷在 NAS 上出过事故：容器挂的是具名卷、compose 声称绑目录，谁跑一次 up -d 数据就"没了"
 *    （docs/参考/nas-mirror/设计方案.md:477）。
 * 2. **不写 `ports:`。** 数据库不发布任何宿主端口 —— 隧道连的是容器名，不需要宿主端口；
 *    发布了反而让数据库暴露在整个 NAS 局域网上。想额外发布由用户在容器页自己加。
 * 3. **固定镜像 tag。** 不用 latest，否则同一次安装在不同时间装出不同版本，没法复现。
 * 4. **Redis 必须设 requirepass。** 官方镜像默认 protected-mode，无密码会拒绝来自容器网络的连接。
 */

export interface DbTemplate {
  engine: DbEngine
  /** 界面上的显示名 */
  label: string
  /**
   * 默认镜像（含 tag）。用户可以在界面上换版本 —— 换的是这一整个字符串。
   * 注意 compose 里也必须用它，不能另写一份（这里踩过：两处各写一遍必然漂移，
   * 界面上选了 16 装出来还是 17）。
   */
  image: string
  /** 容器内端口 */
  port: number
  /** 默认库名（Redis 为空） */
  database: string
  /** 默认用户名（Redis 为空） */
  username: string
  /**
   * 这个引擎的官方镜像有哪些变体可选。
   *
   * 各引擎**不一样**，不能统一：PostgreSQL 有 alpine / bookworm / trixie，
   * Redis 有 alpine / bookworm，MySQL 只有 debian 系（空串 = 不加后缀）。
   */
  variants: readonly string[]
  /** 默认变体；空串 = 镜像名后面不加变体 */
  defaultVariant: string
  /** 从「版本 + 变体」拼出完整镜像名（各引擎的拼法不同） */
  imageOf: (version: string, variant: string) => string
  compose: (name: string, network: string, image: string) => string
  /** 生成 .env 的内容（含密码） */
  env: (database: string, username: string, password: string) => string
}

/**
 * 生成口令。
 *
 * 字符集**刻意排除**了 shell 特殊字符（`"'\`$&|;<>\` 之类）：虽然我们执行命令用数组传参、不经 shell，
 * 但用户会手抄这个密码、粘到各种客户端与命令里。排掉这些能省掉一整类「密码抄错连不上」的支持问题。
 * 24 字节熵足够（约 38 个字符）。
 */
const passwordChars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'

export function generatePassword(length = 28): string {
  let out = ''
  for (let i = 0; i < length; i += 1) out += passwordChars[randomInt(passwordChars.length)]
  return out
}

/** 共享网络：隧道要靠容器名解析，所以数据库必须和 kura-server 在同一个网络上。 */
export const defaultNetwork = 'sso-net'

const header = (name: string): string =>
  `# Kura 快捷安装的数据库项目：${name}\n# 由 Kura 生成。改这里的内容请用 Kura 的「容器 → 项目 → 编辑」，或直接改这个文件。\n`

export const templates: Record<DbEngine, DbTemplate> = {
  postgres: {
    engine: 'postgres',
    label: 'PostgreSQL',
    image: 'postgres:17-alpine',
    port: 5432,
    database: 'postgres',
    username: 'postgres',
    // 空串 = 不带后缀的完整版（`postgres:17` 是 debian bookworm）；官方镜像都有这个
    variants: ['alpine', 'bookworm', 'trixie', ''],
    defaultVariant: 'alpine',
    imageOf: (version, variant) => `postgres:${version}${variant ? `-${variant}` : ''}`,
    compose: (name, network, image) => `${header(name)}
services:
  ${name}:
    image: ${image}
    container_name: ${name}
    restart: unless-stopped
    environment:
      POSTGRES_USER: \${POSTGRES_USER}
      POSTGRES_PASSWORD: \${POSTGRES_PASSWORD}
      POSTGRES_DB: \${POSTGRES_DB}
      # 中文环境下 initdb 需要，否则默认 C locale 排序不对
      POSTGRES_INITDB_ARGS: "--encoding=UTF8"
      TZ: \${TZ}
    volumes:
      - ./data:/var/lib/postgresql/data
    networks:
      - ${network}

networks:
  ${network}:
    external: true
`,
    env: (database, username, password) =>
      `# Kura 生成的连接参数。数据库容器启动时读它，Kura 的连接信息也从这里读回。\nPOSTGRES_USER=${username}\nPOSTGRES_PASSWORD=${password}\nPOSTGRES_DB=${database}\nTZ=Asia/Shanghai\n`,
  },
  mysql: {
    engine: 'mysql',
    label: 'MySQL',
    image: 'mysql:8.4',
    port: 3306,
    database: 'app',
    username: 'kura',
    // MySQL 官方没有 alpine；debian 是默认变体（不加后缀）
    variants: [''],
    defaultVariant: '',
    imageOf: (version, variant) => `mysql:${version}${variant ? `-${variant}` : ''}`,
    compose: (name, network, image) => `${header(name)}
services:
  ${name}:
    image: ${image}
    container_name: ${name}
    restart: unless-stopped
    command:
      - --character-set-server=utf8mb4
      - --collation-server=utf8mb4_unicode_ci
    environment:
      MYSQL_ROOT_PASSWORD: \${MYSQL_ROOT_PASSWORD}
      MYSQL_DATABASE: \${MYSQL_DATABASE}
      MYSQL_USER: \${MYSQL_USER}
      MYSQL_PASSWORD: \${MYSQL_PASSWORD}
      TZ: \${TZ}
    volumes:
      - ./data:/var/lib/mysql
    networks:
      - ${network}

networks:
  ${network}:
    external: true
`,
    env: (database, username, password) =>
      `# Kura 生成的连接参数。\nMYSQL_ROOT_PASSWORD=${password}\nMYSQL_DATABASE=${database}\nMYSQL_USER=${username}\nMYSQL_PASSWORD=${password}\nTZ=Asia/Shanghai\n`,
  },
  mariadb: {
    engine: 'mariadb',
    label: 'MariaDB',
    image: 'mariadb:11.4',
    port: 3306,
    database: 'app',
    username: 'kura',
    variants: ['', 'ubi'],
    defaultVariant: '',
    imageOf: (version, variant) => `mariadb:${version}${variant ? `-${variant}` : ''}`,
    compose: (name, network, image) => `${header(name)}
services:
  ${name}:
    image: ${image}
    container_name: ${name}
    restart: unless-stopped
    command:
      - --character-set-server=utf8mb4
      - --collation-server=utf8mb4_unicode_ci
    environment:
      MARIADB_ROOT_PASSWORD: \${MARIADB_ROOT_PASSWORD}
      MARIADB_DATABASE: \${MARIADB_DATABASE}
      MARIADB_USER: \${MARIADB_USER}
      MARIADB_PASSWORD: \${MARIADB_PASSWORD}
      TZ: \${TZ}
    volumes:
      - ./data:/var/lib/mysql
    networks:
      - ${network}

networks:
  ${network}:
    external: true
`,
    env: (database, username, password) =>
      `MARIADB_ROOT_PASSWORD=${password}\nMARIADB_DATABASE=${database}\nMARIADB_USER=${username}\nMARIADB_PASSWORD=${password}\nTZ=Asia/Shanghai\n`,
  },
  redis: {
    engine: 'redis',
    label: 'Redis',
    image: 'redis:7-alpine',
    port: 6379,
    database: '',
    username: '',
    // 空串 = 不带后缀的完整版（`redis:7` 是 debian）；官方镜像都有这个
    variants: ['alpine', 'bookworm', ''],
    defaultVariant: 'alpine',
    imageOf: (version, variant) => `redis:${version}${variant ? `-${variant}` : ''}`,
    compose: (name, network, image) => `${header(name)}
services:
  ${name}:
    image: ${image}
    container_name: ${name}
    restart: unless-stopped
    # 必须设 requirepass：官方镜像默认 protected-mode，没密码会拒绝来自容器网络的连接
    command: ["redis-server", "--requirepass", "\${REDIS_PASSWORD}", "--appendonly", "yes"]
    volumes:
      - ./data:/data
    networks:
      - ${network}

networks:
  ${network}:
    external: true
`,
    env: (_database, _username, password) => `REDIS_PASSWORD=${password}\n`,
  },
}

/** 从 .env 文本里读一个键（连接信息要从这里读回密码 —— 唯一真相在 NAS 上）。 */
export function readEnv(text: string, key: string): string {
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const at = trimmed.indexOf('=')
    if (at < 0) continue
    if (trimmed.slice(0, at).trim() === key) return trimmed.slice(at + 1).trim()
  }
  return ''
}

/** 这个引擎的密码在 .env 里叫什么键（各官方镜像的环境变量名不一样）。 */
export function passwordEnvKey(engine: DbEngine): string {
  switch (engine) {
    case 'postgres':
      return 'POSTGRES_PASSWORD'
    case 'mysql':
      return 'MYSQL_PASSWORD'
    case 'mariadb':
      return 'MARIADB_PASSWORD'
    case 'redis':
      return 'REDIS_PASSWORD'
  }
}

/**
 * 容器里的官方 CLI 要靠哪些**环境变量**才知道该连谁。
 *
 * 这一条踩过坑：镜像的 `POSTGRES_USER` / `MYSQL_USER` / `REDIS_PASSWORD` 是**镜像 entrypoint
 * 用来初始化服务端的**，客户端的变量名是另一套（`PGUSER` / `MYSQL_PWD` / `REDISCLI_AUTH`）。
 * 于是命令台 `docker exec` 进容器跑 `psql -c "SELECT version()"` 会报
 * `FATAL: role "root" does not exist` —— psql 没看到 `PGUSER`，就按**当前 OS 用户**（root，
 * 镜像 entrypoint 用 gosu 降权只影响主进程，exec 不受影响）去登录。
 *
 * 为什么用环境变量而不是补 `-U user`、`--password=...` 这类参数：
 * 1. CLI 参数是**调用方拼的**，用户还能再传一个 `-U` 把它覆盖掉；环境变量优先级更低、不占参数位。
 * 2. 口令进命令行会出现在容器的 `Cmd` 里（`docker inspect` 可见、审计日志也可能记到），
 *    进 `Env` 则是 Docker 的常规定做法。
 * 3. 三个引擎的写法完全一样：给一份 `NAME=value` 数组，不用为各自的参数顺序分叉。
 *
 * 空值一律不传 —— 传 `PGUSER=` 会覆盖掉容器自己的默认值，比不传更糟。
 */
export function clientEnv(engine: DbEngine, info: { user?: string; database?: string; password?: string }): string[] {
  const env: string[] = []
  const put = (key: string, value: string | undefined): void => {
    if (value) env.push(`${key}=${value}`)
  }
  switch (engine) {
    case 'postgres':
      put('PGUSER', info.user)
      put('PGDATABASE', info.database)
      put('PGPASSWORD', info.password)
      break
    case 'mysql':
    case 'mariadb':
      put('MYSQL_PWD', info.password)
      break
    case 'redis':
      put('REDISCLI_AUTH', info.password)
      break
  }
  return env
}

/**
 * MySQL / MariaDB 的 `mysql` 客户端不认环境变量指定用户与库（只有 `MYSQL_PWD`），
 * 这两项只能走参数；`redis-cli` 用 `REDISCLI_AUTH` 就够了。
 */
export function clientArgs(engine: DbEngine, info: { user?: string; database?: string }): string[] {
  switch (engine) {
    case 'mysql':
    case 'mariadb':
      return [...(info.user ? ['-u', info.user] : []), ...(info.database ? [info.database] : [])]
    default:
      return []
  }
}
