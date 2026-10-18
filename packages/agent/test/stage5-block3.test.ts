import { describe, expect, it } from 'vitest'
import { buildPrompt, digestsFromManifest, instructions, PROMPT_VERSION } from '../src/prompt.js'
import { request } from './helpers.js'

describe('stage 5 block 3: prompt 5e', () => {
  it('74.3 and 74.4: a URL from data on a plain element and mailto:/tel: links from data are allowed; outside links are not', () => {
    const text = instructions(request('x'))
    expect(text).toMatch(/a URL taken from data in src or href of a plain element \(<img src=\{row\.image\}>, <a href=\{row\.url\}>\), which is shown only when it points to this app/)
    expect(text).toMatch(/mailto: and tel: links built from data \(`mailto:\$\{user\.email\}`\) are fine/)
    expect(text).toMatch(/never an absolute URL to another site/)
    expect(text).not.toMatch(/a URL taken from data is not/)
    expect(PROMPT_VERSION >= '2026-10-18.5e').toBe(true)
  })

  it('74.6: with an agent context in the manifest, the prompt shows its declarations instead of every source; read_file still reads all', () => {
    const req = request('x', { readonly: { 'src/readonly/api.ts': 'export const BIG_SOURCE = 1\n' }, coreTypes: { 'src/lib/utils.d.ts': 'export declare function cn(): string\n' } })
    const manifest = {
      designSystem: { digest: 'src/components/ui/button: Button(variant?: "default")' },
      agentContext: { files: [{ path: 'src/readonly/api.d.ts', source: 'export declare const BIG_SOURCE: number;' }], omitted: ['src/lib/far.d.ts'], estimatedTokens: 10, capTokens: 12000, untrimmedTokens: 30 },
    }
    const digests = digestsFromManifest(manifest)
    const p = buildPrompt(req, undefined, digests)
    expect(p.cached).toContain('<readonly_context>')
    expect(p.cached).toContain('export declare const BIG_SOURCE: number;')
    expect(p.cached).toContain('left out for size (read_file them when needed): src/lib/far.d.ts')
    expect(p.cached).not.toContain('<readonly_sources>')
    expect(p.cached).not.toContain('export const BIG_SOURCE = 1')
    // byte-stable across requests (the cache)
    expect(buildPrompt(request('other'), undefined, digests).cached).toBe(buildPrompt(req, undefined, digests).cached)
    // an older manifest without a context: every source, as before
    expect(buildPrompt(req, undefined, digestsFromManifest({ designSystem: manifest.designSystem })).cached).toContain('<readonly_sources>')
  })
})
