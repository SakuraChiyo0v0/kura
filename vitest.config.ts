import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // 连接核心与主进程逻辑都是纯 Node；渲染层测试在文件头用 @vitest-environment jsdom 切换
    environment: 'node',
    // 每个测试文件在独立 worker 里各生成一次 RSA 密钥，并行时会把别的用例饿到 5 秒默认超时之外
    testTimeout: 20_000,
    include: ['src/**/*.test.{ts,tsx}', 'tests/**/*.test.{ts,tsx}'],
  },
})
