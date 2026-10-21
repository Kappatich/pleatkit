import { defineConfig } from 'vitest/config'

// Stage 5 block 8: the same 30 s timeout as the other packages (vitest's default is 5 s). The digest and manifest
// tests load the TypeScript compiler, which takes seconds on a machine busy with the whole repository's tests and a build.
export default defineConfig({
  test: { environment: 'node', testTimeout: 30_000 },
})
