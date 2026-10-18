#!/usr/bin/env node
// Runs a command with the variables from the repository's .env (never committed; see .gitignore).
// Values already set in the environment win. Usage: node scripts/with-env.mjs <command> [args...]
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const file = path.join(root, '.env')
const env = { ...process.env }
if (fs.existsSync(file)) {
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq < 0) continue
    const key = line.slice(0, eq).trim()
    let value = line.slice(eq + 1).trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1)
    if (!(key in process.env) && value) env[key] = value
  }
}
// every Node child honours the proxy variables (see env-proxy.mjs)
const preload = `--import=${pathToFileURL(path.join(root, 'scripts', 'env-proxy.mjs')).href}`
env.NODE_OPTIONS = [env.NODE_OPTIONS, preload].filter(Boolean).join(' ')
const [cmd, ...args] = process.argv.slice(2)
if (!cmd) { console.error('usage: node scripts/with-env.mjs <command> [args...]'); process.exit(2) }
const child = spawn(cmd, args, { stdio: 'inherit', env, shell: process.platform === 'win32' })
child.on('exit', (code) => process.exit(code ?? 1))
