// 样式由 esbuild 抽成 index.css；这里只让 tsc 认得 CSS 的副作用导入。
// 必须是无 import 的脚本文件，否则 declare module 会被当成模块增强而不生效。
declare module '*.css'
