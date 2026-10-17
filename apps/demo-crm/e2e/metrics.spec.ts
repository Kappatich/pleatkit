import fs from 'node:fs'
import path from 'node:path'
import { expect, test } from '@playwright/test'
import { CARD, DOCS, editFile, fixture, openApp, readMetrics } from './helpers'

test('metrics: esbuild-wasm size, init time (cold and from Cache API), check time for 3 files', async ({ page }) => {
  await openApp(page)

  // The first check initializes esbuild-wasm: fetch, WebAssembly.compile, start the worker
  let started = Date.now()
  await page.getByTestId('mk-check').click()
  await expect(page.getByTestId('mk-result')).toHaveAttribute('data-ok', 'true')
  const firstCheckWallMs = Date.now() - started
  const cold = await readMetrics(page)
  expect(cold.wasmFromCache).toBe(false)
  expect(cold.wasmBytes).toBeGreaterThan(1_000_000)

  const warm: number[] = []
  for (let i = 0; i < 5; i++) {
    const source = page.getByTestId('mk-source')
    await source.fill(`${await source.inputValue()}\n// edit ${i}`)
    await page.getByTestId('mk-check').click()
    await expect(page.getByTestId('mk-status')).toHaveText(/Check passed/)
    warm.push((await readMetrics(page)).lastCheckMs ?? NaN)
  }

  await editFile(page, CARD, fixture('customer-card.scenario1.tsx'))
  started = Date.now()
  await page.getByTestId('mk-commit').click()
  await expect(page.getByTestId('customer-card').getByTestId('phone')).toBeVisible()
  const commitToRenderMs = Date.now() - started
  const afterCommit = await readMetrics(page)
  await page.getByTestId('mk-undo').click()
  await expect(page.getByTestId('mk-head')).toContainText('(base)')

  // Reload: esbuild.wasm now comes from the Cache API
  await openApp(page)
  await page.getByTestId('mk-check').click()
  await expect(page.getByTestId('mk-result')).toHaveAttribute('data-ok', 'true')
  const cached = await readMetrics(page)
  expect(cached.wasmFromCache).toBe(true)

  const round = (n: number | null, digits = 0) => (n === null ? null : Math.round(n * 10 ** digits) / 10 ** digits)
  const result = {
    measuredAt: new Date().toISOString(),
    browser: `chromium headless shell ${page.context().browser()?.version()}`,
    esbuildVersion: cold.esbuildVersion,
    wasmBytes: cold.wasmBytes,
    initColdMs: round(cold.initMs),
    initFromCacheMs: round(cached.initMs),
    firstCheckWallMs,
    firstCheckCompileMs: round(cold.lastCheckMs),
    warmCheckMs3Files: warm.map((t) => round(t, 1)),
    commitToRenderMs,
    engineCommitMs: round(afterCommit.lastCommitMs),
    swapMs: round(afterCommit.lastSwapMs, 1),
    tailwindInitMs: round(afterCommit.tailwindInitMs),
    tailwindCssBuildMs: round(afterCommit.lastCssMs, 1),
    tailwindCssBytes: afterCommit.lastCssBytes,
  }
  console.log('[metrics]', JSON.stringify(result, null, 2))
  fs.writeFileSync(path.join(DOCS, 'metrics.json'), JSON.stringify(result, null, 2) + '\n')
})
