import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      '@sparkelf/dsh-workbench-vault': fileURLToPath(new URL('./packages/workbench-vault/src/index.ts', import.meta.url)),
    },
  },
})
