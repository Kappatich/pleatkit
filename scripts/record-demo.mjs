#!/usr/bin/env node
// Records the 60-second demo headless and converts it to docs/demo.mp4 (H.264, 1280x800).
// Also refreshes site/demo.mp4 and site/poster.jpg.
// 1. builds the demo, 2. runs e2e/demo-video.spec.ts with PLEATKIT_VIDEO=1 (Playwright recordVideo, scripted
// provider paced for reading), 3. ffmpeg webm -> mp4, 4. prints ffprobe's duration and size.
// Nothing is opened or played on screen. Requires ffmpeg and ffprobe on PATH.
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const app = path.join(root, 'apps', 'demo-crm')
const webm = path.join(root, 'docs', '.video', 'demo.webm')
const mp4 = path.join(root, 'docs', 'demo.mp4')
const shell = process.platform === 'win32'

function run(cmd, args, options = {}) {
  console.log(`> ${cmd} ${args.join(' ')}`)
  const r = spawnSync(cmd, args, { stdio: 'inherit', shell, ...options })
  if (r.status !== 0) {
    console.error(`${cmd} failed with exit code ${r.status}`)
    process.exit(r.status ?? 1)
  }
}

if (!process.argv.includes('--skip-record')) {
  run('pnpm', ['exec', 'vite', 'build'], { cwd: app })
  run('pnpm', ['exec', 'playwright', 'test', 'demo-video'], { cwd: app, env: { ...process.env, PLEATKIT_VIDEO: '1' } })
}
if (!fs.existsSync(webm)) {
  console.error(`no recording at ${webm}`)
  process.exit(1)
}

// yuv420p + faststart: plays in every browser's <video> and starts before it is fully downloaded.
run('ffmpeg', ['-y', '-loglevel', 'error', '-i', webm, '-c:v', 'libx264', '-preset', 'slow', '-crf', '24', '-pix_fmt', 'yuv420p', '-r', '30', '-movflags', '+faststart', '-an', mp4])

const probe = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration,size:stream=codec_name,width,height', '-of', 'json', mp4], { encoding: 'utf8', shell })
const info = JSON.parse(probe.stdout)
const duration = Number(info.format.duration)
const sizeMb = Number(info.format.size) / 1024 / 1024
const stream = info.streams[0]
console.log(`docs/demo.mp4: ${stream.codec_name} ${stream.width}x${stream.height}, ${duration.toFixed(1)} s, ${sizeMb.toFixed(2)} MB`)
if (duration > 60 || sizeMb > 15) {
  console.error('the demo must be at most 60 s and 15 MB')
  process.exit(1)
}

// the landing page serves its own copy (it is deployed without docs/), plus a poster frame
fs.copyFileSync(mp4, path.join(root, 'site', 'demo.mp4'))
run('ffmpeg', ['-y', '-loglevel', 'error', '-ss', '13', '-i', mp4, '-frames:v', '1', '-q:v', '4', path.join(root, 'site', 'poster.jpg')])
console.log('copied to site/demo.mp4 and site/poster.jpg')
