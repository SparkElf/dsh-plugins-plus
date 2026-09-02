import { defineConfig } from 'playwright/test'

export default defineConfig({
  testDir: './tests/system',
  testMatch: ['mobile-bridge.spec.mjs', 'dataops-query.spec.mjs', 'univer-government-docs.spec.mjs'],
  timeout: 90_000,
  workers: 1,
  reporter: 'list',
  use: {
    actionTimeout: 10_000,
    channel: 'chrome',
    locale: 'zh-CN',
    viewport: { width: 1440, height: 1000 },
  },
})
