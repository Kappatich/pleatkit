import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { MorphkitManifest } from '@morphkit/runtime/compiler'
import type { EvalTask } from '../src/types.js'

export const CARD = 'src/dynamic/customer-card.tsx'
export const TABLE = 'src/dynamic/deals-table.tsx'

export const BASE_CARD = `import type { Customer } from '@/readonly/api'
export default function CustomerCard({ customer }: { customer: Customer }) {
  return <div data-testid="customer-card">{customer.name}</div>
}
`
export const PHONE_CARD = `import type { Customer } from '@/readonly/api'
export default function CustomerCard({ customer }: { customer: Customer }) {
  const phone = typeof customer.meta.phone === 'string' ? customer.meta.phone : '—'
  return <div data-testid="customer-card">{customer.name}<span data-testid="phone">{phone}</span></div>
}
`
const TABLE_SRC = `export default function DealsTable() { return <table data-testid="deals-table" /> }\n`

/** A small app manifest, so the graders and the runner are tested without the demo's build. */
export const MANIFEST: MorphkitManifest = {
  version: 1,
  dynamicRoots: ['src/dynamic/'],
  dynamic: [
    { path: CARD, source: BASE_CARD },
    { path: TABLE, source: TABLE_SRC },
  ],
  readonly: [{ path: 'src/readonly/api.ts', source: `export interface Customer { id: string; name: string; meta: Record<string, unknown> }\n` }],
  coreTypes: [],
  externals: ['react', 'react/jsx-runtime', '@/readonly/api'],
  externalPatterns: ['react', 'react/jsx-runtime', '@/readonly/*'],
  alias: { '@': 'src' },
}

/** A temp file with this content (reference solutions are paths). */
export function tempFile(name: string, content: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-evals-'))
  const file = path.join(dir, name)
  fs.writeFileSync(file, content)
  return file
}

export function changeTask(over: Partial<EvalTask> = {}): EvalTask {
  return {
    id: 't-phone',
    app: 'demo-crm',
    title: 'Phone in the card',
    request: 'show the phone in the card',
    expected: { verdict: 'ok', change: true },
    invariants: {
      files: [{ path: CARD, mustContain: ['data-testid="customer-card"', 'data-testid="phone"'] }],
      forbidden: ['localStorage'],
      unchanged: [TABLE],
      predicates: ['plain-summary'],
      browser: { checks: [{ testid: 'phone', within: 'customer-card' }] },
    },
    reference: { files: { [CARD]: tempFile('phone.tsx', PHONE_CARD) } },
    ...over,
  }
}

export function noChangeTask(over: Partial<EvalTask> = {}): EvalTask {
  return { id: 't-backend', app: 'demo-crm', title: 'Server work', request: 'recalculate on the server', expected: { verdict: 'needs-backend', change: false }, invariants: { predicates: ['plain-summary'] }, ...over }
}
