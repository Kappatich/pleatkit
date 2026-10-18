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
# options: -- --only crm-01,crm-04   -- --set <name>   -- --no-browser   -- --no-typecheck   -- --no-classifier
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

1. Write `evals/tasks/<id>.json` (ids: lower-case, digits, dashes). Fields:

   | Field | |
   |---|---|
   | `id`, `app` (`demo-crm`), `title`, `scenario` | names; `scenario` says what it covers |
   | `request`, `locale` | the user's text; `ru` for a Russian-speaking user |
   | `target`, `targetDom`, `images` | pointed panel, its DOM snapshot, screenshots (repo-relative paths) |
   | `clarification` | `{ question, answer }`: the user already answered the one question |
   | `startFiles` | `{ dynamic path: repo path }` when the user does not start from the release's files |
   | `migration` | `{ oldBaseSuffix, edited }`: a stale head carried over to the current release |
   | `expected` | `{ verdict, change }` |
   | `invariants` | `files`, `forbidden`, `unchanged`, `predicates`, `browser: { customer, checks: [{ testid, within, count, text, contains, class, attr }] }` |
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
  and the size of the cached prefix (≈ tokens at 3.5 characters each), with its change against the baseline.
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
