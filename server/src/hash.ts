import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'

/** 文件的 SHA256（十六进制）。用来校验镜像里带的 rclone 是不是固定版本那一份。 */
export async function hashFile(file: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer)
  return hash.digest('hex')
}
