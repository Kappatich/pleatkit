/**
 * The six requests the public demo (demo.pleatkit.com, docs/demo-hosting.md) answers without a model: the film's
 * two opening requests and its four showcase requests. Each one is answered by a recorded fixture in
 * `e2e/fixtures/agent` (`fixture` is the fixture's `name`). Shared by the page (suggestion chips) and the demo server
 * (which only sends exactly these texts to the scripted provider).
 */
export interface DemoRequest {
  id: string
  text: string
  fixture: string
}

export const DEMO_REQUESTS: readonly DemoRequest[] = [
  { id: 'card-fields', text: 'In the customer card add phone, city and source; highlight an overdue payment date in red', fixture: 'scenario-1-customer-card-fields' },
  { id: 'deal-discount', text: 'Add a discount field to deals and recalculate the amount on the server', fixture: 'scenario-2-deal-discount' },
  { id: 'revenue-chart', text: 'Turn the deals table into a monthly revenue chart with a three-month forecast and mark the best month', fixture: 'showcase-revenue-chart' },
  { id: 'retention-heatmap', text: 'Show customer retention by signup cohort as a heatmap', fixture: 'showcase-retention-heatmap' },
  { id: 'deals-kanban', text: 'Show open deals as a kanban board by stage', fixture: 'showcase-deals-kanban' },
  { id: 'pipeline-pivot', text: 'Summarise pipeline by region and owner as a pivot table with totals', fixture: 'showcase-pipeline-pivot' },
]

/** Lower case, single spaces, no trailing punctuation: a chip sent as is, or retyped with a stray space, still matches. */
export function normalizeRequest(text: string): string {
  return text
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.!?;,\s]+$/, '')
}

/** The demo request this text is (exactly, after normalizing), or null for free text. */
export function demoRequestOf(text: string): DemoRequest | null {
  const n = normalizeRequest(text)
  return DEMO_REQUESTS.find((r) => normalizeRequest(r.text) === n) ?? null
}
