#!/usr/bin/env node
// Builds one package (run from its folder): tsc -p tsconfig.build.json into a fresh folder beside dist, then swaps it
// in for dist. Stage 5 block 8: before, `rm -rf dist && tsc` left a package without dist for the seconds tsc ran, so a
// `pnpm build` beside `pnpm test` failed every test that imports a sibling package (cli → @pleatkit/agent) and every
// sibling build that reads its declarations. Now dist is missing only between two renames.
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'

const cwd = process.cwd()
const tmp = path.join(cwd, `dist.build-${process.pid}`)
const old = path.join(cwd, `dist.old-${process.pid}`)
const dist = path.join(cwd, 'dist')
const tsc = createRequire(path.join(cwd, 'package.json')).resolve('typescript/bin/tsc')

fs.rmSync(tmp, { recursive: true, force: true })
const r = spawnSync(process.execPath, [tsc, '-p', 'tsconfig.build.json', '--outDir', tmp], { stdio: 'inherit', cwd })
if (r.status !== 0) {
  fs.rmSync(tmp, { recursive: true, force: true })
  process.exit(r.status ?? 1)
}

/** Windows refuses a rename while another process holds a handle in the folder: retry for up to 5 s. */
function rename(from, to) {
  for (let i = 0; ; i++) {
    try {
      fs.renameSync(from, to)
      return
    } catch (e) {
      if (i >= 50 || !['EPERM', 'EBUSY', 'EACCES', 'ENOTEMPTY'].includes(e.code)) throw e
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100)
    }
  }
}

if (fs.existsSync(dist)) rename(dist, old)
rename(tmp, dist)
fs.rmSync(old, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
