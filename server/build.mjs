import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

/**
 * kura-server 打成单文件 ESM（dist/server/main.mjs）：镜像里只需要 Node，不需要 node_modules。
 * 共用的客户端代码（src/core/store.js 等）一并打进来。
 */
process.chdir(fileURLToPath(new URL('..', import.meta.url)))

await build({
  entryPoints: ['server/src/main.ts'],
  outfile: 'dist/server/main.mjs',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  sourcemap: true,
  legalComments: 'none',
  logLevel: 'warning',
  // esbuild 打 ESM 时，第三方 CJS 依赖里的 require() 需要一个真的 require
  banner: { js: "import { createRequire as __kuraRequire } from 'node:module'; const require = __kuraRequire(import.meta.url);" },
})

console.log('构建完成：dist/server/main.mjs')
