import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // 连接核心与主进程逻辑都是纯 Node；渲染层测试在文件头用 @vitest-environment jsdom 切换
    environment: 'node',
    include: ['src/**/*.test.{ts,tsx}', 'tests/**/*.test.{ts,tsx}'],
  },
})
