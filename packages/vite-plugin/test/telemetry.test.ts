import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { sanitizeProps, telemetryStatus, track } from '../src/telemetry.js'

const home = () => fs.mkdtempSync(path.join(os.tmpdir(), 'pleatkit-telemetry-'))
const ON = { PLEATKIT_TELEMETRY_URL: 'https://collector.test/v1/events' }

describe('telemetry (F8)', () => {
  it('is off without a collector, with PLEATKIT_TELEMETRY=0, DO_NOT_TRACK or in CI', () => {
    expect(telemetryStatus({})).toMatchObject({ enabled: false, reason: 'no collector configured' })
    expect(telemetryStatus({ ...ON, PLEATKIT_TELEMETRY: '0' })).toMatchObject({ enabled: false, reason: 'PLEATKIT_TELEMETRY=0' })
    expect(telemetryStatus({ ...ON, DO_NOT_TRACK: '1' }).enabled).toBe(false)
    expect(telemetryStatus({ ...ON, CI: 'true' }).enabled).toBe(false)
    expect(telemetryStatus(ON).enabled).toBe(true)
  })

  it('sends one anonymous event: name, install id, versions, platform, path-free props', async () => {
    const dir = home()
    const fetchFn = vi.fn(async () => new Response('{}'))
    const notice = vi.fn()
    const sent = await track('doctor.fail:csp', { compile: 'server', root: 'C:\\Users\\me\\app', file: 'src/x.tsx', count: 3 }, { env: ON, home: dir, fetch: fetchFn as unknown as typeof fetch, notice, source: { package: '@pleatkit/cli', version: '0.1.0' } })
    expect(sent).toBe(true)
    const body = JSON.parse((fetchFn.mock.calls[0] as unknown as [string, RequestInit])[1].body as string) as Record<string, unknown>
    expect(body).toMatchObject({ event: 'doctor.fail:csp', package: '@pleatkit/cli', version: '0.1.0', os: process.platform, props: { compile: 'server', count: 3 } })
    expect(JSON.stringify(body)).not.toMatch(/Users|src\/x/)
    expect(notice).toHaveBeenCalledTimes(1)
    // the install id is stable and the notice is shown once
    await track('ping.ok', {}, { env: ON, home: dir, fetch: fetchFn as unknown as typeof fetch, notice })
    const second = JSON.parse((fetchFn.mock.calls[1] as unknown as [string, RequestInit])[1].body as string) as Record<string, unknown>
    expect(second.installId).toBe(body.installId)
    expect(notice).toHaveBeenCalledTimes(1)
  })

  it('opted out: nothing is sent and nothing is written', async () => {
    const dir = home()
    const fetchFn = vi.fn()
    expect(await track('plugin.build', {}, { env: { ...ON, PLEATKIT_TELEMETRY: 'off' }, home: dir, fetch: fetchFn as unknown as typeof fetch })).toBe(false)
    expect(await track('plugin.build', {}, { env: {}, home: dir, fetch: fetchFn as unknown as typeof fetch })).toBe(false)
    expect(fetchFn).not.toHaveBeenCalled()
    expect(fs.existsSync(path.join(dir, '.pleatkit'))).toBe(false)
    expect(sanitizeProps({ url: 'https://x.test', ok: true })).toEqual({ ok: true })
  })

  it('never throws, even when the collector is down', async () => {
    const fetchFn = vi.fn(async () => Promise.reject(new Error('offline')))
    expect(await track('plugin.build', {}, { env: ON, home: home(), fetch: fetchFn as unknown as typeof fetch, notice: () => undefined })).toBe(false)
  })
})
