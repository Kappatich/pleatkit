#!/usr/bin/env node
import path from 'node:path'
import { doctor, formatFindings } from './doctor.js'
import { ping } from './ping.js'
import { keys } from './keys.js'
import { exportData } from './export.js'
import { checkSnapshotsCommand } from './check-snapshots.js'
import { carryOverCommand, digestCommand } from './ops.js'
import { eraseCommand } from './erase.js'
import { labelsExport } from './labels.js'
import { bugReport } from './report.js'
import { formatPlan, parsePanels, suggest, writePlan } from './suggest.js'
import fs from 'node:fs'
import { track } from '@pleatkit/vite-plugin'

const VERSION = '0.3.0'
/** F8: one anonymous event per command (PLEATKIT_TELEMETRY=0 turns it off; README "Telemetry"). */
const event = (name: string, props: Record<string, string | number | boolean> = {}) => track(name, props, { source: { package: '@pleatkit/cli', version: VERSION } })

const HELP = `Usage:
  pleatkit init --suggest [--root <dir>] [--panels <file>[:<id>][,<file>[:<id>]…]] [--json] [--write]
  pleatkit doctor [--root <dir>] [--dist <dir>] [--url <app url>] [--json]
  pleatkit ping [--url http://localhost:5173]
  pleatkit keys new | public
  pleatkit export --store <url> --app <id> [--user <id>] [--out <file>]
  pleatkit check-snapshots --store <url> --app <id> [--manifest <file>] [--typecheck] [--root <dir>]
  pleatkit report [--root <dir>] [--dist <dir>] [--url <app url>] [--out <file>]
  pleatkit digest --week --store <url> --app <id> [--out <file>] [--send] [--no-wishes] [--manifest <file>]
                  [--wishes-max-items <n>] [--wishes-budget-usd <n>]
  pleatkit carry-over --release <hash> --budget-usd <n> --store <url> --app <id> [--manifest <file>]
                      [--per-user-usd <n>] [--dry-run] [--retry] [--typecheck] [--rollback]
  pleatkit erase --user <id> --app <id> --store <url> [--confirm <token>]
  pleatkit erase --app <id> --store <url> [--confirm <token>]
  pleatkit labels export --store <url> --app <id> [--eval-app <id>] [--out <file>] [--all]

init --suggest reads the app's import graph (it never runs the app) and proposes the zones: the panels (with
--panels, the files you name; otherwise a heuristic ranks the components the pages render), the helper files that
move with each panel, the props each <Dynamic> needs (router hooks of the panel become props), the readonly
re-export modules with exactly the symbols the panels use, the externals in the form the plugin expects, the css
mode, the plugin block for vite.config and the manifest it would produce. --json prints the plan as JSON;
--write creates the readonly re-export modules (new files only) and lists what it left to do.

doctor checks the pleatkit setup of a Vite + React app and prints what to fix:
  config     the pleatkit plugin in vite.config and its zones
  react      React 18 or 19, and a single copy shared with @pleatkit/runtime
  panels     every <Dynamic id="x"> has src/dynamic/x.tsx with a default export
  externals  every module the dynamic code may import resolves
  csp        a Content-Security-Policy, if any, allows what the compile mode needs
  secrets    no API key in the built client bundle or in VITE_ variables
  secure-context  https or localhost (WebCrypto); plain http works but is slower and cannot verify signed edits

ping checks the running app end to end: the manifest it serves, the agent behind its /agent proxy, and
one agent run over SSE (the agent is asked to change nothing).

keys new prints a fresh app key (mk_live_…, server to server), a user-JWT secret and the public key the app's
build needs to verify signed bundles; keys public prints the public key of PLEATKIT_APP_KEY. Keep the first
two in your server's secret store, never in the repository or the browser.

export writes everything store-server keeps for an app (or one user of it: --user) to a JSON file: snapshots
with their files, heads, the request log, usage events, and for an app also the audit chain, flags, settings
and plan. Authenticates with PLEATKIT_APP_KEY (or --key); without it, the development admin header.

check-snapshots carries every user's current version over to a new build and compiles it (with --typecheck,
type-checks it too): the users whose version would be marked stale, before the release goes out.

report writes pleatkit-report.md for a bug report: doctor's findings, versions, the Vite config and the pleatkit
environment with keys, tokens and secrets redacted, and a summary of the build manifest. Read it, then attach it.

digest --week prints the weekly digest as markdown: requests and outcomes, cost, carry-overs, what waits on the
admin, the audit chain, and the wish map (one classifier call over the week's requests the panels could not
serve; the model provider comes from PLEATKIT_PROVIDER / PLEATKIT_API_KEY like the agent's). --send sends it
through PLEATKIT_ALERT_WEBHOOK and/or PLEATKIT_ALERT_EMAIL_URL + _TO. The wish map reads at most 500 requests
and spends at most $0.50 (--wishes-max-items, --wishes-budget-usd, or PLEATKIT_WISHES_MAX_ITEMS / _BUDGET_USD).

carry-over carries every user's edits to a new release: by itself where the release did not touch the files the
user changed, with the agent where it did, never past --budget-usd. The store keeps the progress: run it again
(with a higher budget) to continue. --release is the build's release hash (or 8+ characters of it; the command
prints it when it does not match). --rollback puts every user back on the version before the run. One user's
migration may cost at most the perEditUsd of the app's plan; --per-user-usd overrides it.

erase deletes everything store-server keeps about one user (--user) or the whole app (no --user): snapshots,
heads, requests, usage events, bundles, run records, flags, carry-over rows, the cloud's facts. The first run
prints what would go and a confirm token; run it again with --confirm <token> to erase. An audit tombstone
without personal data stays. Admin only (PLEATKIT_APP_KEY, or --key).

labels export writes the requests people labelled on the /admin Labels screen where they disagreed with the
classifier (--all: every label) as probes for \`pnpm eval:classify -- --probes <file>\`, by default to
evals/probes/human-disagreements.json. Each probe runs against an eval app (demo-crm, shadcn-admin, tailadmin):
the store's app id when it is one of them, otherwise name it with --eval-app. Authenticates like export.

Exit code 1 when a check fails.`

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv
  if (!command || command === '--help' || command === '-h' || command === 'help') {
    console.log(HELP)
    return command ? 0 : 1
  }
  if (command === 'init') {
    const i = rest.indexOf('--panels')
    if (!rest.includes('--suggest') || (i >= 0 && !rest[i + 1])) {
      console.error('Usage: pleatkit init --suggest [--root <dir>] [--panels <file>[:<id>][,…]] [--json] [--write]')
      return 1
    }
    const r = rest.indexOf('--root')
    const root = path.resolve(r >= 0 ? rest[r + 1]! : process.cwd())
    const plan = suggest({ root, ...(i >= 0 ? { panels: parsePanels(rest[i + 1]!) } : {}) })
    if (rest.includes('--json')) console.log(JSON.stringify(plan, null, 2))
    else console.log(formatPlan(plan))
    if (rest.includes('--write')) {
      const w = writePlan(plan)
      const log = rest.includes('--json') ? console.error : console.log
      log(['', '--write:', ...w.created.map((c) => `  created ${c}`), ...w.skipped.map((c) => `  skipped ${c}`), 'Not done (edits of existing files are yours to make):', ...w.notDone.map((n) => `  - ${n}`)].join('\n'))
    }
    await event('init.suggest', { panels: plan.panels.length, mode: plan.mode, write: rest.includes('--write') })
    return 0
  }
  if (command === 'ping') {
    const i = rest.indexOf('--url')
    const r = await ping(i >= 0 ? rest[i + 1]! : 'http://localhost:5173')
    console.log(r.lines.join('\n'))
    await event(r.ok ? 'ping.ok' : 'ping.fail')
    return r.ok ? 0 : 1
  }
  if (command === 'keys') {
    const r = await keys(rest[0], process.env)
    console.log(r.lines.join('\n'))
    if (r.ok) await event(`keys.${rest[0]}`)
    return r.ok ? 0 : 1
  }
  if (command === 'export') {
    const arg = (name: string) => {
      const i = rest.indexOf(name)
      return i >= 0 ? rest[i + 1] : undefined
    }
    const store = arg('--store') ?? process.env.PLEATKIT_STORE_URL
    const app = arg('--app') ?? process.env.PLEATKIT_APP_ID
    if (!store || !app) {
      console.error('Usage: pleatkit export --store <url> --app <id> [--user <id>] [--out <file>]')
      return 1
    }
    const user = arg('--user')
    const key = arg('--key') ?? process.env.PLEATKIT_APP_KEY
    const out = arg('--out')
    const r = await exportData({ store, app, ...(user ? { user } : {}), ...(key ? { key } : {}), ...(out ? { out } : {}) })
    console.log(r.lines.join('\n'))
    if (r.ok) await event('export.run', { scope: user ? 'user' : 'app' })
    return r.ok ? 0 : 1
  }
  if (command === 'check-snapshots') {
    const arg = (name: string) => {
      const i = rest.indexOf(name)
      return i >= 0 ? rest[i + 1] : undefined
    }
    const store = arg('--store') ?? process.env.PLEATKIT_STORE_URL
    const app = arg('--app') ?? process.env.PLEATKIT_APP_ID
    const manifest = arg('--manifest') ?? 'dist/pleatkit.manifest.json'
    if (!store || !app) {
      console.error('Usage: pleatkit check-snapshots --store <url> --app <id> [--manifest dist/pleatkit.manifest.json] [--typecheck] [--root <app dir>]')
      return 1
    }
    const key = arg('--key') ?? process.env.PLEATKIT_APP_KEY
    const root = arg('--root')
    const r = await checkSnapshotsCommand({ store, app, manifest, ...(key ? { key } : {}), ...(root ? { root } : {}), typecheck: rest.includes('--typecheck') })
    console.log(r.lines.join('\n'))
    return r.ok ? 0 : 1
  }
  const opt = (name: string) => {
    const i = rest.indexOf(name)
    return i >= 0 ? rest[i + 1] : undefined
  }
  if (command === 'report') {
    const out = path.resolve(opt('--out') ?? 'pleatkit-report.md')
    const dist = opt('--dist')
    const url = opt('--url')
    const r = await bugReport({ root: path.resolve(opt('--root') ?? process.cwd()), ...(dist ? { dist } : {}), ...(url ? { url } : {}), cliVersion: VERSION })
    fs.writeFileSync(out, r.markdown)
    console.log(`wrote ${out}: ${r.findings.filter((f) => f.status === 'fail').length} failed checks. Read it, then attach it to the issue.`)
    await event('report.run')
    return 0
  }
  if (command === 'digest' || command === 'carry-over') {
    const store = opt('--store') ?? process.env.PLEATKIT_STORE_URL
    const app = opt('--app') ?? process.env.PLEATKIT_APP_ID
    const key = opt('--key') ?? process.env.PLEATKIT_APP_KEY
    if (!store || !app) {
      console.error(`Usage: see pleatkit --help (${command} needs --store and --app, or PLEATKIT_STORE_URL and PLEATKIT_APP_ID)`)
      return 1
    }
    if (command === 'digest') {
      const out = opt('--out')
      const days = rest.includes('--week') || !opt('--days') ? 7 : Number(opt('--days'))
      const wishMax = opt('--wishes-max-items')
      const wishBudget = opt('--wishes-budget-usd')
      const r = await digestCommand({
        store,
        app,
        ...(key ? { key } : {}),
        days,
        ...(out ? { out } : {}),
        send: rest.includes('--send'),
        noWishes: rest.includes('--no-wishes'),
        manifest: opt('--manifest') ?? 'dist/pleatkit.manifest.json',
        ...(wishMax !== undefined ? { wishMaxItems: Number(wishMax) } : {}),
        ...(wishBudget !== undefined ? { wishBudgetUsd: Number(wishBudget) } : {}),
      })
      console.log(r.lines.join('\n'))
      if (r.ok) await event('digest.run', { sent: rest.includes('--send') })
      return r.ok ? 0 : 1
    }
    const release = opt('--release')
    const budget = Number(opt('--budget-usd'))
    const rollback = rest.includes('--rollback')
    if (!release || (!rollback && !(budget >= 0 && opt('--budget-usd') !== undefined))) {
      console.error('Usage: pleatkit carry-over --release <hash> --budget-usd <dollars> --store <url> --app <id> [--manifest dist/pleatkit.manifest.json]')
      return 1
    }
    const perUser = opt('--per-user-usd')
    const root = opt('--root')
    const r = await carryOverCommand({
      store,
      app,
      ...(key ? { key } : {}),
      release,
      budgetUsd: rollback ? 0 : budget,
      manifest: opt('--manifest') ?? 'dist/pleatkit.manifest.json',
      ...(perUser ? { perUserUsd: Number(perUser) } : {}),
      dryRun: rest.includes('--dry-run'),
      retry: rest.includes('--retry'),
      rollback,
      typecheck: rest.includes('--typecheck'),
      ...(root ? { root } : {}),
    })
    console.log(r.lines.join('\n'))
    if (r.ok) await event(rollback ? 'carry-over.rollback' : 'carry-over.run')
    return r.ok ? 0 : 1
  }
  if (command === 'erase') {
    const store = opt('--store') ?? process.env.PLEATKIT_STORE_URL
    const user = opt('--user')
    const app = opt('--app') ?? (user ? process.env.PLEATKIT_APP_ID : undefined)
    if (!store || !app) {
      console.error('Usage: pleatkit erase --user <id> --app <id> --store <url> [--confirm <token>]  |  pleatkit erase --app <id> --store <url> [--confirm <token>]')
      return 1
    }
    const key = opt('--key') ?? process.env.PLEATKIT_APP_KEY
    const confirm = opt('--confirm')
    const r = await eraseCommand({ store, app, ...(user ? { user } : {}), ...(key ? { key } : {}), ...(confirm ? { confirm } : {}) })
    console.log(r.lines.join('\n'))
    if (r.ok && r.erased) await event('erase.run', { scope: user ? 'user' : 'app' })
    return r.ok ? 0 : 1
  }
  if (command === 'labels') {
    const store = opt('--store') ?? process.env.PLEATKIT_STORE_URL
    const app = opt('--app') ?? process.env.PLEATKIT_APP_ID
    if (rest[0] !== 'export' || !store || !app) {
      console.error('Usage: pleatkit labels export --store <url> --app <id> [--eval-app <id>] [--out evals/probes/human-disagreements.json] [--all]')
      return 1
    }
    const key = opt('--key') ?? process.env.PLEATKIT_APP_KEY
    const evalApp = opt('--eval-app')
    const out = opt('--out')
    const r = await labelsExport({ store, app, all: rest.includes('--all'), ...(evalApp ? { evalApp } : {}), ...(key ? { key } : {}), ...(out ? { out } : {}) })
    console[r.ok ? 'log' : 'error'](r.lines.join('\n'))
    if (r.ok) await event('labels.export', { all: rest.includes('--all'), probes: r.probes?.length ?? 0 })
    return r.ok ? 0 : 1
  }
  if (command !== 'doctor') {
    console.error(`Unknown command "${command}".\n\n${HELP}`)
    return 1
  }
  const flag = (name: string) => {
    const i = rest.indexOf(name)
    return i >= 0 ? rest[i + 1] : undefined
  }
  const root = path.resolve(flag('--root') ?? process.cwd())
  const dist = flag('--dist')
  const url = flag('--url')
  const findings = await doctor({ root, ...(dist ? { dist } : {}), ...(url ? { url } : {}) })
  if (rest.includes('--json')) console.log(JSON.stringify({ root, findings }, null, 2))
  else console.log(formatFindings(findings, root))
  const failed = findings.filter((f) => f.status === 'fail')
  await event('doctor.run', { fails: failed.length })
  for (const f of failed) await event(`doctor.fail:${f.id}`)
  return findings.some((f) => f.status === 'fail') ? 1 : 0
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (e: Error) => {
    console.error(`pleatkit: ${e.stack ?? e.message}`)
    process.exit(2)
  },
)
