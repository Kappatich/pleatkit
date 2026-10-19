#!/usr/bin/env node
// Writes the 5 edit chains (DECISIONS 75 Р3): 3 to 5 edits on the demo and on shadcn-admin, each on top of the
// previous one, then one edit from the middle taken back. Each step reuses the browser checks of the single-edit task
// that asks the same thing (proven by eval:sanity), plus a text pattern that must stay in the files while later
// steps land. Run from the repository root: `node evals/chains/make-chains.mjs`.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const tasks = path.resolve(here, '..', 'tasks')
const task = (id) => JSON.parse(fs.readFileSync(path.join(tasks, id.startsWith('crm-') ? '' : 'apps', `${id}.json`), 'utf8'))
const checks = (id, pick) => (task(id).invariants?.browser?.checks ?? []).filter((c, i) => !pick || pick.includes(i))

const PHONE = "[.'\"`]phone\\b"
const CITY = "[.'\"`]city\\b"
const step = (request, browser, anyMustMatch, extra = {}) => ({ request, expected: { verdict: 'ok', change: true }, invariants: { ...(anyMustMatch ? { anyMustMatch } : {}), ...(browser ? { browser } : {}) }, ...extra })

const chains = [
  {
    id: 'ch-01-demo-card',
    app: 'demo-crm',
    title: 'Demo: four edits to the customer card, the second one taken back (same file: the agent reverts)',
    steps: [
      step('Show the customer\'s phone in the card.', { checks: checks('crm-01-card-fields', [0]) }, [PHONE]),
      step('Under the phone, also show the city.', { checks: checks('crm-01-card-fields', [1]) }, [CITY]),
      step('Highlight an overdue payment date in red.', { checks: checks('crm-01-card-fields', [3]) }, ['red|destructive|rose']),
      step('Rename "Next payment" to "Payment due".', { checks: checks('crm-14-edit-file-label') }, ['Payment due']),
    ],
    revert: { step: 2, anyMustNotMatch: [CITY], browser: { checks: [{ testid: 'city', within: 'customer-card', count: 0 }] } },
  },
  {
    id: 'ch-02-demo-deals',
    app: 'demo-crm',
    title: 'Demo: a total row, an average tile, then sort the deals; the total taken back (deals file changed again later)',
    steps: [
      step('Add a total row to the deals table.', { checks: checks('crm-04-deals-total-row', [0]) }, ['57,?500|reduce|total|Total']),
      step('Show the average deal size on the dashboard.', { checks: checks('crm-13-ru-dashboard-average') }, null),
      step('Sort the deals from the biggest amount to the smallest.', { checks: [{ testid: 'deals-table', matches: 'Annual licence[\\s\\S]*Support upgrade' }] }, ['sort']),
    ],
    revert: { step: 1, anyMustNotMatch: ['57,?500'], browser: { checks: [{ testid: 'deals-table', notContains: '$57,500' }] } },
  },
  {
    id: 'ch-03-demo-panels',
    app: 'demo-crm',
    title: 'Demo: three panels in turn; the first taken back (untouched since: a mechanical revert)',
    steps: [
      step('Show the city in the customer card.', { checks: checks('crm-01-card-fields', [1]) }, [CITY]),
      step('Add a total row to the deals table.', { checks: checks('crm-04-deals-total-row', [0]) }, null),
      step('Show the average deal size on the dashboard.', { checks: checks('crm-13-ru-dashboard-average') }, null),
    ],
    revert: { step: 1, anyMustNotMatch: [CITY], browser: { checks: [{ testid: 'city', within: 'customer-card', count: 0 }] } },
  },
  {
    id: 'ch-04-shadcn-users',
    app: 'shadcn-admin',
    title: 'shadcn-admin users: coloured roles, clickable e-mails, bold headers; the e-mails taken back',
    steps: [
      step('Show the role of each user in colour: admins purple, managers amber, cashiers grey.', { checks: checks('sa-03-users-role-colors') }, ['purple|violet|fuchsia']),
      step('Make the email addresses in the users table clickable so I can write to the user.', { checks: checks('sa-12-users-email-links') }, ['mailto:']),
      step('Make the column headers of the users table bold.', { checks: checks('sa-18-ru-bold-headers') }, ['font-(bold|semibold)']),
    ],
    revert: { step: 2, anyMustNotMatch: ['mailto:'], browser: { checks: [{ panel: 'users-table', selector: 'tbody a[href^="mailto:"]', count: 0 }] } },
  },
  {
    id: 'ch-05-shadcn-tasks',
    app: 'shadcn-admin',
    title: 'shadcn-admin tasks: high priority red, 20 per page, an assignee column; the red taken back (same file later)',
    steps: [
      step('Make the high priority tasks stand out in red.', { checks: checks('sa-06-tasks-high-priority-red') }, ['red|destructive|rose']),
      step('Show 20 tasks per page instead of 10.', { checks: checks('sa-07-tasks-twenty-rows') }, ['20']),
      step('Add an assignee column to the tasks table.', { checks: checks('sa-05-tasks-assignee-column') }, ['[Aa]ssignee']),
    ],
    revert: { step: 1, anyMustNotMatch: ["priority === 'high'[^\\n]*(red|destructive|rose)|(red|destructive|rose)[^\\n]*priority === 'high'"], browser: { checks: [] } },
  },
]

for (const c of chains) fs.writeFileSync(path.join(here, `${c.id}.json`), JSON.stringify(c, null, 2) + '\n')
console.log(`wrote ${chains.length} chains to evals/chains`)
