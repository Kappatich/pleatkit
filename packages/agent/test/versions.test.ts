import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import * as esbuild from 'esbuild'
import { describe, expect, it } from 'vitest'
import { COMPILER_VERSION, ESBUILD_VERSION } from '@morphkit/runtime/compiler'

const packages = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const pkg = (name: string) => JSON.parse(fs.readFileSync(path.join(packages, name, 'package.json'), 'utf8')) as Record<string, Record<string, string>>

describe('one esbuild version everywhere (V1 B6)', () => {
  it('the browser compiler, the agent server and the Vite plugin pin the same esbuild', () => {
    expect(esbuild.version).toBe(ESBUILD_VERSION)
    expect(pkg('runtime').dependencies!['esbuild-wasm']).toBe(ESBUILD_VERSION)
    expect(pkg('agent').dependencies!.esbuild).toBe(ESBUILD_VERSION)
    expect(pkg('vite-plugin').dependencies!.esbuild).toBe(ESBUILD_VERSION)
    expect(COMPILER_VERSION).toContain(ESBUILD_VERSION)
  })

  it('peer ranges: React 18 and 19, Vite 6 to 8', () => {
    expect(pkg('runtime').peerDependencies!.react).toBe('^18.0.0 || ^19.0.0')
    expect(pkg('ui').peerDependencies!.react).toBe('^18.0.0 || ^19.0.0')
    expect(pkg('vite-plugin').peerDependencies!.vite).toBe('^6.0.0 || ^7.0.0 || ^8.0.0')
  })
})
