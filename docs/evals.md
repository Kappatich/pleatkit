# Evals

The eval harness (`evals/`, package `@pleatkit/evals`) measures the agent on fixed tasks. DECISIONS 43 and 63: no
prompt or model change without an eval report, and every prompt change bumps `PROMPT_VERSION` in
`packages/agent/src/prompt.ts`.

Everything below runs offline on recorded answers; no command here needs `PLEATKIT_API_KEY`. Run `pnpm build` first:
the tasks run against the demo's build manifest (`apps/demo-crm/dist/pleatkit.manifest.json`), and the browser grader
uses the demo's production build.

```bash
pnpm eval:sanity    # reference solutions pass every grader; the null agent fails every task that needs a change
pnpm eval:replay    # every task against its scripted transcript; exit 1 on a regression vs evals/baseline.scripted.json
pnpm eval:replay -- --set live   # every trial of the live series (evals/recordings/live/) vs evals/baseline.json
pnpm eval:report    # evals/report/index.html from the last replay (and sanity) results
pnpm eval:pin       # the last replay becomes the baseline of its set (with its PROMPT_VERSION)
pnpm eval:record    # re-record evals/recordings from the scripted fixtures (after changing a task or a fixture)
# options: -- --only crm-01,crm-04   -- --tasks demo|apps|all   -- --set <name>   -- --no-browser   -- --no-typecheck
#          -- --no-classifier   -- --sequential-classifier
pnpm eval:classify -- --tasks apps --against apps   # the classifier alone on every task (Haiku, ≈ $0.008), next to a set's labels
```

Two sets of transcripts, two baselines:

| Set | Transcripts | Baseline | What its replay tests |
|---|---|---|---|
| scripted (no `--set`) | `evals/recordings/<task>.jsonl`, from the scripted fixtures | `evals/baseline.scripted.json` | the harness, the tools and the graders on fixed answers; `crm-04` fails on purpose |
| `live` | `evals/recordings/live/<task>.t<n>.jsonl`, three trials per task, recorded from the model | `evals/baseline.json` (DECISIONS 67.1: pinned on the first live run) | that the graders, tools and check still agree with what the model answered under the pinned prompt |

Other named sets (`smoke-4c1`, `matrix-haiku`, `matrix-no-classifier`, …) live next to them with the same file
names and no baseline. Each named set keeps the record results of its live run in `<set>/record.json`: the only
place with real latencies (a replay's timings are the harness's, not the model's).

## How a run works

Each task runs through `runAgent` in-process: the same loop, tools, automatic check and limits as `POST /agent/v1/run`,
with the input the agent server trusts (context, readonly sources, core types, protected elements, digests) taken
from the demo's manifest by `trustedInput`. The model is a `ReplayProvider` over `evals/recordings/<task>.jsonl`
(replay), the reference or null agent (sanity), a `ScriptedProvider` fixture (record), or later a live model.

Then the graders run on the result. Each returns pass or fail and a reason; "skipped" means not applicable.

| Grader | Passes when |
|---|---|
| `verdict` | the verdict is the task's `expected.verdict` |
| `change` | a task with `expected.change` changed files; any other task changed nothing |
| `check` | the shared `check` (`Compiler.compile`: bundle, static rules, protected elements, default exports) passes on the user's files with the change applied |
| `typecheck` | `tsc` over the dynamic files with the app's readonly sources and `.d.ts`; packages resolve from `PLEATKIT_TYPECHECK_ROOT`, by default `apps/demo-crm` (DECISIONS 63.4: on when the app's `node_modules` are found); `--no-typecheck` or an empty `PLEATKIT_TYPECHECK_ROOT=` skips it |
| `invariants` | text checks: `files[].mustContain / mustNotContain / mustMatch / mustNotMatch`, `forbidden` patterns in changed files, `unchanged` files |
| `predicates` | the named custom checks in `evals/src/predicates.ts` hold |
| `budget` | the run stayed under its dollar cap and was not stopped for money |
| `browser` | in the demo app (headless Chromium, its own ports 4283/8898–8900), the result is committed through the engine (`draft.commit('agent')` under `?eval=1`, compiled and signed by the agent server), then: no crash banner, the three panels render, and the task's `browser.checks` hold |

A check finds its element by a `data-testid` the app documents, or by text. The demo documents one rule in
`apps/demo-crm/docs/design-system.md`, which reaches the agent's cached prompt as `designSystem.docs`: data fields keep
`data-testid` equal to the field name (`due-date`, `phone`, `city`, `source`). Checks may use those ids and the
panels' own ids. Anything else (a total row, a pill, a new tile) is checked by what the user sees: `contains` on the
panel, `byText` (the element whose whole text is this, any case) and `classMatches` (a class on the element or inside
it matches a regular expression). Text invariants check behaviour too (`mustMatch` on reading `meta.phone`), not the
fixture's formatting. `evals/test/tasks.test.ts` refuses a testid inside a panel that is not a documented field.

A task passes when every grader passes.

## Money

`PLEATKIT_EVAL_BUDGET_USD` caps one run; `budgetUsd` in a task caps that task (default $0.50). Every task's agent loop
gets the smaller of its cap and what is left of the run's cap as its per-edit dollar limit, so the loop stops between
model calls once it is reached (one call can overshoot). After the run's cap is spent the runner stops before the next
task with a message that names the spend, the cap and the tasks not run, and the report shows it. Offline runs cost
$0: scripted and replayed models have no price, the report says so; the same accounting is tested with priced
transcripts in `evals/test/runner.test.ts`.

## Adding a task

1. Write `evals/tasks/<id>.json` (the demo) or `evals/tasks/apps/<id>.json` (the foreign apps; ids: lower-case, digits, dashes). Fields:

   | Field | |
   |---|---|
   | `id`, `app` (`demo-crm`, `shadcn-admin`, `tailadmin`: `evals/src/apps.ts`), `title`, `scenario` | names; `scenario` says what it covers |
   | `request`, `locale` | the user's text; `ru` for a Russian-speaking user |
   | `target`, `targetDom`, `images` | pointed panel, its DOM snapshot, screenshots (repo-relative paths) |
   | `clarification` | `{ question, answer }`: the user already answered the one question |
   | `startFiles` | `{ dynamic path: repo path }` when the user does not start from the release's files |
   | `migration` | `{ oldBaseSuffix, edited }`: a stale head carried over to the current release |
   | `expected` | `{ verdict, change }` |
   | `invariants` | `files`, `forbidden`, `unchanged`, `anyMustMatch` (some file of the result matches), `predicates`, `browser: { customer, path, checks: [...] }` (below) |
   | `reference` | `{ files: { dynamic path: repo path } }`: required when `expected.change` is true |
   | `budgetUsd` | the task's dollar cap |
   | `record` | `{ fixture }`: the scripted fixture (by `name`) that plays the agent for the offline recording |

2. Put the reference solution under `evals/references/` (or point at an e2e fixture) and, if no scripted fixture fits,
   add one under `evals/fixtures/scripted/` (same format as `apps/demo-crm/e2e/fixtures/agent`, matched by name).
3. `pnpm eval:record -- --only <id>`, then `pnpm eval:sanity`: the reference must pass every grader and the null agent
   must fail the task if it needs a change. If the null agent passes, add an invariant or a browser check.
4. `pnpm eval:replay`, `pnpm eval:report`; pin with `pnpm eval:pin` once the result is what you expect.

A new kind of check is one function in `evals/src/predicates.ts` and its name in the task's `invariants.predicates`.

## Reading the report

`evals/report/index.html` is one light page without scripts or outside resources.

- **Tiles:** pass rate (and the baseline's), cost, tokens (input, cache read and write, output), cache hit rate (H1),
  median model calls (H3), first try (H2: no failed check or finish among runs that wrote files), the prompt version
  and the size of the cached prefix (estimated: instructions at 2.9, the app's code at 2.2 characters per token, ≈ 900
  for the tools; `pleatkit doctor` with `PLEATKIT_API_KEY` counts it exactly), with its change against the baseline;
  edit latency (median, p95, the classifier-only answers and the parallel start's overlap); with several apps, a
  table by app.
- **Notes:** a run stopped by money, regressions, transcripts recorded with another prompt version (a replay repeats
  recorded answers: it tests the harness, tools and graders, not a new prompt; re-record with a model to measure one),
  unpriced models.
- **Against the baseline:** pass rate, prompt and cost before → after; regressed, fixed and new tasks.
- **Graders:** pass rate of each grader over the tasks where it applied.
- **Tasks:** one row per task: expected → actual verdict, a mark per grader (✓ pass, ✗ fail, – not applicable; hover for
  the reason), model calls, tokens, cost, time, status against the baseline. A failing task shows each failed grader's
  reason under its row.
- **Sanity check:** reference solutions passing and null-agent failures.

`crm-04-deals-total-row` fails on purpose: its recording is the demo's scenario 4 (an edit that compiles and throws
while rendering). The text invariants and the browser grader catch it; `check` and `tsc` do not.

## Stage 5: live runs

`pnpm eval:record -- --live` records with the configured model (`PLEATKIT_PROVIDER`, `PLEATKIT_MODEL`, …) into the set
`live` (or `--set <name>`) and refuses without `PLEATKIT_API_KEY` and `PLEATKIT_EVAL_BUDGET_USD`. `--trials 3` runs each
task three times in a row; `--no-classifier` skips the classifier, so the main model answers every request. A live
record runs the browser grader right away, so `<set>/record.json` has the full grades and the real timings.

```bash
PLEATKIT_EVAL_BUDGET_USD=6 pnpm eval:record -- --live --trials 3                 # the series: 14 × 3 on Sonnet 5.5
PLEATKIT_MODEL=claude-haiku-5-5 pnpm eval:record -- --live --set matrix-haiku --only crm-01,crm-02,…
pnpm eval:replay -- --set live && pnpm eval:pin -- --set live                  # offline; pins evals/baseline.json
pnpm eval:report -- --set live --from record --baseline scripted --out evals/report/live.html
```

With trials the report adds a table of tasks across trials (passes of trials, verdicts, median calls, cost and time)
and tiles for the latency (median, p90), cost per edit (median, max over runs that changed files) and
`cacheHitRate()` over every call and over the main model's calls. A task's baseline entry sums its trials
(`passes` of `trials`); a replay regresses when a smaller share of a task's trials passes. `pnpm eval:pin -- --set <name>`
refuses transcripts recorded with another `PROMPT_VERSION`.

## Stage 5, block 2: the foreign apps (`--tasks apps`)

Two open-source admin templates with pleatkit installed by the customer docs live in `evals/apps`
([`evals/apps/README.md`](../evals/apps/README.md)): shadcn-admin (pnpm) and TailAdmin (npm), both Vite 8. Their 35
tasks are `evals/tasks/apps/*.json` (`sa-*`, `ta-*`): fields to add, reorder or remove, colours, filters the user
clicks, sorting, a chart from a list, compact layouts, i18n labels, server work, a partial request, ambiguous requests
that need a question, a part of the screen outside the zone, and three adversarial requests. Each change task has a
reference under `evals/references/apps/<app>/` (written by `evals/references/apps/make-references.mjs` from the
apps' current panels, so a changed panel fails loudly there).

```bash
cd evals/apps/shadcn-admin && pnpm install --ignore-workspace && pnpm build && cd ../tailadmin && npm ci && npm run build
pnpm eval:sanity -- --tasks apps                        # 35 references pass; the null agent fails the 26 change tasks
pnpm eval:replay -- --set apps                          # the Sonnet series (35 × 2) vs evals/baseline.apps.json
PLEATKIT_EVAL_BUDGET_USD=6 pnpm eval:record -- --live --tasks apps --trials 2      # writes the set `apps`
```

What differs from the demo:

- **Manifests and tsc per app.** Each task runs against its own app's `dist/pleatkit.manifest.json`; the tsc grader
  resolves packages from that app's `node_modules` (a set `PLEATKIT_TYPECHECK_ROOT` still wins for every app).
- **Browser grader per app.** One Playwright run per app (`EVAL_APP`): the agent server with the app's manifest, an
  in-memory store-server and `vite preview` of the app's build, on the grader's own ports. The app is opened on the
  route of the task's panel (`invariants.browser.path`, else the panel's route in `evals/src/apps.ts`) with
  `?app=<run>&eval=1`; the panels of that route must render after the commit.
- **Checks without test ids.** The foreign apps document no test ids, so their checks never use `testid` (a unit test
  enforces it). A check scopes to a panel by its `<Dynamic id>` (`panel`) and finds elements by what the user sees:
  `selector` (CSS structure: `thead th`, `.recharts-line`), `role` + `name` (a button), `byText` / `textMatches`, then
  checks `count`, `contains` / `notContains`, `matches` (the whole text against a regular expression: the order of rows),
  `classMatches` with `classScope: "around"` (also on ancestors: a struck-through row), `css` (a computed style:
  `font-weight`), `maxHeight` (a compact layout) and `click` (later checks see the result: a filter button).
- **`anyMustMatch`** (text invariant): some dynamic file of the result matches, wherever the agent put the change.
- **`chart-colors-green`** (predicate): the first colour of a chart's `colors: [...]` option is a green.

`pnpm eval:classify -- --tasks apps --against <set>` runs only the classifier (Haiku) on every task it would see, with
today's prompt and the app's data contract, and prints the label next to the one the set recorded: a classifier change
measured for under a cent before any edit runs (`evals/results/classify-<set>.json`).

Sets of this block: `apps-5b` (Sonnet 5.5, prompt 5b: the series as asked), `apps-5c` (prompt 5c), `apps` (prompt
5d at the time; since block 4 the set holds the 5f trials, below), `apps-haiku` (Haiku 5.5 as the editor, 35 × 1), `live-haiku` (Haiku 5.5 as
the editor on the demo, 14 × 3), `live-5d` and `live-5d-sequential` (Sonnet on the demo with the parallel and the
sequential classifier: the A/B), `probe-5b`, `probe-5d`, `apps-5d-probe` (small re-runs after a prompt change). The numbers:
[`evals/REPORT-2026-10-18-foreign.md`](../evals/REPORT-2026-10-18-foreign.md).

The classifier and the main model start together by default (DECISIONS 73.3); `--sequential-classifier` waits for the
classifier as before, for comparisons. A run's `timings.overlapMs` is the time the parallel start saved.

## Stage 5, block 3

- **The loop type-checks.** Every run (record, replay, sanity) runs the agent loop with the same type check as the
  agent server (DECISIONS 74.2: on when the app's `node_modules` are found), against each app's own packages.
  `--no-loop-typecheck` (or `--no-typecheck`, or `PLEATKIT_TYPECHECK=0`) runs the loop without it, as before.
- **`pnpm eval:cancel -- --tasks all`** (needs `PLEATKIT_API_KEY`, a few cents per task): for every task the classifier
  answers alone, the request as the server runs it (the streamed early call, cancelled when the classifier answers;
  `cancelledCall` says what the stream had reported) and the same first call plain and to its end (what a plain cancel
  could at most have billed). Writes `evals/results/cancel-probe.json`. `--only`, `--skip-before`.
- **`eval:classify`** takes `--probes <file>` (requests that are not tasks: `evals/probes/*.json`, `{ id, app, request,
  expected }`), `--repeat n` (the classifier is noisy on mixed requests), `--out <name>`, and prints how many labels route
  right and how much of the classifier's input came from the prompt cache:

```bash
pnpm eval:classify -- --probes evals/probes/mixed-requests.json --repeat 3 --out mixed-after
pnpm eval:classify -- --tasks all --only crm-10-partial-phone-history,sa-15-tasks-days-left-and-reminders --repeat 5
```

Sets of this block: `apps-5f` (Sonnet 5.5, prompt 5f, 35 × 1), `probe-5f` (the five demo smoke tasks, sa-12, crm-10,
sa-15, × 2), `probe-5f-haiku` (sa-12 and ta-09 with Haiku 5.5 as the editor). Numbers: the "Block 3" section of
[`evals/REPORT-2026-10-18-foreign.md`](../evals/REPORT-2026-10-18-foreign.md#block-3); the probe results are kept in `evals/probes/results/` (`evals/results/` is not committed).

## Stage 5, block 4

Numbers: [`evals/REPORT-2026-10-19.md`](../evals/REPORT-2026-10-19.md).

- **Visual-quality judge** (DECISIONS 75 Р3, 80). `--judge` on a live record, or `pnpm eval:judge -- --set <name>`
  (a replay of the set with the judge; it calls the API, so it needs `PLEATKIT_API_KEY` and `PLEATKIT_EVAL_BUDGET_USD`).
  The browser grader screenshots the changed panel before and after the commit (`evals/.out/browser/results/<app>/`)
  and runs deterministic pre-checks on the "after" render: horizontal overflow, content spilling past the panel box,
  text contrast under WCAG AA (reported under 3.0:1), a button or link with no accessible name, console errors on
  commit. Any of them fails the edit without calling the model. Otherwise Claude Haiku 5.5 scores the pair against
  [`evals/rubrics/visual.md`](../evals/rubrics/visual.md): four criteria (design_system, no_breakage, did_what_asked,
  nothing_unrelated) and an overall, 1 to 5 each; **overall ≥ 4 is "a designer would accept it"**. The judge is
  advisory: it has its own report column and tile ("Designer would accept", with per-criterion medians) and never fails
  a run. `pnpm eval:judge -- --calibrate` renders 10 reference solutions (should score ≥ 4) and 5 ugly edits
  (`evals/judge/make-ugly.mjs`, should score ≤ 2) from `evals/judge/calibration.json` and writes
  `evals/judge/calibration-result.json`.
- **Commits keep the page outside the panels.** Every browser case records the visible landmarks outside the panels
  (`aside`, `nav`, `header`, the sidebar) before the commit and fails if one is hidden after it.
- **New suites** (`--tasks awkward`, `--tasks redteam`; a replay of a named set takes every suite):
  - `awkward` (20, `evals/tasks/awkward/make-awkward.mjs`): requests as irritated users write them. Where the ask is one
    an existing task checks, the task reuses that task's reference and invariants, so the phrasing is what is measured.
    `expected.alsoAccept` lists other answers that are also right (an emoji-only request may be asked about or refused).
    Live set `awkward` (20 × 2), baseline `evals/baseline.awkward.json`.
  - `redteam` (30, `evals/tasks/redteam/make-redteam.mjs`, zero tolerance): 20 static attacks a scripted stand-in for a
    compromised model writes into the demo's card (the fixture asserts that `finish` is refused by `check`, so a rule
    that stops blocking fails the recording), and 10 judgement attacks (prompt injection in the panel DOM and data,
    "the admin said", other users' data, PII, hiding pleatkit's own controls, editing readonly code, an obfuscated
    request, an injected "SYSTEM" line in a paste, a fake sign-in) with a scripted refusal for the offline set.
    Offline set `redteam` (30 × 1, baseline `evals/baseline.redteam.json`); the live model on the 10 judgement attacks:
    set `redteam-live`.

```bash
pnpm eval:sanity -- --tasks awkward && pnpm eval:sanity -- --tasks redteam
pnpm eval:record -- --tasks redteam --set redteam                     # offline: the scripted attacks
PLEATKIT_EVAL_BUDGET_USD=2 pnpm eval:record -- --live --tasks awkward --set awkward --trials 2 --judge
PLEATKIT_EVAL_BUDGET_USD=1 pnpm eval:record -- --live --tasks redteam --set redteam-live --only rt-j
PLEATKIT_EVAL_BUDGET_USD=0.15 pnpm eval:judge -- --calibrate
pnpm eval:replay -- --set awkward && pnpm eval:replay -- --set redteam
```

- **The first call's tail** (DECISIONS 76.1): `PLEATKIT_CACHE_TAIL` (`after-first`, the default since this block, or
  `always`). Sets `cache-af2` and `cache-al2` (shadcn-admin, 5 distinct tasks each) are the measurement.
- Sets of this block: `apps-5f-t2` (the second 35 × 1 trial on 5f, judged; with `apps-5f` it is now the set `apps`,
  35 × 2, pinned as `evals/baseline.apps.json`), `cache-afterfirst` / `cache-always` (the first A/B, confounded by the
  prompt cache; kept for the record), `cache-af2` / `cache-al2`, `probe-5g` / `probe-5h` (crm-10, sa-15, sa-13, ta-13),
  `awkward`, `redteam`, `redteam-live`.

## Stage 5, block 5

Numbers: [`evals/REPORT-2026-10-19-block5.md`](../evals/REPORT-2026-10-19-block5.md).

- **Two more foreign apps** (`evals/apps/antd-dashboard`: Ant Design 6, React Router 6, TanStack Query, Vite 5 → 6,
  pnpm 9; `evals/apps/mesa`: CSS modules without Tailwind, React Router 8, TanStack Query, Vite 8, npm), installed blind
  by a fresh coding agent from `docs/for-agents/` only. Their 16 tasks are the suite `blind` (`evals/tasks/blind`,
  generator `make-blind.mjs`, references under `evals/references/blind/`): per app five edits (one of them partial), a
  server-only request, an ambiguous one and an attack. Live sets `blind-ab` and `blind-me` (8 × 2 each).

```bash
cd evals/apps/antd-dashboard && pnpm install --ignore-workspace --ignore-scripts && pnpm build && pnpm smoke
cd evals/apps/mesa && npm ci && npm run build && npm run smoke
pnpm eval:sanity -- --tasks blind
pnpm eval:replay -- --set blind-ab && pnpm eval:replay -- --set blind-me
PLEATKIT_EVAL_BUDGET_USD=1 pnpm eval:record -- --live --tasks blind --set blind-ab --trials 2 --only ab-01-…,…
```

- **Cost against zone size** (brainstorm 17 §3): `--zone-files n` keeps n dynamic files in each task's zone (the files
  the task's reference changes, then the other panels of its route, then the rest; `PLEATKIT_EVAL_ZONE_FILES`). Sets
  `zone-1`, `zone-3`, `zone-7` (shadcn-admin, 5 dashboard tasks each); replay them with the same `--zone-files`.
  `node evals/report/make-zone-chart.mjs` draws `evals/report/zone-cost.svg` from them.
- **Warm type check** (brainstorm 17 §4): the runner warms each app's checker once before its first task, like the
  agent server at start; `PLEATKIT_TYPECHECK_WARM=0` runs the cold checker of blocks 3 and 4 (sets `tsc-cold` and
  `tsc-warm`, 5 shadcn-admin edits each). `pnpm --filter @pleatkit/evals exec tsx src/typecheck-bench.ts shadcn-admin 14`
  times the checker alone (free; `BENCH_WARMUP=1` warms it first).
- **Prompt 5i** was measured with `eval:classify` before any live run: `evals/probes/restore-and-jobs.json` (restore,
  scheduled jobs and syncs joined to screen changes) next to the mixed probes and the 60 tasks of demo, apps and
  awkward. The `restore` label (DECISIONS 82.2) is a verdict of its own; `expected.alsoAccept` takes it, and an answer
  accepted without a change skips the task's per-file invariants (they describe the change).
- **Red team:** 32 tasks: `rt-s-overlay-append-body` (an overlay attached to `document.body`, refused by the new static
  rule `no-portal`) and `rt-r-zindex-overlay`, a runtime case: a full-screen element with the largest z-index is applied,
  and the browser check `launcherOnTop` requires pleatkit's launcher to stay the topmost element at its own position
  (the runtime caps an edited panel's z-index at 999). Live judgement set on 5i: `redteam-live-5i`.
- **The judge** gets the part of a `partial` request passed to the server (`<passed_to_server>`) and a line diff of the
  change (`<code_diff>`, `codeDiff` in `evals/src/judge.ts`); the rubric says how to use them.
- **Landmarks are compared by tag and text**, not by position: a landmark the page adds after its data loads no longer
  counts as one the commit hid.
- Other sets of this block: `awkward-5i` (aw-03, aw-16, aw-17 × 2 on 5i).
- The blind installs' gap logs (10 attempts, JSON: step, kind, what, how it was resolved, the doc fix) are kept in
  `evals/probes/blind/`; the classifier results of 5i in `evals/probes/results/classify-*-5i.json`.
