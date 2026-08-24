import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [react()],
  root: '.',
  build: {
    outDir: 'dist/client',
    emptyOutDir: true,
  },
  server: {
    proxy: {
      '/api': 'http://localhost:4949',
    },
  },
  test: {
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    environment: 'node',
    // Tests assert the published `npx -y @diffohq/diffo` spelling, so a developer running
    // with ENV=development would otherwise watch the suite go red.
    env: { ENV: '' },
    /* Well above vitest's 5s default: a good part of this suite builds real git
     * repositories in tmp and shells out to `git` dozens of times per test, and on a
     * loaded machine that tripped the default at random. */
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
})
