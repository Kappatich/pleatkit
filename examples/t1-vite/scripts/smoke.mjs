#!/usr/bin/env node
// Follows docs/for-agents/verify.md without a human: starts store-server (in memory), the agent server (scripted
// provider with the recorded answer in fixtures/agent) and `vite preview`, runs `pleatkit ping`, then with
// --browser drives the chat headless: ask for overdue orders in red, wait for "Applied", check the row, reload and
// check it again (the version comes back from store-server). Stops the three servers (and only them). Run after
// `pnpm build`. Ports: agent 8789, store 8790, preview 4173.
import { spawn, spawnSync } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'
import { createRequire } from 'node:module'

const shell = process.platform === 'win32'
const started = []

function start(cmd, args, env = {}) {
  const child = spawn(cmd, args, { shell, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] })
  child.stdout.on('data', (d) => process.stdout.write(`[${args[0]}] ${d}`))
  child.stderr.on('data', (d) => process.stderr.write(`[${args[0]}] ${d}`))
  started.push(child)
  return child
}

function stopAll() {
  for (const child of started) {
    if (child.exitCode !== null) continue
    // shell: true spawns a cmd.exe on Windows; kill its whole tree, nothing else
    if (shell) spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
    else child.kill('SIGTERM')
  }
}

async function waitFor(url, ms = 30_000) {
  const until = Date.now() + ms
  while (Date.now() < until) {
    try {
      if ((await fetch(url)).ok) return
    } catch {
      // not up yet
    }
    await sleep(300)
  }
  throw new Error(`${url} did not come up in ${ms / 1000} s`)
}

/** The chat, headless: one request, the recorded answer, a commit in the browser. Playwright from the pleatkit checkout. */
async function browserCheck() {
  const require = createRequire(new URL('../../../apps/demo-crm/package.json', import.meta.url))
  const { chromium } = require('@playwright/test')
  const browser = await chromium.launch({ headless: true })
  try {
    const page = await browser.newPage()
    const errors = []
    page.on('pageerror', (e) => errors.push(e.message))
    await page.goto('http://localhost:4173/')
    await page.getByTestId('orders-table').waitFor()
    await page.getByTestId('mk-chat-open').click()
    await page.getByTestId('mk-chat-input').fill('Show the status and make overdue orders red')
    await page.getByTestId('mk-chat-send').click()
    const turn = page.getByTestId('mk-chat-turn').first()
    // the chat renders in a shadow root: Playwright locators pierce it, document.querySelector would not
    let status = await turn.getAttribute('data-status', { timeout: 30_000 })
    for (const until = Date.now() + 30_000; status === 'running' && Date.now() < until; status = await turn.getAttribute('data-status')) await sleep(100)
    const colorOf = () => page.locator('tr[data-status="overdue"]').evaluate((el) => getComputedStyle(el).color).catch(() => null)
    const color = await colorOf()
    // the row's text color comes from text-red-700, compiled with the edit
    const ok = status === 'applied' && color !== null && color !== 'rgb(0, 0, 0)' && errors.length === 0
    console.log(`[${ok ? 'ok' : 'FAIL'}]   chat edit in the browser: ${status}; overdue row color ${color}${errors.length ? `; page errors: ${errors.join('; ')}` : ''}`)
    if (!ok) return 1
    // HttpStore: the version is in store-server, so a fresh load shows it again
    await page.reload()
    await page.getByTestId('orders-table').waitFor()
    let again = await colorOf()
    for (const until = Date.now() + 10_000; again !== color && Date.now() < until; again = await colorOf()) await sleep(100)
    const kept = again === color && errors.length === 0
    console.log(`[${kept ? 'ok' : 'FAIL'}]   after a reload the edit comes back from store-server: overdue row color ${again}`)
    return kept ? 0 : 1
  } finally {
    await browser.close()
  }
}

let code = 1
try {
  start('pnpm', ['exec', 'pleatkit-store'], { PLEATKIT_STORE_DB: ':memory:', PLEATKIT_STORE_PORT: '8790' })
  start('pnpm', ['exec', 'pleatkit-agent'], { PLEATKIT_FIXTURES: 'fixtures/agent', PLEATKIT_STORE_URL: 'http://localhost:8790' })
  start('pnpm', ['exec', 'vite', 'preview', '--port', '4173', '--strictPort'])
  await waitFor('http://localhost:8790/health')
  await waitFor('http://localhost:8789/agent/health')
  await waitFor('http://localhost:4173/')
  code = spawnSync('pnpm', ['exec', 'pleatkit', 'ping', '--url', 'http://localhost:4173'], { shell, stdio: 'inherit' }).status ?? 1
  if (code === 0 && process.argv.includes('--browser')) code = await browserCheck()
} catch (e) {
  console.error(e.message)
} finally {
  stopAll()
}
process.exit(code)
