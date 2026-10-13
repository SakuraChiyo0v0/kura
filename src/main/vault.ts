import { readFileSync, rmSync } from 'node:fs'
import { writeJsonAtomic } from '../core/store.js'
import type { ConnectionConfig } from '../core/mirror.js'

/**
 * 加密能力：主进程注入 Electron 的 safeStorage（Windows 上是 DPAPI，绑定当前 Windows 用户）。
 * 测试注入一个可逆的假实现。
 */
export interface Cipher {
  isEncryptionAvailable(): boolean
  encryptString(plain: string): Buffer
  decryptString(encrypted: Buffer): string
}

interface VaultFile {
  version: 1
  /** base64(safeStorage 加密后的 ConnectionConfig JSON) */
  data: string
}

/**
 * 连接配置（含绿联密码、网关密码）的加密存储。
 *
 * 整份配置一起加密，而不是只加密密码字段：设备域、局域网地址、用户名同样属于敏感信息
 * （nas-mirror 泄密事件的结论）。磁盘上只有一段密文，明文不落盘、不进日志。
 * 系统不提供加密（极少见）时拒绝保存，而不是退回明文。
 */
export class CredentialVault {
  constructor(
    private readonly file: string,
    private readonly cipher: Cipher,
  ) {}

  load(): ConnectionConfig | undefined {
    let raw: string
    try {
      raw = readFileSync(this.file, 'utf8')
    } catch {
      return undefined
    }
    try {
      const parsed = JSON.parse(raw) as VaultFile
      if (parsed.version !== 1 || typeof parsed.data !== 'string') return undefined
      return JSON.parse(this.cipher.decryptString(Buffer.from(parsed.data, 'base64'))) as ConnectionConfig
    } catch {
      // 坏文件、或换了 Windows 用户（DPAPI 解不开）：当作没配置，引导重新录入
      return undefined
    }
  }

  save(config: ConnectionConfig): void {
    if (!this.cipher.isEncryptionAvailable()) {
      throw new Error('系统没有提供加密存储（safeStorage 不可用），为了不把密码明文写盘，拒绝保存')
    }
    const data = this.cipher.encryptString(JSON.stringify(config)).toString('base64')
    writeJsonAtomic(this.file, { version: 1, data } satisfies VaultFile)
  }

  clear(): void {
    rmSync(this.file, { force: true })
  }
}
