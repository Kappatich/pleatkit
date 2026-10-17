#!/usr/bin/env node
import path from 'node:path'
import { doctor, formatFindings } from './doctor.js'
import { ping } from './ping.js'
import { keys } from './keys.js'
import { exportData } from './export.js'
import { checkSnapshotsCommand } from './check-snapshots.js'
import { track } from '@morphkit/vite-plugin'

const VERSION = '0.1.0'
/** F8: one anonymous event per command (MORPHKIT_TELEMETRY=0 turns it off; README "Telemetry"). */
const event = (name: string, props: Record<string, string | number | boolean> = {}) => track(name, props, { source: { package: '@morphkit/cli', version: VERSION } })

const HELP = `Usage:
  morphkit doctor [--root <dir>] [--dist <dir>] [--url <app url>] [--json]
  morphkit ping [--url http://localhost:5173]
  morphkit keys new | public
  morphkit export --store <url> --app <id> [--user <id>] [--out <file>]
  morphkit check-snapshots --store <url> --app <id> [--manifest <file>] [--typecheck] [--root <dir>]

doctor checks the morphkit setup of a Vite + React app and prints what to fix:
  config     the morphkit plugin in vite.config and its zones
  react      React 18 or 19, and a single copy shared with @morphkit/runtime
  panels     every <Dynamic id="x"> has src/dynamic/x.tsx with a default export
  externals  every module the dynamic code may import resolves
  csp        a Content-Security-Policy, if any, allows what the compile mode needs
  secrets    no API key in the built client bundle or in VITE_ variables
  secure-context  https or localhost (WebCrypto); plain http works but is slower and cannot verify signed edits

ping checks the running app end to end: the manifest it serves, the agent behind its /agent proxy, and
one agent run over SSE (the agent is asked to change nothing).

keys new prints a fresh app key (mk_live_…, server to server), a user-JWT secret and the public key the app's
build needs to verify signed bundles; keys public prints the public key of MORPHKIT_APP_KEY. Keep the first
two in your server's secret store, never in the repository or the browser.

export writes everything store-server keeps for an app (or one user of it: --user) to a JSON file: snapshots
with their files, heads, the request log, usage events, and for an app also the audit chain, flags, settings
and plan. Authenticates with MORPHKIT_APP_KEY (or --key); without it, the development admin header.

Exit code 1 when a check fails.`

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv
  if (!command || command === '--help' || command === '-h' || command === 'help') {
    console.log(HELP)
    return command ? 0 : 1
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
    const store = arg('--store') ?? process.env.MORPHKIT_STORE_URL
    const app = arg('--app') ?? process.env.MORPHKIT_APP_ID
    if (!store || !app) {
      console.error('Usage: morphkit export --store <url> --app <id> [--user <id>] [--out <file>]')
      return 1
    }
    const user = arg('--user')
    const key = arg('--key') ?? process.env.MORPHKIT_APP_KEY
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
    const store = arg('--store') ?? process.env.MORPHKIT_STORE_URL
    const app = arg('--app') ?? process.env.MORPHKIT_APP_ID
    const manifest = arg('--manifest') ?? 'dist/morphkit.manifest.json'
    if (!store || !app) {
      console.error('Usage: morphkit check-snapshots --store <url> --app <id> [--manifest dist/morphkit.manifest.json] [--typecheck] [--root <app dir>]')
      return 1
    }
    const key = arg('--key') ?? process.env.MORPHKIT_APP_KEY
    const root = arg('--root')
    const r = await checkSnapshotsCommand({ store, app, manifest, ...(key ? { key } : {}), ...(root ? { root } : {}), typecheck: rest.includes('--typecheck') })
    console.log(r.lines.join('\n'))
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
    console.error(`morphkit: ${e.stack ?? e.message}`)
    process.exit(2)
  },
)
