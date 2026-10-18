import { describe, expect, it } from 'vitest'
import type { PleatkitManifest } from '@pleatkit/runtime/compiler'
import { countPromptTokens, sampleRequest } from '../src/prefix.js'

const manifest: PleatkitManifest = {
  version: 1,
  dynamicRoots: ['src/dynamic/'],
  dynamic: [{ path: 'src/dynamic/card.tsx', source: 'export default function Card() { return <div>Card</div> }\n' }],
  readonly: [{ path: 'src/readonly/api.ts', source: 'export interface Customer { id: string }\n' }],
  coreTypes: [],
  externals: ['react', 'react/jsx-runtime', '@/readonly/api'],
  externalPatterns: ['react', 'react/jsx-runtime', '@/readonly/*'],
  alias: { '@': 'src' },
  designSystem: { digest: 'src/components/ui/badge: Badge(variant?: "default" | "outline")' },
}

describe('DECISIONS 73.5: the prompt counted by the API token counter', () => {
  it('counts tools + system + request, then the request alone; the difference is the cached prefix', async () => {
    const bodies: Record<string, unknown>[] = []
    const fetch = (async (url: string, init?: RequestInit) => {
      expect(String(url)).toMatch(/\/v1\/messages\/count_tokens/)
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>
      bodies.push(body)
      return new Response(JSON.stringify({ input_tokens: body.system ? 7_400 : 320 }), { status: 200, headers: { 'content-type': 'application/json' } })
    }) as typeof globalThis.fetch
    const r = await countPromptTokens(manifest, { apiKey: 'k', baseURL: 'http://anthropic.test', fetch })
    expect(r).toMatchObject({ prefixTokens: 7_080, tailTokens: 320, model: 'claude-sonnet-5-5' })
    type Body = { tools: { name: string }[]; system?: unknown; messages: unknown }
    const [full, tail] = bodies as unknown as [Body, Body]
    expect(full.tools.map((t: { name: string }) => t.name)).toEqual(['list_files', 'read_file', 'write_file', 'edit_file', 'check', 'finish'])
    expect(JSON.stringify(full.system)).toContain('Badge(variant?: \\"default\\" | \\"outline\\")')
    expect(JSON.stringify(full.system)).toContain('src/readonly/api.ts')
    expect(tail.system).toBeUndefined()
    expect(tail.messages).toEqual(full.messages)
  })

  it('the sample request is the one the agent server would build from the manifest', () => {
    const req = sampleRequest(manifest)
    expect(req.files).toEqual({ 'src/dynamic/card.tsx': manifest.dynamic[0]!.source })
    expect(req.components).toEqual(['src/dynamic/card.tsx'])
    expect(Object.keys(req.readonly)).toEqual(['src/readonly/api.ts'])
  })
})
