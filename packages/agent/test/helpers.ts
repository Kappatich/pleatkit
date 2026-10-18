import type { AgentRunRequest } from '@pleatkit/runtime/compiler'
import { ScriptedProvider, type ScriptFixture } from '../src/providers/scripted.js'

export const CARD = 'src/dynamic/customer-card.tsx'
export const TABLE = 'src/dynamic/deals-table.tsx'

export const BASE_CARD = `import { cn } from '@/lib/utils'
import type { Customer } from '@/readonly/api'
export default function CustomerCard({ customer }: { customer: Customer }) {
  return <div className={cn('card')} data-testid="customer-card">{customer.name}</div>
}
`
export const GOOD_CARD = `import { cn } from '@/lib/utils'
import type { Customer } from '@/readonly/api'
export default function CustomerCard({ customer }: { customer: Customer }) {
  const phone = typeof customer.meta.phone === 'string' ? customer.meta.phone : '—'
  return <div className={cn('card')} data-testid="customer-card">{customer.name}<span className="text-red-600">{phone}</span></div>
}
`
export const BROKEN_CARD = `export default function CustomerCard() {
  return <div><span></div>
}
`

export function request(text: string, extra: Partial<AgentRunRequest> = {}): AgentRunRequest {
  return {
    userId: 'alice',
    appId: 'test',
    request: text,
    files: { [CARD]: BASE_CARD, [TABLE]: `export default function DealsTable() { return <table /> }\n` },
    readonly: { 'src/readonly/api.ts': `export interface Customer { id: string; name: string; meta: Record<string, unknown> }\n` },
    coreTypes: { 'src/lib/utils.d.ts': `export declare function cn(...c: unknown[]): string\n` },
    context: {
      dynamicRoots: ['src/dynamic/'],
      externals: ['react', 'react/jsx-runtime', '@/lib/utils', '@/readonly/api'],
      externalPatterns: ['react', 'react/jsx-runtime', '@/lib/utils', '@/readonly/*'],
      alias: { '@': 'src' },
    },
    components: [CARD, TABLE],
    ...extra,
  }
}

export function scripted(...fixtures: Omit<ScriptFixture, 'match'>[]): ScriptedProvider {
  return new ScriptedProvider(fixtures.map((f) => ({ ...f, match: [f.name], dir: '.', patterns: [new RegExp(f.name, 'i')] })))
}
