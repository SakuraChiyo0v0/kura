/**
 * 生成应用图标 assets/icon.ico（16–256 多尺寸）与托盘图 assets/tray.png（32）。
 *
 * 图形与原来的托盘占位图一致：樱色圆角方块 + 白色「蔵」顶（屋檐 + 门框）。
 * 用矢量规则按尺寸重画、4×4 超采样抗锯齿，不依赖任何图像库。改了图形就重跑：
 *   node scripts/make-icon.mjs
 */
import { writeFileSync } from 'node:fs'
import { deflateSync } from 'node:zlib'
import { fileURLToPath } from 'node:url'

process.chdir(fileURLToPath(new URL('..', import.meta.url)))

const sakura = [232, 106, 146]
const white = [255, 255, 255]

/** 在 0..1 的单位方块里判断一点的颜色；返回 undefined 表示透明。 */
function shade(x, y) {
  // 圆角方块（圆角半径 0.22）
  const r = 0.22
  const cx = Math.min(Math.max(x, r), 1 - r)
  const cy = Math.min(Math.max(y, r), 1 - r)
  if ((x - cx) ** 2 + (y - cy) ** 2 > r * r) return undefined
  // 屋檐：上窄下宽的梯形（y 0.25–0.34）
  if (y >= 0.25 && y < 0.34) {
    const t = (y - 0.25) / 0.09
    const half = 0.16 + t * 0.2
    if (Math.abs(x - 0.5) < half) return white
  }
  // 门楣（y 0.375–0.47，x 0.28–0.72）
  if (y >= 0.375 && y < 0.47 && x >= 0.28 && x < 0.72) return white
  // 两根门柱（到 y 0.75）
  if (y >= 0.47 && y < 0.75 && ((x >= 0.28 && x < 0.405) || (x >= 0.595 && x < 0.72))) return white
  return sakura
}

function render(size) {
  const ss = 4
  const rgba = Buffer.alloc(size * size * 4)
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0, g = 0, b = 0, a = 0
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const c = shade((px + (sx + 0.5) / ss) / size, (py + (sy + 0.5) / ss) / size)
          if (!c) continue
          r += c[0]; g += c[1]; b += c[2]; a += 1
        }
      }
      const i = (py * size + px) * 4
      if (a) {
        rgba[i] = Math.round(r / a)
        rgba[i + 1] = Math.round(g / a)
        rgba[i + 2] = Math.round(b / a)
      }
      rgba[i + 3] = Math.round((a / (ss * ss)) * 255)
    }
  }
  return rgba
}

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})
function crc32(buf) {
  let c = 0xffffffff
  for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}

function png(size) {
  const rgba = render(size)
  const raw = Buffer.alloc(size * (size * 4 + 1))
  for (let y = 0; y < size; y++) rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4)
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8 // 位深
  ihdr[9] = 6 // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

/** ICO 容器：每个尺寸直接内嵌 PNG（Vista 起支持，electron-builder / NSIS 也认）。 */
function ico(sizes) {
  const images = sizes.map(png)
  const header = Buffer.alloc(6)
  header.writeUInt16LE(1, 2) // 类型：图标
  header.writeUInt16LE(sizes.length, 4)
  let offset = 6 + 16 * sizes.length
  const entries = sizes.map((size, i) => {
    const e = Buffer.alloc(16)
    e[0] = size >= 256 ? 0 : size
    e[1] = size >= 256 ? 0 : size
    e.writeUInt16LE(1, 4) // 色面
    e.writeUInt16LE(32, 6) // 位深
    e.writeUInt32LE(images[i].length, 8)
    e.writeUInt32LE(offset, 12)
    offset += images[i].length
    return e
  })
  return Buffer.concat([header, ...entries, ...images])
}

writeFileSync('assets/icon.ico', ico([16, 20, 24, 32, 40, 48, 64, 128, 256]))
writeFileSync('assets/tray.png', png(32))
writeFileSync('assets/icon.png', png(256))
console.log('已生成 assets/icon.ico、assets/icon.png、assets/tray.png')
