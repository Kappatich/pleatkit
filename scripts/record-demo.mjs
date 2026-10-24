#!/usr/bin/env node
// Records the demo film headless (about 75 s, at most 90 s and 20 MB) and writes docs/demo.mp4 (H.264 1280x800 +
// AAC mono), site/demo.mp4 (the same file) and site/poster.jpg.
// 1. builds the demo, 2. runs e2e/demo-video.spec.ts with PLEATKIT_VIDEO=1 (Playwright recordVideo, scripted
//    provider paced for reading); the spec also writes docs/.video/events.json: the start/end marks and every
//    sound event (key, click, drawer, applied, band, close) in ms since the page was created,
// 3. ffmpeg trims the webm to the start/end marks and encodes it,
// 4. synthesizes the sound track here (no samples, no downloads: filtered noise and sines written as a WAV),
//    places each event sample-accurately and mixes them in Node (a few hundred key ticks would make an ffmpeg
//    adelay/amix graph of hundreds of inputs), then muxes it into the mp4 with ffmpeg (-c:v copy -c:a aac),
// 5. prints ffprobe's duration and size and refuses a film over 90 s or 20 MB.
// `--skip-record` reuses docs/.video (demo.webm + events.json), e.g. to retune the sound.
// VIDEO_LEAD_MS: Playwright's video shows a moment about 70 ms before the wall clock says it happened (measured
// by extracting the frames around the first click's ripple and comparing them with the click's logged time), so
// the picture is cut that much earlier and every sound lands on its frame.
// Nothing is opened or played on screen. Requires ffmpeg and ffprobe on PATH.
import { Buffer } from 'node:buffer'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const app = path.join(root, 'apps', 'demo-crm')
const work = path.join(root, 'docs', '.video')
const webm = path.join(work, 'demo.webm')
const eventsFile = path.join(work, 'events.json')
const mp4 = path.join(root, 'docs', 'demo.mp4')
const shell = process.platform === 'win32'
const MAX_SECONDS = 90
const MAX_MB = 20
const VIDEO_LEAD_MS = 70

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
for (const f of [webm, eventsFile]) {
  if (!fs.existsSync(f)) {
    console.error(`no recording at ${f}`)
    process.exit(1)
  }
}

const timeline = JSON.parse(fs.readFileSync(eventsFile, 'utf8'))
const start = Math.max(0, timeline.start - VIDEO_LEAD_MS) / 1000
const duration = (timeline.end - timeline.start) / 1000

// picture: trimmed to the marks; yuv420p + faststart plays in every browser's <video> and streams
const picture = path.join(work, 'picture.mp4')
run('ffmpeg', ['-y', '-loglevel', 'error', '-ss', start.toFixed(3), '-i', webm, '-t', duration.toFixed(3), '-c:v', 'libx264', '-preset', 'slow', '-crf', '20', '-pix_fmt', 'yuv420p', '-r', '30', '-an', picture])

// ---- sound -------------------------------------------------------------------------------------------------
const SR = 48000
const db = (d) => Math.pow(10, d / 20)
let seed = 0x5eed
const rand = () => {
  seed = (seed + 0x6d2b79f5) | 0
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}
const noise = () => rand() * 2 - 1

/** RBJ band-pass, cutoff may change every sample (sweeps). */
function bandpass(input, freqAt, q) {
  const out = new Float32Array(input.length)
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0
  for (let i = 0; i < input.length; i++) {
    const w0 = (2 * Math.PI * freqAt(i / SR)) / SR
    const alpha = Math.sin(w0) / (2 * q)
    const a0 = 1 + alpha
    const y = (alpha * input[i] - alpha * x2 + 2 * Math.cos(w0) * y1 - (1 - alpha) * y2) / a0
    out[i] = y
    x2 = x1; x1 = input[i]; y2 = y1; y1 = y
  }
  return out
}

function normalize(buf, peakDb) {
  let peak = 0
  for (const v of buf) peak = Math.max(peak, Math.abs(v))
  const g = peak ? db(peakDb) / peak : 0
  for (let i = 0; i < buf.length; i++) buf[i] *= g
  return buf
}

const seconds = (s) => new Float32Array(Math.round(s * SR))

/** key tick: a 12 ms band-passed noise burst, slightly different pitch and level each time */
function keyTick() {
  const b = seconds(0.016)
  for (let i = 0; i < b.length; i++) b[i] = noise()
  const f = 3200 * (0.8 + 0.4 * rand())
  const out = bandpass(b, () => f, 1.4)
  for (let i = 0; i < out.length; i++) {
    const t = i / SR
    out[i] *= Math.min(1, t / 0.0005) * Math.exp(-t / 0.0032)
  }
  return normalize(out, -29 + 3 * rand())
}

/** mouse click: 25 ms, a 2 kHz body under a short noise transient */
function click() {
  const b = seconds(0.025)
  for (let i = 0; i < b.length; i++) {
    const t = i / SR
    b[i] = Math.sin(2 * Math.PI * 2000 * t) * Math.exp(-t / 0.006) + 0.6 * noise() * Math.exp(-t / 0.0012)
    b[i] *= Math.min(1, t / 0.0003) * (t > 0.02 ? (0.025 - t) / 0.005 : 1)
  }
  return normalize(b, -19)
}

/** a noise sweep between two frequencies; `shape` is the envelope over 0..1 */
function sweep(len, f0, f1, q, shape, peakDb) {
  const b = seconds(len)
  for (let i = 0; i < b.length; i++) b[i] = noise()
  const out = bandpass(b, (t) => f0 * Math.pow(f1 / f0, t / len), q)
  for (let i = 0; i < out.length; i++) out[i] *= shape(i / out.length)
  return normalize(out, peakDb)
}

/** E5 then B5, sines with a soft octave, 120 ms apart, ringing out */
function chime() {
  const b = seconds(1.1)
  for (const [f, at] of [[659.25, 0], [987.77, 0.12]]) {
    const o = Math.round(at * SR)
    for (let i = 0; o + i < b.length; i++) {
      const t = i / SR
      const env = Math.min(1, t / 0.004) * Math.exp(-t / 0.26)
      b[o + i] += env * (Math.sin(2 * Math.PI * f * t) + 0.22 * Math.sin(2 * Math.PI * 2 * f * t))
    }
  }
  return normalize(b, -18)
}

/** a low 400 ms swell under the title band */
function swell() {
  const b = seconds(0.45)
  const n = bandpass(Float32Array.from(b, () => noise()), () => 260, 0.8)
  for (let i = 0; i < b.length; i++) {
    const t = i / SR
    const env = t < 0.3 ? Math.pow(t / 0.3, 2) : Math.max(0, Math.cos(((t - 0.3) / 0.15) * (Math.PI / 2)))
    b[i] = env * (Math.sin(2 * Math.PI * 98 * t) + 0.5 * Math.sin(2 * Math.PI * 147 * t) + 0.6 * n[i])
  }
  return normalize(b, -21)
}

const sounds = {
  key: () => [[keyTick(), 0]],
  click: () => [[click(), 0]],
  drawer: () => [[sweep(0.22, 700, 3400, 1.1, (p) => Math.pow(p, 1.3) * Math.min(1, (1 - p) / 0.18), -25), 0.02]],
  applied: () => [[sweep(0.3, 450, 4200, 0.9, (p) => Math.pow(Math.sin(Math.PI * p), 1.5), -23), 0], [chime(), 0.3]],
  band: () => [[swell(), 0]],
  close: () => [[chime(), 0]],
}

const track = new Float32Array(Math.ceil((duration + 1.5) * SR))
let placed = 0
for (const e of timeline.events) {
  const at = (e.t - timeline.start) / 1000
  if (at < -0.05 || at > duration) continue
  for (const [buf, offset] of sounds[e.kind]()) {
    const o = Math.round((at + offset) * SR)
    for (let i = 0; i < buf.length; i++) if (o + i >= 0 && o + i < track.length) track[o + i] += buf[i]
  }
  placed++
}
const wav = Buffer.alloc(44 + track.length * 2)
wav.write('RIFF', 0); wav.writeUInt32LE(36 + track.length * 2, 4); wav.write('WAVE', 8)
wav.write('fmt ', 12); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22)
wav.writeUInt32LE(SR, 24); wav.writeUInt32LE(SR * 2, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34)
wav.write('data', 36); wav.writeUInt32LE(track.length * 2, 40)
for (let i = 0; i < track.length; i++) wav.writeInt16LE(Math.round(Math.tanh(track[i]) * 32767), 44 + i * 2)
const audio = path.join(work, 'sound.wav')
fs.writeFileSync(audio, wav)
const counts = {}
for (const e of timeline.events) counts[e.kind] = (counts[e.kind] ?? 0) + 1
console.log(`sound: ${placed} events placed (${Object.entries(counts).map(([k, n]) => `${k} ${n}`).join(', ')})`)

run('ffmpeg', ['-y', '-loglevel', 'error', '-i', picture, '-i', audio, '-map', '0:v', '-map', '1:a', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '96k', '-t', duration.toFixed(3), '-movflags', '+faststart', mp4])

const probe = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration,size:stream=codec_type,codec_name,width,height', '-of', 'json', mp4], { encoding: 'utf8', shell })
const info = JSON.parse(probe.stdout)
const length = Number(info.format.duration)
const sizeMb = Number(info.format.size) / 1024 / 1024
const video = info.streams.find((s) => s.codec_type === 'video')
const sound = info.streams.find((s) => s.codec_type === 'audio')
console.log(`docs/demo.mp4: ${video.codec_name} ${video.width}x${video.height}${sound ? ` + ${sound.codec_name}` : ', no audio'}, ${length.toFixed(1)} s, ${sizeMb.toFixed(2)} MB`)
if (length > MAX_SECONDS || sizeMb > MAX_MB || !sound) {
  console.error(`the demo must be at most ${MAX_SECONDS} s and ${MAX_MB} MB, with a sound track`)
  process.exit(1)
}

// the landing page serves its own copy (it is deployed without docs/), plus a poster frame: the applied card
fs.copyFileSync(mp4, path.join(root, 'site', 'demo.mp4'))
const applied = timeline.events.find((e) => e.kind === 'applied')
const posterAt = applied ? (applied.t - timeline.start) / 1000 + 1.6 : 13
run('ffmpeg', ['-y', '-loglevel', 'error', '-ss', posterAt.toFixed(2), '-i', mp4, '-frames:v', '1', '-q:v', '4', path.join(root, 'site', 'poster.jpg')])
console.log('copied to site/demo.mp4 and site/poster.jpg')
