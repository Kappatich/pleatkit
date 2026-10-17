import { createRequire } from 'node:module'
import path from 'node:path'
import { defineConfig } from 'vitest/config'

// The runtime's own devDependency is React 19; here every `react` import resolves to this package's React 18.
const require = createRequire(import.meta.url)
const dir = (pkg: string) => path.dirname(require.resolve(`${pkg}/package.json`))

export default defineConfig({
  resolve: {
    alias: [
      { find: /^react-dom$/, replacement: dir('react-dom') },
      { find: /^react-dom\/(.*)$/, replacement: `${dir('react-dom')}/$1` },
      { find: /^react$/, replacement: dir('react') },
      { find: /^react\/(.*)$/, replacement: `${dir('react')}/$1` },
    ],
  },
  test: { environment: 'node', testTimeout: 30_000 },
})
