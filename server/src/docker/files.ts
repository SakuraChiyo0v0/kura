import { spawn } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, rmdirSync, statSync, writeFileSync } from 'node:fs'
import { posix } from 'node:path'
import { checkProjectName, composeFileNames, within } from './compose.js'

/**
 * 项目文件的读写（D3）：compose 文件与 `.env`。
 *
 * 规矩（设计 §一「借 Arcane」）：
 * - 只动**项目目录**下的项目（kind = managed）；绿联商店、目录外的不改（商店升级会覆盖、目录外的路径挂载不对）。
 * - 只认这两类文件：项目的 compose 文件（按标签 / 目录里找到的那几个）和同目录的 `.env`。不接受调用方传任意路径。
 * - 保存前先 `docker compose config -q` 校验，**坏的存不进去**；校验在临时文件上跑，原文件不动。
 * - 覆盖前把旧版本留到 `.kura-bak/<时间>/`，最多留 10 份 —— 改坏了能回退。
 */

const maxFileSize = 512 * 1024
const keepBackups = 10
export const backupDir = '.kura-bak'

export interface ProjectFiles {
  /** compose 文件：路径（宿主原路径）与内容 */
  compose: Array<{ path: string; content: string }>
  /** `.env`；不存在时为空串、exists = false */
  env: { path: string; content: string; exists: boolean }
  backups: string[]
}

export interface FileValidator {
  /** 返回空串 = 通过；否则是 compose 给的错误信息 */
  (dir: string, files: string[], envFile: string | undefined): Promise<string>
}

/** 真校验：`docker compose -f ... config -q`（只解析与插值，不碰容器）。 */
export function composeValidator(bin = 'docker'): FileValidator {
  return (dir, files, envFile) =>
    new Promise((resolve) => {
      const args = ['compose']
      for (const f of files) args.push('-f', f)
      if (envFile) args.push('--env-file', envFile)
      args.push('config', '-q')
      const child = spawn(bin, args, { cwd: dir, env: { ...process.env, COMPOSE_ANSI: 'never' } })
      let err = ''
      child.stderr?.on('data', (d: Buffer) => (err += d.toString('utf8')))
      child.stdout?.on('data', (d: Buffer) => (err += d.toString('utf8')))
      child.on('error', (e) => resolve(`无法执行 docker compose：${e.message}`))
      child.on('close', (code) => resolve(code === 0 ? '' : err.trim() || `docker compose config 退出码 ${code}`))
    })
}

export class ProjectFileStore {
  constructor(
    private readonly root: string,
    private readonly validate: FileValidator,
  ) {}

  /** 这个目录能不能改：必须是项目目录下的一层子目录（不认 ../、不认更深的路径）。 */
  private checkDir(dir: string): string {
    const d = posix.normalize(dir)
    if (!this.root || !within(d, this.root) || posix.dirname(d) !== posix.normalize(this.root).replace(/\/+$/, '')) {
      throw Object.assign(new Error(`只能修改项目目录（${this.root}）下的项目`), { status: 403 })
    }
    return d
  }

  /** compose 文件必须在项目目录里、文件名是认得的那几种（或 *.yml / *.yaml 且在标签里列着）。 */
  private checkCompose(dir: string, files: string[]): string[] {
    if (files.length === 0) throw Object.assign(new Error('这个项目没有 compose 文件'), { status: 409 })
    for (const f of files) {
      if (posix.dirname(posix.normalize(f)) !== dir || !/\.ya?ml$/.test(f)) {
        throw Object.assign(new Error(`compose 文件不在项目目录里：${f}`), { status: 403 })
      }
    }
    return files.map((f) => posix.normalize(f))
  }

  read(dir: string, files: string[]): ProjectFiles {
    const d = this.checkDir(dir)
    const compose = this.checkCompose(d, files).map((path) => ({ path, content: this.readText(path) }))
    const envPath = posix.join(d, '.env')
    const exists = existsSync(envPath)
    return { compose, env: { path: envPath, content: exists ? this.readText(envPath) : '', exists }, backups: this.listBackups(d) }
  }

  private readText(path: string): string {
    const size = statSync(path).size
    if (size > maxFileSize) throw Object.assign(new Error(`${posix.basename(path)} 太大（${size} 字节），不在 Kura 里编辑`), { status: 413 })
    return readFileSync(path, 'utf8')
  }

  /**
   * 保存：先在临时副本上校验，通过才备份旧文件、原子替换。
   * `compose` 的每一项必须是 read() 给出的那几个路径之一（只改内容，不能借机写别处）。
   */
  async write(dir: string, files: string[], next: { compose: Array<{ path: string; content: string }>; env?: string }): Promise<ProjectFiles> {
    const d = this.checkDir(dir)
    const allowed = this.checkCompose(d, files)
    for (const f of next.compose) {
      if (!allowed.includes(posix.normalize(f.path))) throw Object.assign(new Error(`不能写这个文件：${f.path}`), { status: 403 })
      if (Buffer.byteLength(f.content) > maxFileSize) throw Object.assign(new Error(`${posix.basename(f.path)} 太大`), { status: 413 })
    }
    if (next.env !== undefined && Buffer.byteLength(next.env) > maxFileSize) throw Object.assign(new Error('.env 太大'), { status: 413 })

    // 1. 临时目录里拼一份「改完的样子」去校验：路径解析要和真目录一致，所以临时文件放在项目目录里（带前缀、校验完就删）
    const stamp = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
    const temp = new Map<string, string>()
    const tempPath = (p: string) => posix.join(d, `.kura-check-${stamp}-${posix.basename(p)}`)
    try {
      const check: string[] = []
      for (const f of allowed) {
        const edited = next.compose.find((c) => posix.normalize(c.path) === f)
        if (edited) {
          const t = tempPath(f)
          writeFileSync(t, edited.content)
          temp.set(f, t)
          check.push(t)
        } else check.push(f)
      }
      let envCheck: string | undefined
      if (next.env !== undefined) {
        envCheck = posix.join(d, `.kura-check-${stamp}.env`)
        writeFileSync(envCheck, next.env)
      }
      const problem = await this.validate(d, check, envCheck ?? (existsSync(posix.join(d, '.env')) ? posix.join(d, '.env') : undefined))
      if (envCheck) rmSync(envCheck, { force: true })
      if (problem) throw Object.assign(new Error(`compose 校验没通过，没有保存：\n${problem.replaceAll(`.kura-check-${stamp}-`, '')}`), { status: 422 })

      // 2. 备份要改的文件
      const changed = [...temp.keys(), ...(next.env !== undefined ? [posix.join(d, '.env')] : [])]
      this.backup(d, changed)

      // 3. 原子替换：临时文件改名覆盖（同一目录，rename 是原子的）
      for (const [real, t] of temp) {
        renameSync(t, real)
        temp.delete(real)
      }
      if (next.env !== undefined) {
        const t = posix.join(d, `.kura-env-${stamp}`)
        writeFileSync(t, next.env)
        renameSync(t, posix.join(d, '.env'))
      }
    } finally {
      for (const t of temp.values()) rmSync(t, { force: true })
    }
    return this.read(d, files)
  }

  private backup(dir: string, paths: string[]): void {
    const existing = paths.filter((p) => existsSync(p))
    if (existing.length === 0) return
    const target = posix.join(dir, backupDir, new Date().toISOString().replace(/[:.]/g, '-'))
    mkdirSync(target, { recursive: true })
    for (const p of existing) copyFileSync(p, posix.join(target, posix.basename(p)))
    // 只留最近几份：按名字（时间戳）排序删最旧的。逐个按已知路径删，不用通配符（AGENTS.md 七）
    const all = this.listBackups(dir)
    for (const old of all.slice(keepBackups)) rmSync(posix.join(dir, backupDir, old), { recursive: true, force: true })
  }

  /** 新的在前 */
  listBackups(dir: string): string[] {
    const b = posix.join(dir, backupDir)
    if (!existsSync(b)) return []
    return readdirSync(b)
      .filter((n) => /^\d{4}-\d{2}-\d{2}T/.test(n))
      .sort()
      .reverse()
  }

  /** 新建项目：建目录、写 compose（和可选的 .env）。目录已存在且有 compose 文件就拒绝。 */
  async create(name: string, compose: string, env: string): Promise<{ dir: string; configFiles: string[] }> {
    checkProjectName(name)
    if (!this.root) throw Object.assign(new Error('没有配置项目目录'), { status: 409 })
    const dir = posix.join(posix.normalize(this.root), name)
    if (composeFileNames.some((f) => existsSync(posix.join(dir, f)))) throw Object.assign(new Error(`项目「${name}」已经存在`), { status: 409 })
    if (Buffer.byteLength(compose) > maxFileSize || Buffer.byteLength(env) > maxFileSize) throw Object.assign(new Error('文件太大'), { status: 413 })
    const createdDir = !existsSync(dir)
    mkdirSync(dir, { recursive: true })
    const file = posix.join(dir, 'docker-compose.yaml')
    const stamp = Date.now().toString(36)
    const tempCompose = posix.join(dir, `.kura-check-${stamp}-docker-compose.yaml`)
    const tempEnv = env ? posix.join(dir, `.kura-check-${stamp}.env`) : undefined
    try {
      writeFileSync(tempCompose, compose)
      if (tempEnv) writeFileSync(tempEnv, env)
      const problem = await this.validate(dir, [tempCompose], tempEnv)
      if (problem) throw Object.assign(new Error(`compose 校验没通过，没有创建：\n${problem.replaceAll(`.kura-check-${stamp}-`, '')}`), { status: 422 })
      renameSync(tempCompose, file)
      if (tempEnv) renameSync(tempEnv, posix.join(dir, '.env'))
    } catch (error) {
      rmSync(tempCompose, { force: true })
      if (tempEnv) rmSync(tempEnv, { force: true })
      // 只删自己刚建的空目录（rmdir 语义：非空就不动）
      if (createdDir) {
        try {
          if (readdirSync(dir).length === 0) rmdirSync(dir)
        } catch {
          // 删不掉就留着，空目录无害
        }
      }
      throw error
    }
    return { dir, configFiles: [file] }
  }

  /**
   * 删除项目的**文件**（容器、卷由 compose down 处理）。只删 Kura 认得的东西：
   * compose 文件、`.env`、备份目录；目录里还有别的（数据目录之类）就留着整个目录，不递归删。
   */
  removeFiles(dir: string, files: string[]): { removed: string[]; kept: string[] } {
    const d = this.checkDir(dir)
    const targets = [...this.checkCompose(d, files), posix.join(d, '.env')]
    const removed: string[] = []
    for (const t of targets) {
      if (existsSync(t)) {
        rmSync(t, { force: true })
        removed.push(t)
      }
    }
    const bak = posix.join(d, backupDir)
    if (existsSync(bak)) {
      rmSync(bak, { recursive: true, force: true })
      removed.push(bak)
    }
    const kept = existsSync(d) ? readdirSync(d) : []
    // rmdir 只删空目录：目录里还有别的东西就原样留着
    if (kept.length === 0 && existsSync(d)) rmdirSync(d)
    return { removed, kept }
  }
}
