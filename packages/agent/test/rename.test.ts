import { afterEach, describe, expect, it, vi } from 'vitest'
import { agentAuthFromEnv } from '../src/auth.js'
import { alertsFromEnv } from '../src/alerts.js'
import { configFromEnv } from '../src/config.js'
import { manifestSourceFromEnv } from '../src/manifest.js'

// The rename morphkit → pleatkit (DECISIONS 68): MORPHKIT_* is read as a fallback for one release.
const APP_KEY = 'mk_live_0123456789abcdefghijklmnop'
const SECRET = 's'.repeat(40)

describe('agent configuration under both names', () => {
  afterEach(() => vi.restoreAllMocks())

  it('PLEATKIT_* is read', () => {
    const c = configFromEnv({ PLEATKIT_PROVIDER: 'scripted', PLEATKIT_AGENT_PORT: '9101', PLEATKIT_APP_KEY: APP_KEY, PLEATKIT_JWT_SECRET: SECRET, PLEATKIT_APP_ID: 'crm' })
    expect(c.port).toBe(9101)
    expect(c.auth.credentials).toEqual({ appId: 'crm', appKey: APP_KEY, jwtSecret: SECRET })
  })

  it('MORPHKIT_* still works, with one deprecation line naming the old variables', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const c = configFromEnv({ MORPHKIT_PROVIDER: 'scripted', MORPHKIT_AGENT_PORT: '9102', MORPHKIT_APP_KEY: APP_KEY, MORPHKIT_JWT_SECRET: SECRET, MORPHKIT_MANIFEST: '/tmp/m.json' })
    expect(c.port).toBe(9102)
    expect(c.auth.credentials?.appKey).toBe(APP_KEY)
    expect(c.manifest).not.toBeNull()
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0]![0]).toMatch(/MORPHKIT_PROVIDER.*MORPHKIT_MANIFEST: rename to PLEATKIT_\*/)
  })

  it('the new name wins over the old one', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    expect(configFromEnv({ PLEATKIT_AGENT_PORT: '9103', MORPHKIT_AGENT_PORT: '9104' }).port).toBe(9103)
  })

  it('every *FromEnv entry point takes the old names on its own', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    expect(agentAuthFromEnv({ MORPHKIT_APP_KEY: APP_KEY, MORPHKIT_JWT_SECRET: SECRET }).credentials?.appId).toBe('default')
    expect(manifestSourceFromEnv({ MORPHKIT_MANIFEST: '/tmp/m.json' })).not.toBeNull()
    expect(alertsFromEnv({ MORPHKIT_FREEZE: 'off' }).freeze).toBe(false)
  })
})
