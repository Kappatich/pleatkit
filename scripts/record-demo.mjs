#!/usr/bin/env node
// Records the demo film headless (about 80 s, at most 90 s and 20 MB) and writes docs/demo.mp4 (H.264 1280x800 +
// AAC mono), site/demo.mp4 (the same file) and site/poster.jpg.
// 1. builds the demo, 2. runs e2e/demo-video.spec.ts with PLEATKIT_VIDEO=1 (Playwright recordVideo, scripted
//    provider paced for reading); the spec also writes docs/.video/events.json: the start/end marks and every
//    sound event (key, click, drawer, applied, whoosh, thud, band, close) in ms since the page was created, and the
//    poster moment,
// 3. ffmpeg trims the webm to the start/end marks and encodes it,
// 4. builds the sound track from the samples in apps/demo-crm/e2e/sounds/ (<kind>-<n>.wav, 48 kHz mono 16-bit,
//    peak -6 dBFS; CC0 and CC BY 4.0, sources in docs/sounds/CREDITS.md): places each event sample-accurately at
//    its kind's gain and mixes them in Node (a few hundred key ticks would make an ffmpeg adelay/amix graph of
//    hundreds of inputs), then muxes it into the mp4 with ffmpeg (-c:v copy -c:a aac),
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

/** a 16-bit PCM mono 48 kHz WAV (what e2e/sounds holds) as floats */
function readWav(file) {
  const b = fs.readFileSync(file)
  if (b.toString('ascii', 0, 4) !== 'RIFF' || b.toString('ascii', 8, 12) !== 'WAVE') throw new Error(`${file}: not a WAV`)
  let fmt = null
  for (let o = 12; o + 8 <= b.length; ) {
    const id = b.toString('ascii', o, o + 4)
    const size = b.readUInt32LE(o + 4)
    if (id === 'fmt ') fmt = { format: b.readUInt16LE(o + 8), channels: b.readUInt16LE(o + 10), rate: b.readUInt32LE(o + 12), bits: b.readUInt16LE(o + 22) }
    if (id === 'data') {
      if (!fmt || fmt.format !== 1 || fmt.channels !== 1 || fmt.rate !== SR || fmt.bits !== 16) throw new Error(`${file}: expected 16-bit PCM mono ${SR} Hz`)
      const out = new Float32Array(Math.floor(size / 2))
      for (let i = 0; i < out.length; i++) out[i] = b.readInt16LE(o + 8 + i * 2) / 32768
      return out
    }
    o += 8 + size + (size & 1)
  }
  throw new Error(`${file}: no data chunk`)
}

// the samples, by kind: key-1.wav to key-5.wav, click-1.wav, ...
const soundsDir = path.join(app, 'e2e', 'sounds')
const samples = {}
for (const file of fs.readdirSync(soundsDir).sort()) {
  const m = /^([a-z]+)-(\d+)\.wav$/.exec(file)
  if (m) (samples[m[1]] ??= []).push(readWav(path.join(soundsDir, file)))
}
const one = (kind) => {
  if (!samples[kind]?.length) {
    console.error(`no ${kind}-<n>.wav in ${soundsDir}`)
    process.exit(1)
  }
  return samples[kind][0]
}

// gain per kind in dB, applied to samples that peak at -6 dBFS: typing peaks near -26 dBFS, the applied and closing
// chimes near -18, the camera's whoosh near -26; everything stays under the -12 dBFS guard below
const GAIN = { key: -21.5, click: -14, drawer: -18, applied: -12, whoosh: -20, thud: -17, band: -15, close: -12 }
// key ticks: never the same sample twice in a row, and each a little louder or softer (±1.5 dB), so typing does
// not sound like a machine gun
let lastKey = -1
function keySample() {
  const keys = samples.key ?? [one('key')]
  let k = Math.floor(rand() * keys.length)
  if (k === lastKey) k = (k + 1) % keys.length
  lastKey = k
  return keys[k]
}
/** [sample, gain in dB, offset in s] for each event kind */
const sounds = {
  key: () => [[keySample(), GAIN.key - 1.5 + 3 * rand(), 0]],
  click: () => [[one('click'), GAIN.click, 0]],
  drawer: () => [[one('drawer'), GAIN.drawer, 0.02]],
  applied: () => [[one('applied'), GAIN.applied, 0]],
  whoosh: () => [[one('whoosh'), GAIN.whoosh, 0]],
  thud: () => [[one('thud'), GAIN.thud, 0]],
  band: () => [[one('band'), GAIN.band, 0]],
  // the closing chime; the closing card's own band event already lays the low drop under it, 250 ms earlier
  close: () => [[one('close'), GAIN.close, 0]],
}

const track = new Float32Array(Math.ceil((duration + 1.5) * SR))
// one stem per kind as well, only to report each kind's peak as it sounds in the film (overlapping key ticks add up)
const stems = {}
let placed = 0
for (const e of timeline.events) {
  const at = (e.t - timeline.start) / 1000
  if (at < -0.05 || at > duration) continue
  const stem = (stems[e.kind] ??= new Float32Array(track.length))
  for (const [buf, gainDb, offset] of sounds[e.kind]()) {
    const o = Math.round((at + offset) * SR)
    const g = db(gainDb)
    for (let i = 0; i < buf.length; i++) {
      if (o + i < 0 || o + i >= track.length) continue
      track[o + i] += buf[i] * g
      stem[o + i] += buf[i] * g
    }
  }
  placed++
}
const peakOf = (buf) => buf.reduce((p, v) => Math.max(p, Math.abs(v)), 0)
console.log(`sound peaks by kind: ${Object.entries(stems).map(([k, b]) => `${k} ${(20 * Math.log10(peakOf(b) || 1e-9)).toFixed(1)}`).join(', ')} dBFS`)
const wav = Buffer.alloc(44 + track.length * 2)
wav.write('RIFF', 0); wav.writeUInt32LE(36 + track.length * 2, 4); wav.write('WAVE', 8)
wav.write('fmt ', 12); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22)
wav.writeUInt32LE(SR, 24); wav.writeUInt32LE(SR * 2, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34)
wav.write('data', 36); wav.writeUInt32LE(track.length * 2, 40)
for (let i = 0; i < track.length; i++) wav.writeInt16LE(Math.round(Math.tanh(track[i]) * 32767), 44 + i * 2)
const audio = path.join(work, 'sound.wav')
fs.writeFileSync(audio, wav)
// levels, checked by numbers only (nothing is played): the mix must peak at or below -12 dBFS
let peak = 0
for (const v of track) peak = Math.max(peak, Math.abs(Math.tanh(v)))
const peakDb = 20 * Math.log10(peak || 1e-9)
const counts = {}
for (const e of timeline.events) counts[e.kind] = (counts[e.kind] ?? 0) + 1
console.log(`sound: ${placed} events placed (${Object.entries(counts).map(([k, n]) => `${k} ${n}`).join(', ')}), peak ${peakDb.toFixed(1)} dBFS`)
if (peakDb > -12) {
  console.error('the sound track peaks above -12 dBFS')
  process.exit(1)
}

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

// the landing page serves its own copy (it is deployed without docs/), plus a poster frame: the changed card,
// zoomed (the spec marks the moment), else 1.6 s after the first applied chime
fs.copyFileSync(mp4, path.join(root, 'site', 'demo.mp4'))
const applied = timeline.events.find((e) => e.kind === 'applied')
const posterAt = timeline.poster ? (timeline.poster - timeline.start) / 1000 : applied ? (applied.t - timeline.start) / 1000 + 1.6 : 13
run('ffmpeg', ['-y', '-loglevel', 'error', '-ss', posterAt.toFixed(2), '-i', mp4, '-frames:v', '1', '-q:v', '4', path.join(root, 'site', 'poster.jpg')])
console.log('copied to site/demo.mp4 and site/poster.jpg')
