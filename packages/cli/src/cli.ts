#!/usr/bin/env node
import path from 'node:path'
import { doctor, formatFindings } from './doctor.js'
import { ping } from './ping.js'

const HELP = `Usage:
  morphkit doctor [--root <dir>] [--dist <dir>] [--json]
  morphkit ping [--url http://localhost:5173]

doctor checks the morphkit setup of a Vite + React app and prints what to fix:
  config     the morphkit plugin in vite.config and its zones
  react      React 19, and a single copy shared with @morphkit/runtime
  panels     every <Dynamic id="x"> has src/dynamic/x.tsx with a default export
  externals  every module the dynamic code may import resolves
  csp        a Content-Security-Policy, if any, allows blob: modules and WebAssembly
  secrets    no API key in the built client bundle or in VITE_ variables

ping checks the running app end to end: the manifest it serves, the agent behind its /agent proxy, and
one agent run over SSE (the agent is asked to change nothing).

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
  const findings = await doctor({ root, ...(dist ? { dist } : {}) })
  if (rest.includes('--json')) console.log(JSON.stringify({ root, findings }, null, 2))
  else console.log(formatFindings(findings, root))
  return findings.some((f) => f.status === 'fail') ? 1 : 0
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (e: Error) => {
    console.error(`morphkit: ${e.stack ?? e.message}`)
    process.exit(2)
  },
)
