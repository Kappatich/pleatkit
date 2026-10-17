#!/usr/bin/env node
// Renders site/index.html and site/ru.html headless (Chromium via the demo's Playwright), fails on console errors or failed
// requests, and writes screenshots to docs/screenshots/site-*.png (desktop light and dark, mobile; Russian page).
// Serves site/ on a free local port for the duration of the run; nothing is shown on screen.
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const site = path.join(root, 'site')
const shots = path.join(root, 'docs', 'screenshots')
const require = createRequire(path.join(root, 'apps', 'demo-crm', 'package.json'))
const { chromium } = require('@playwright/test')

const TYPES = { '.html': 'text/html; charset=utf-8', '.mp4': 'video/mp4', '.jpg': 'image/jpeg', '.png': 'image/png', '.css': 'text/css', '.js': 'text/javascript' }

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://x')
  const file = path.join(site, decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname))
  if (!file.startsWith(site) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404).end('not found')
    return
  }
  const data = fs.readFileSync(file)
  const range = req.headers.range && /bytes=(\d+)-(\d*)/.exec(req.headers.range)
  const type = TYPES[path.extname(file)] ?? 'application/octet-stream'
  if (range) {
    const start = Number(range[1])
    const end = range[2] ? Number(range[2]) : data.length - 1
    res.writeHead(206, { 'content-type': type, 'content-range': `bytes ${start}-${end}/${data.length}`, 'accept-ranges': 'bytes', 'content-length': end - start + 1 })
    res.end(data.subarray(start, end + 1))
    return
  }
  res.writeHead(200, { 'content-type': type, 'content-length': data.length, 'accept-ranges': 'bytes' })
  res.end(data)
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const base = `http://127.0.0.1:${server.address().port}/`

const browser = await chromium.launch({ headless: true })
const problems = []
const views = [
  { name: 'site-desktop-light.png', viewport: { width: 1280, height: 800 }, colorScheme: 'light' },
  { name: 'site-desktop-dark.png', viewport: { width: 1280, height: 800 }, colorScheme: 'dark' },
  { name: 'site-mobile.png', viewport: { width: 390, height: 844 }, colorScheme: 'light', isMobile: true },
  { name: 'site-ru-desktop.png', page: 'ru.html', viewport: { width: 1280, height: 800 }, colorScheme: 'light' },
  { name: 'site-ru-mobile-dark.png', page: 'ru.html', viewport: { width: 390, height: 844 }, colorScheme: 'dark', isMobile: true },
]
try {
  for (const v of views) {
    const context = await browser.newContext({ viewport: v.viewport, colorScheme: v.colorScheme, isMobile: v.isMobile ?? false, deviceScaleFactor: 1 })
    const page = await context.newPage()
    page.on('console', (m) => m.type() === 'error' && problems.push(`${v.name}: console error: ${m.text()}`))
    page.on('pageerror', (e) => problems.push(`${v.name}: page error: ${e.message}`))
    // media requests are aborted by the browser once it has the metadata it wanted (preload=metadata)
    page.on('requestfailed', (r) => !(r.url().endsWith('.mp4') && r.failure()?.errorText === 'net::ERR_ABORTED') && problems.push(`${v.name}: request failed: ${r.url()} ${r.failure()?.errorText}`))
    page.on('response', (r) => r.status() >= 400 && problems.push(`${v.name}: HTTP ${r.status()} ${r.url()}`))
    await page.goto(base + (v.page ?? ''), { waitUntil: 'networkidle' })
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
    if (overflow > 0) problems.push(`${v.name}: horizontal overflow of ${overflow}px`)
    await page.screenshot({ path: path.join(shots, v.name), fullPage: true })
    // the video element must be able to load the file
    const video = await page.evaluate(async () => {
      const el = document.querySelector('video')
      if (!el) return { ok: false, why: 'no <video>' }
      el.preload = 'metadata'
      el.load()
      if (el.readyState < 1) await new Promise((r) => el.addEventListener('loadedmetadata', r, { once: true }))
      return { ok: el.duration > 0, duration: el.duration, width: el.videoWidth, height: el.videoHeight }
    })
    if (!video.ok) problems.push(`${v.name}: video did not load (${JSON.stringify(video)})`)
    console.log(`${v.name}: video ${video.width}x${video.height}, ${video.duration?.toFixed(1)} s`)
    await context.close()
  }
} finally {
  await browser.close()
  server.close()
}
if (problems.length) {
  console.error(problems.join('\n'))
  process.exit(1)
}
console.log('site renders without console errors')
