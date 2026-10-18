import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import type { ResolvedConfig } from 'vite'
import pleatkit, { legacyVirtualId, morphkit, telemetryStatus, track, type MorphkitOptions, type PleatkitOptions } from '../src/index.js'

// The rename morphkit → pleatkit (DECISIONS 68): one release of compatibility for the plugin's old names.
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixture')
type Hook = (this: unknown, ...args: unknown[]) => unknown

describe('@pleatkit/vite-plugin deprecated names', () => {
  it('the named export morphkit is the default export', () => {
    expect(morphkit).toBe(pleatkit)
    const options: MorphkitOptions = { zones: { dynamic: ['src/dynamic/**'] } }
    const same: PleatkitOptions = options
    expect(morphkit(same).name).toBe('pleatkit')
  })

  it('virtual:morphkit/… resolves to virtual:pleatkit/… with one warning', async () => {
    expect(legacyVirtualId('virtual:morphkit')).toBe('virtual:pleatkit')
    expect(legacyVirtualId('virtual:morphkit/manifest')).toBe('virtual:pleatkit/manifest')
    expect(legacyVirtualId('virtual:morphkit/nope')).toBeNull()
    expect(legacyVirtualId('virtual:pleatkit/manifest')).toBeNull()
    const warn = vi.fn()
    const p = pleatkit({ zones: { dynamic: ['src/dynamic/**'], readonly: ['src/readonly/**'] } })
    ;(p.configResolved as Hook)({ root, command: 'build', base: '/', build: { assetsDir: 'assets' }, logger: { warn } } as unknown as ResolvedConfig)
    const resolved = (p.resolveId as Hook)('virtual:morphkit/manifest') as string
    expect(resolved).toBe((p.resolveId as Hook)('virtual:pleatkit/manifest'))
    ;(p.resolveId as Hook)('virtual:morphkit/externals')
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0]![0]).toMatch(/virtual:morphkit\/manifest" is deprecated/)
    const code = (await (p.load as Hook).call({ emitFile: () => undefined }, resolved)) as string
    expect(code).toContain('src/dynamic/')
  })

  it('PLEATKIT_TELEMETRY, and MORPHKIT_TELEMETRY as the fallback', () => {
    expect(telemetryStatus({ PLEATKIT_TELEMETRY: '0' })).toMatchObject({ enabled: false, reason: 'PLEATKIT_TELEMETRY=0' })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    expect(telemetryStatus({ MORPHKIT_TELEMETRY: '0' })).toMatchObject({ enabled: false, reason: 'PLEATKIT_TELEMETRY=0' })
    expect(warn).toHaveBeenCalledTimes(1)
    warn.mockRestore()
  })

  it('the install id in ~/.morphkit carries over to ~/.pleatkit', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pk-home-'))
    fs.mkdirSync(path.join(home, '.morphkit'))
    fs.writeFileSync(path.join(home, '.morphkit', 'telemetry.json'), JSON.stringify({ installId: 'old-id', noticeShown: true }))
    const bodies: { installId: string }[] = []
    const fetch = (async (_url: string, init: RequestInit) => (bodies.push(JSON.parse(String(init.body))), new Response('{}'))) as unknown as typeof globalThis.fetch
    expect(await track('build', {}, { env: { PLEATKIT_TELEMETRY_URL: 'https://collector.test/e' }, home, fetch, notice: () => undefined })).toBe(true)
    expect(bodies[0]!.installId).toBe('old-id')
    expect(JSON.parse(fs.readFileSync(path.join(home, '.pleatkit', 'telemetry.json'), 'utf8')).installId).toBe('old-id')
    fs.rmSync(home, { recursive: true, force: true })
  })
})
