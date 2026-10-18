import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { configFromEnv } from '../src/config.js'
import { runAgent } from '../src/loop.js'
import { appRootOf, typecheckFromEnv } from '../src/typecheck.js'
import { request, scripted } from './helpers.js'

const ta09 = JSON.parse(fs.readFileSync(new URL('./fixtures/ta-09-haiku.json', import.meta.url), 'utf8')) as { path: string; base: string; edits: { old_str: string; new_str: string }[] }

/** A folder laid out like an installed app: package.json, node_modules, dist/pleatkit.manifest.json. */
function appFolder(): { root: string; manifest: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pk-app-'))
  fs.writeFileSync(path.join(root, 'package.json'), '{}')
  fs.mkdirSync(path.join(root, 'node_modules'))
  fs.mkdirSync(path.join(root, 'dist'))
  const manifest = path.join(root, 'dist', 'pleatkit.manifest.json')
  fs.writeFileSync(manifest, '{}')
  return { root, manifest }
}

describe('DECISIONS 74.2: the loop type-checks by default when the app types are available', () => {
  it('auto: on next to a manifest whose app folder has node_modules, off without one, off for a URL or PLEATKIT_TYPECHECK=0', () => {
    const app = appFolder()
    expect(appRootOf(app.manifest)).toBe(app.root)
    expect(typecheckFromEnv({ PLEATKIT_MANIFEST: app.manifest })).toBeTypeOf('function')
    expect(typecheckFromEnv({ PLEATKIT_MANIFEST: app.manifest, PLEATKIT_TYPECHECK: '0' })).toBeNull()
    expect(typecheckFromEnv({ PLEATKIT_MANIFEST: 'https://cdn.example/pleatkit.manifest.json' })).toBeNull()
    const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'pk-bare-'))
    fs.writeFileSync(path.join(bare, 'pleatkit.manifest.json'), '{}')
    expect(typecheckFromEnv({ PLEATKIT_MANIFEST: path.join(bare, 'pleatkit.manifest.json') })).toBeNull()
    expect(typecheckFromEnv({})).toBeNull()
    // explicit: a root, or on without one (packages are `any`)
    expect(typecheckFromEnv({ PLEATKIT_TYPECHECK_ROOT: app.root })).toBeTypeOf('function')
    expect(typecheckFromEnv({ PLEATKIT_TYPECHECK: '1' })).toBeTypeOf('function')
    expect(typecheckFromEnv({ PLEATKIT_MANIFESTS: JSON.stringify({ crm: app.manifest }) })).toBeTypeOf('function')
  })

  it('the server config: the loop gets the auto check, server compiles only an explicit PLEATKIT_TYPECHECK=1', () => {
    const app = appFolder()
    const auto = configFromEnv({ PLEATKIT_MANIFEST: app.manifest })
    expect(auto.typecheck).toBeTypeOf('function')
    expect(auto.commitTypecheck).toBeNull()
    const forced = configFromEnv({ PLEATKIT_MANIFEST: app.manifest, PLEATKIT_TYPECHECK: '1' })
    expect(forced.commitTypecheck).toBe(forced.typecheck)
  })

  it("regression (stage 5, Haiku's ta-09): a variable read before its declaration is caught in the loop, and the model fixes it", async () => {
    // the recorded edit: a total computed from tableData above `const tableData = [...]`; esbuild and the static
    // rules pass it, the module throws at load, and the runtime refused the commit ("Module failed to evaluate")
    const broken = ta09.edits.map((e) => ({ tool: 'edit_file', input: { path: ta09.path, ...e } }))
    const fixed = {
      tool: 'edit_file',
      input: {
        path: ta09.path,
        old_str: 'const totalBudget = formatBudget(\n  tableData.reduce((sum, order) => sum + parseBudget(order.budget), 0),\n);\n\n',
        new_str: '',
      },
    }
    const moveBelow = { tool: 'edit_file', input: { path: ta09.path, old_str: 'export default function', new_str: 'const totalBudget = formatBudget(\n  tableData.reduce((sum, order) => sum + parseBudget(order.budget), 0),\n);\n\nexport default function' } }
    const turns = [
      { calls: [...broken, { tool: 'check', input: {} }] },
      { calls: [{ tool: 'finish', input: { verdict: 'ok', summary: 'The table now ends with a total row.' } }] },
      { calls: [fixed, moveBelow] },
      { calls: [{ tool: 'finish', input: { verdict: 'ok', summary: 'The table now ends with a total row.' } }] },
    ]
    const req = request('add a row with the total budget', {
      files: { [ta09.path]: ta09.base },
      readonly: {},
      coreTypes: {},
      components: [ta09.path],
      context: { dynamicRoots: ['src/dynamic/'], externals: ['react', 'react/jsx-runtime', '@/components/ui/table', '@/components/ui/badge/Badge'], externalPatterns: ['react', 'react/jsx-runtime', '@/components/ui/table', '@/components/ui/badge/Badge'], alias: { '@': 'src' } },
    })
    const options = { classify: false, base: { [ta09.path]: ta09.base }, protected: [] as string[] }

    // without the type check (the old default) the crashing panel is accepted
    const before = await runAgent(req, scripted({ name: 'total', turns }), options)
    expect(before.verdict).toBe('ok')
    expect(before.files[ta09.path]!.indexOf('const totalBudget')).toBeLessThan(before.files[ta09.path]!.indexOf('const tableData'))

    // with it (auto: on whenever the app's types are available; `PLEATKIT_TYPECHECK=1` here, no app folder needed)
    const after = await runAgent(req, scripted({ name: 'total', turns }), { ...options, typecheck: typecheckFromEnv({ PLEATKIT_TYPECHECK: '1' }) })
    const firstCheck = after.log.find((l) => l.tool === 'check')!
    expect(firstCheck.result).toMatch(/TS2448/)
    const refused = after.log.filter((l) => l.tool === 'finish')[0]!
    expect(refused.ok).toBe(false)
    expect(after.verdict).toBe('ok')
    expect(after.modelCalls).toBe(4)
    expect(after.files[ta09.path]!.indexOf('const totalBudget')).toBeGreaterThan(after.files[ta09.path]!.indexOf('const tableData'))
  })
})
