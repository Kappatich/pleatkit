# Eval report 2026-10-21: stage 5 block 8, Sonnet against Haiku on one day, GLM and Kimi on a fast host

> The transcripts, the private suites and the HTML reports this report names (`evals/recordings/...`,
> `evals/tasks/{apps,awkward,redteam,blind}`, `evals/apps`, `evals/probes`, `evals/report/*.html` other than the demo's,
> the live baselines) are kept in the maintainers' private evals since the repository went public; transcripts
> available on request. The numbers here are as published.

DECISIONS 86 (1), (3) and the flaky tests. Executor: Claude Opus 5.5. Prompt `2026-10-19.5j` (unchanged; no prompt
change in this block). The same 69 tasks as the matrix (demo 14, apps 35, awkward 20), Claude Haiku 5.5 as the
classifier in every run. Each set was recorded live without the browser (`<set>/record.json`: the real latencies and
costs) and then replayed with the browser grader and the visual judge (`<set>/graded.json`: the pass and the judge),
as in block 7. Transcripts: `evals/recordings/b8-sonnet/`, `b8-haiku/`, `b8-glm-5.3-flash/`, `b8-kimi-k2.6/`; the
tables come from `pnpm --filter @pleatkit/evals matrix -- --sets b8-sonnet,b8-haiku,b8-glm-5.3-flash,b8-kimi-k2.6
--reference b8-sonnet --compare b8-sonnet,b8-haiku` (`evals/recordings/b8-summary.json`).

## Money

Limits: Anthropic $6, OpenRouter $1.50.

| Run | Anthropic (metered) | OpenRouter |
|---|---|---|
| Sonnet 5.5, 69 × 3 (`b8-sonnet`; the Haiku classifier inside it $0.015) | $4.829 | — |
| Haiku 5.5, 69 × 3 (`b8-haiku`, editor and classifier) | $0.390 | — |
| Visual judge (Haiku) on the four sets: Sonnet $0.047, Haiku $0.047, GLM $0.016, Kimi $0.016 | $0.126 | — |
| Haiku as the classifier in the GLM and Kimi runs | $0.011 | — |
| GLM-5.3 Flash, 69 × 1 at `provider.sort: throughput` (metered from OpenRouter's `usage.cost`) | — | $0.189 |
| Kimi K2.6, 69 × 1 at `provider.sort: throughput` | — | $0.678 |
| Host probe: one short call per model with and without the sort (which host OpenRouter picks) | — | $0.001 |
| Billed by OpenRouter but not metered by the agent (early calls cancelled when the classifier answers alone) | — | $0.108 |
| **Total** | **$5.356** | **$0.976** (the key's `usage`: $3.271 → $4.247) |

Grading, replays, unit tests, e2e: $0.

## 1. Sonnet 5.5 against Haiku 5.5 as the editor, one day, 69 × 3 each

Both runs started at 14:22 UTC side by side (two processes, nothing else on the machine) and ended at 14:39 and
14:42.

| Editor | Demo | Apps | Awkward | All | First try | Calls (median) | Edit latency median / p95 | Cost per edit median / p95 | Judge: designer would accept (mean) | Total |
|---|---|---|---|---|---|---|---|---|---|---|
| **Claude Sonnet 5.5** | 42/42 (100 %) | 105/105 (100 %) | 57/60 (95.0 %) | **204/207 (98.6 %)** | 148/148 (100 %) | 1 | 5.4 s / 10.2 s | $0.027 / $0.061 | 115/148 (4.0) | $4.829 |
| Claude Haiku 5.5 | 42/42 (100 %) | 105/105 (100 %) | 56/60 (93.3 %) | **203/207 (98.1 %)** | 145/147 (98.6 %) | 2 | 6.5 s / 11.2 s | $0.0026 / $0.0038 | 120/147 (4.1) | $0.390 |

Per grader (applicable runs):

| Editor | verdict | change | check | typecheck | invariants | predicates | budget | browser |
|---|---|---|---|---|---|---|---|---|
| Sonnet 5.5 | 204/207 | 204/207 | 148/148 | 148/148 | 54/57 | 189/189 | 207/207 | 150/153 |
| Haiku 5.5 | 204/207 | 204/207 | 147/147 | 147/147 | 54/57 | 189/189 | 207/207 | 149/153 |

Per family: identical in every family (simple 75/75, chart 9/9, sort-filter 21/21, mixed-server 27/27, vague 18/18,
adversarial 24/24) except "totals, averages, two asks, screenshot, carry-over": Sonnet 30/33, Haiku 29/33.

**Per-task disagreements** (tasks the two pass a different number of times out of three): one.

| Task | Sonnet | Haiku | What happened |
|---|---|---|---|
| aw-09 (the ask in the middle of a forwarded e-mail: "average deal size") | 3/3 | 2/3 | Haiku's trial 2 averaged the **won** deals only ($48,000 over 1 deal) instead of all deals ($35,300); the browser check caught it. Trials 1 and 3 averaged all deals. |

Shared failures: aw-07 (a screenshot and "this 👆") asks a question instead of editing, 3 of 3 for both, as in every
earlier run. Not first try: Haiku crm-08 t1 (stale carry-over) and ta-12 t2 (a Russian label); Sonnet none. Calls per
edit: Sonnet 1 on 88 of 148 edits and 2 on 58; Haiku 2 on 142 of 147 (it reads before it writes). Slowest edits:
Sonnet 12.5 s (sa-15), Haiku 15.7 s (aw-17).

### The decision rule (DECISIONS 73.2, 86.1)

Haiku becomes the BYOK default only if its pass rate is within 1 point of Sonnet's on every set, its first-try rate
within 3 points, and its edit-latency p95 under 12 s (`byokDefaultRule` in `evals/src/matrix.ts`; "within" is
one-sided: better than Sonnet passes).

| Check | Sonnet 5.5 | Haiku 5.5 | Holds |
|---|---|---|---|
| pass, demo | 100.0 % | 100.0 % | yes |
| pass, apps | 100.0 % | 100.0 % | yes |
| pass, awkward | 95.0 % | 93.3 % (−1.7 points) | **no** |
| first try | 100.0 % | 98.6 % (−1.4 points) | yes |
| edit latency p95 | 10.2 s | 11.2 s | yes (under 12 s) |

**Result: Sonnet 5.5 stays the BYOK default; Haiku 5.5 stays the editor of the Free tier and the stand.** The rule
fails on one check by one run of sixty (aw-09 trial 2). That is within noise (one task, one trial), but the rule was set
before the run and is not moved after it. With the in-process graders alone (before the browser) the two were
identical, 204/207 each, and the rule would have switched; the browser grader is what separated them.

Wording for DECISIONS (the architect records it):

> **87. Этап 5, блок 8 принят.** Sonnet 5.5 против Haiku 5.5 редактором, 69 × 3 каждой в один день (классификатор
> Haiku, судья включён): Sonnet 204/207 (демо 42/42, чужие 105/105, неудобные 57/60), первая попытка 148/148, 1 вызов,
> 5,4 / 10,2 с, $0,027 за правку; Haiku 203/207 (42/42, 105/105, 56/60), 145/147, 2 вызова, 6,5 / 11,2 с, $0,0026 за
> правку; судья 115/148 и 120/147. По правилу 73.2 / 86.1 Haiku не проходит на неудобных (−1,7 пункта: aw-09, «средняя
> сумма сделки» по выигранным сделкам в одной попытке из трёх), остальные условия выполнены. **BYOK по умолчанию
> остаётся Sonnet 5.5; Haiku 5.5 остаётся редактором Free и стенда.** GLM-5.3 Flash и Kimi K2.6 на быстром хосте
> (`provider.sort: throughput`): таймаутов нет (было по 4), 67/69 и 66/69 (было 62 и 63), но p95 66,6 и 58,2 с, в план
> Б не входят; план Б остаётся DeepSeek V4.1 Flash. Тесты устойчивы к параллельной сборке (атомарная замена dist).

## 2. GLM-5.3 Flash and Kimi K2.6 on a fast host

OpenRouter routing `provider: { sort: 'throughput' }` (new: `PLEATKIT_OPENROUTER_SORT=throughput`), each model's
default reasoning, the Haiku classifier, apps first, then demo and awkward, 69 × 1 each (both fit the cap). Against the
block-7 run of the same model on default routing:

| Editor | Routing | Demo | Apps | Awkward | All | Time-outs (90 s) | Edit latency median / p95 | Cost per edit median | Judge accept (mean) |
|---|---|---|---|---|---|---|---|---|---|
| GLM-5.3 Flash | default (block 7) | 12/14 | 32/35 | 18/20 | 62/69 (89.9 %) | 4 | 14.7 s / 67.1 s | $0.0017 | 34/45 (3.9) |
| GLM-5.3 Flash | **throughput** | 14/14 | 35/35 | 18/20 | **67/69 (97.1 %)** | **0** | 13.9 s / 66.6 s | $0.0032 | 38/49 (4.0) |
| Kimi K2.6 | default (block 7) | 13/14 | 31/35 | 19/20 | 63/69 (91.3 %) | 4 | 18.5 s / 56.8 s | $0.0099 | 32/45 (3.9) |
| Kimi K2.6 | **throughput** | 14/14 | 33/35 | 19/20 | **66/69 (95.7 %)** | **0** | 12.9 s / 58.2 s | $0.011 | 38/50 (4.0) |

**The deadline failures disappeared** (4 → 0 each) and the pass went up by 5 and 3 tasks, but **the tail did not
move**: p95 is still 58–67 s, and the slowest edits took 81 s (GLM, crm-13) and 85 s (Kimi, sa-15), a few seconds under
the 90 s deadline. The tail is the models' own reasoning, not the host: Kimi's 85 s edit wrote 11,742 output tokens of
which 11,009 were thinking; GLM's 67 s sa-05 edit thought 4,869 tokens. The fast host raised the median output speed
over the whole edit (GLM 127 → 150 tokens/s, Kimi 97 → 151) and Kimi's median latency (18.5 → 12.9 s); GLM's median
stayed at 14 s. The probe call picked Friendli for GLM (95 tokens/s against InferenceNet's 52 on default routing) and
Baidu for Kimi on both routings. Faster hosts cost more per edit (GLM $0.0017 → $0.0032).

Remaining failures: GLM aw-07 (asks, as everyone) and aw-09 (averaged the 3 open deals: $32,500); Kimi sa-11 and ta-05
(the compact stat cards stay taller than asked: 166 px against ≤ 128, 176 against ≤ 160) and aw-07 (wrote the phone but
not the city and source from the screenshot). Kimi no longer has block 7's apps failures (sa-04, sa-05, sa-15).

**Reading it:** one trial each, so 67 and 66 against block 7's 62 and 63 are partly noise (Kimi's per-task flips go
both ways: 5 fixed, 2 new). Neither replaces DeepSeek V4.1 Flash as plan B's editor (66/69, 4.7 s / 14.3 s, $0.0010 per
edit in block 7): both are about 3 × slower at the median and 4–5 × at p95 (an edit that waits a minute in one case of
twenty), and Kimi costs 10 × as much. **They are not excluded for broken edits; they are excluded for the latency
tail.** A lower reasoning effort (`PLEATKIT_EFFORT=low`) would cut the tail and is the one thing left to try if either
is ever needed.

## 3. Flaky tests

What failed under load before this block (DEVLOG block 7): the ensemble's `classifyMs < 20` and the vite-plugin
builds. Reproduced first: the whole-repo `pnpm test` with a parallel `pnpm build` failed in `packages/cli`
(`stage4c.test.ts`, 3 tests: "carry-over needs @pleatkit/agent", the digest and `check-snapshots --typecheck`).
Cause: every package build began with `rm -rf dist`, so for the seconds `tsc` ran, `@pleatkit/agent` (and the others)
had no `dist`; the CLI tests import the agent through it. The timing assertions were the other half.

- **Atomic package builds** (`scripts/build-package.mjs`, the `build` script of agent, cli, runtime, store-cloud,
  store-server and vite-plugin; `packages/ui` is not touched, its build still deletes first): `tsc` writes into
  `dist.build-<pid>`, then `dist` is renamed aside and the new folder renamed in (retried for up to 5 s if Windows
  holds a handle), then the old one is deleted. A package is without `dist` only between two renames. The temporary
  folders are ignored by git and eslint.
- **Ensemble timings relative, not absolute** (`packages/agent/test/stage5-block6.test.ts`): the edit test now gives
  the classifier model 300 ms and the edit turn 600 ms and asserts `classifyMs < 300` (only Jev's 1 ms answer can be
  that fast; before: `< 20` against a 20 ms classifier, which a busy event loop broke); "Jev answers first" asserts
  under 300 ms against a 300 ms model (was 35 against 40); "a slow Jev is not waited for" asserts under 400 ms against
  an 800 ms Jev and waits for the late answer with `vi.waitFor` (was a fixed 450 ms sleep).
- **vite-plugin** gets a `vitest.config.ts` with the repository's 30 s test timeout (it ran on vitest's 5 s default;
  its manifest and digest tests load the TypeScript compiler).

Proof: a `pnpm build` loop ran the whole time (4 full builds) while `pnpm test` ran three times in a row: **3 of 3
green**, 42 s, 42 s and 47 s (runtime 289, agent 255, evals 77, store-server 63, cli 53, vite-plugin 37, ui 16,
store-cloud 7 (private package), react18-smoke 2). Before the build change the same setup failed at the first run.

## What changed in the code

- `OpenAICompatibleProvider`: `providerSort` (`PLEATKIT_OPENROUTER_SORT=throughput|latency|price`) sends OpenRouter's
  `provider: { sort }` on every call, the classifier's included; nothing off OpenRouter or when unset.
- `evals/src/matrix.ts`: `perTask` in each row, `disagreements(a, b)`, `byokDefaultRule(ref, cand)` and
  `--compare ref,cand` (prints the disagreements and the rule).
- `scripts/build-package.mjs` and the six `build` scripts; `.gitignore` and `eslint.config.js` ignore `dist.build-*`
  and `dist.old-*`.
- Tests: `packages/agent/test/stage5-block7.test.ts` (+1, the sort on a local HTTP server), `evals/test/block8.test.ts`
  (2: per-task counts and disagreements, the rule's edges), the timing changes above.

## Deviations

1. **Sonnet's run came to $4.83 of its $5.00 cap** (the estimate was $4.57 from block 7's $1.52 × 3); it did not stop
   early. The Anthropic total is $5.36 of $6.
2. Both Anthropic runs were recorded without the browser (side by side, as in block 7) and graded afterwards; their
   latencies are from the live record, with two processes on the machine and no build or test beside them.
3. The GLM and Kimi runs went side by side while the Sonnet and Haiku sets were being graded (browser and judge on the
   same machine); their latencies include the type check under that load (seconds at most; the tail is a minute of
   thinking, see above).
4. `packages/ui`'s build script still deletes `dist` first (the architect owns the package); no test imports its dist.

## Open questions

1. Haiku missed the rule by one run of sixty on the awkward set and was identical to Sonnet everywhere else, at a tenth
   of the cost per edit. Keep the rule as it is (Sonnet stays), or measure again later (a second 69 × 3 would cost
   about $5.2 Anthropic)?
2. GLM and Kimi: close the question (excluded for the latency tail) or try `PLEATKIT_EFFORT=low` once (≈ $0.6 on
   OpenRouter)?
3. Should `packages/ui` use the same atomic build (one line in its `package.json`)?
