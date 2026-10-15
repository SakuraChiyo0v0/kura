import { copyFileSync, rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

process.chdir(fileURLToPath(new URL('.', import.meta.url)))

const common = {
  bundle: true,
  sourcemap: true,
  logLevel: 'warning',
  legalComments: 'none',
}

rmSync('dist', { recursive: true, force: true })

// 主进程与 preload 打成 CJS：preload 在 sandbox 下不能加载 ESM
for (const entry of ['main', 'preload']) {
  await build({
    ...common,
    entryPoints: [`src/${entry}/index.ts`],
    outfile: `dist/${entry}.cjs`,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    external: ['electron'],
  })
}

// 渲染层用 IIFE：file:// 下 ESM 的 module script 会被 CORS 拦掉
await build({
  ...common,
  entryPoints: ['src/renderer/index.tsx'],
  outfile: 'dist/renderer/index.js',
  platform: 'browser',
  format: 'iife',
  target: 'chrome130',
  jsx: 'automatic',
  define: { 'process.env.NODE_ENV': '"production"' },
})

copyFileSync('src/renderer/index.html', 'dist/renderer/index.html')
// index.css 是 esbuild 从 CSS import 抽出的库样式；页面外壳单独叫 shell.css，避免同名覆盖
copyFileSync('src/renderer/shell.css', 'dist/renderer/shell.css')
copyFileSync('assets/tray.png', 'dist/tray.png')
copyFileSync('assets/icon.ico', 'dist/icon.ico')
// 应用里的「更新内容」读这份（与 GitHub Release 正文同源）
copyFileSync('CHANGELOG.md', 'dist/CHANGELOG.md')

console.log('构建完成：dist/main.cjs, dist/preload.cjs, dist/renderer/')
