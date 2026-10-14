import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ConnectionConfig } from '../core/mirror.js'
import { CredentialVault, type Cipher } from './vault.js'

/** 假加密：异或 + 反转，足够证明「磁盘上不是明文」且能往返。 */
const fakeCipher = (available = true): Cipher => ({
  isEncryptionAvailable: () => available,
  encryptString: (plain) => Buffer.from(Buffer.from(plain).map((b) => b ^ 0x5a)).reverse(),
  decryptString: (buf) => Buffer.from(Buffer.from(buf).reverse().map((b) => b ^ 0x5a)).toString(),
})

const sample: ConnectionConfig = {
  base: 'https://dev-1.cn30.ug.link',
  ugreenUser: 'someone',
  ugreenPassword: 'Very-Secret-123',
  lanHost: '10.0.0.5',
  mode: 'auto',
  gatewayPort: 8898,
}

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'kura-vault-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('CredentialVault', () => {
  it('往返一致，且磁盘上找不到任何明文（密码、用户名、设备域都不行）', () => {
    const file = join(dir, 'credentials.json')
    const vault = new CredentialVault(file, fakeCipher())
    vault.save(sample)
    expect(vault.load()).toEqual(sample)
    const disk = readFileSync(file, 'utf8')
    for (const secret of ['Very-Secret-123', 'Gateway-Secret-456', 'someone', 'gw-user', 'dev-1', '10.0.0.5']) {
      expect(disk).not.toContain(secret)
    }
  })

  it('没有加密能力时拒绝保存，不退回明文', () => {
    const file = join(dir, 'credentials.json')
    expect(() => new CredentialVault(file, fakeCipher(false)).save(sample)).toThrow(/拒绝保存/)
  })

  it('文件不存在、损坏、解不开都当作没配置', () => {
    const file = join(dir, 'credentials.json')
    const vault = new CredentialVault(file, fakeCipher())
    expect(vault.load()).toBeUndefined()
    writeFileSync(file, '{broken')
    expect(vault.load()).toBeUndefined()
    writeFileSync(file, JSON.stringify({ version: 1, data: Buffer.from('garbage').toString('base64') }))
    expect(vault.load()).toBeUndefined()
  })

  it('clear 之后读不到', () => {
    const vault = new CredentialVault(join(dir, 'credentials.json'), fakeCipher())
    vault.save(sample)
    vault.clear()
    expect(vault.load()).toBeUndefined()
  })
})
