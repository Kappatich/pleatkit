# Eval report 2026-10-19: stage 5 block 6

> The transcripts, the private suites and the HTML reports this report names (`evals/recordings/...`,
> `evals/tasks/{apps,awkward,redteam,blind}`, `evals/apps`, `evals/probes`, `evals/report/*.html` other than the demo's,
> the live baselines) are kept in the maintainers' private evals since the repository went public; transcripts
> available on request. The numbers here are as published.

DECISIONS 83 and 84 and brainstorm 17 §5, §14, §20, §21, without the OpenRouter matrix (no key yet). Executor: Claude
Opus 5.5 with sub-agents: one for the `restore` button of the labelling screen, one for the containment of an edit in
its panel, one for the weekly drift check, and one fresh general-purpose agent per blind install of round 6 (2). Editor
Claude Sonnet 5.5 (and Haiku 5.5 where named); classifier Claude Haiku 5.5, with TypeSafe's Jev (`jev-latest` =
jev-1.13.0) in the ensemble. Prompt `2026-10-19.5i` → **`2026-10-19.5j`** (the pointed-panel tail and the panel
screenshot; the instructions and the classifier prompt are unchanged). All transcripts are committed under
`evals/recordings/<set>/` with their `record.json` (now private; available on request).

| Set | What | Prompt |
|---|---|---|
| `ens-live`, `ens-awkward`, `ens-redteam` | the classifier ensemble live: demo 14, awkward 20, the 10 judgement attacks, × 1 | 5j |
| `tail-7p`, `tail-7a` | 5 shadcn-admin tasks with a 7-file zone, pointed at their panel: the pointed-panel tail and the whole zone | 5j |
| `shot-a`, `shot-b` | 10 demo and apps edits pointed at their panel, judged: without and with the panel's "before" screenshot | 5j |
| `haiku-demo`, `haiku-apps`, `haiku-awkward` | Haiku 5.5 as the editor on 14 + 35 + 20 tasks × 1 | 5j |
| `ttl-5m`, `ttl-1h` | 6 demo edits 20 minutes apart, 5-minute and 1-hour TTL of the system prefix, side by side | 5j |
| `redteam` (offline) | + `rt-r-fixed-fullscreen` (33 tasks) | 5i + 5j |

## Money

Limits: Anthropic $8, TypeSafe $1 (of the $5 TypeSafe budget for everything).

| Run | Cap | Anthropic | TypeSafe |
|---|---|---|---|
| `eval:classify` Haiku and ensemble, 159 requests × 2 each (+ a 3-probe smoke) | — | $0.054 | $0.016 |
| Ensemble live: `ens-live`, `ens-awkward`, `ens-redteam` | $1.5 | $0.602 | $0.002 |
| Pointed tail: `tail-7p`, `tail-7a` | $0.5 | $0.254 | — |
| Screenshot A/B: `shot-a`, `shot-b` and their judges | $1.5 | $0.364 | — |
| Haiku as the editor: `haiku-demo`, `haiku-apps`, `haiku-awkward` | $0.5 | $0.138 | — |
| Cache TTL: `ttl-5m`, `ttl-1h` | $0.5 | $0.300 | — |
| Weekly drift check, its live part once (`weekly-2026-10-19`, 14 × 1, not committed) | $0.3 | $0.193 | — |
| Judge calibration × 2, crm-03 re-judged × 2 | — | $0.009 | — |
| Labelling screen, containment, weekly check (offline), blind installs, sanity, replays, e2e, smoke | — | $0 | — |
| **Total reported by the APIs** | | **$1.913** | **$0.018** |

## The numbers

| Item | Result |
|---|---|
| Ensemble, `eval:classify` (318 classifications each: 60 tasks + 25 red-team and blind + 74 probes, × 2) | Haiku **305/318**, ensemble **304/318** strictly; with the tasks' `alsoAccept` 307 and **308**. Russian 56 → **57/64**, the 20 new awkward **39 → 39/40**: no loss |
| Ensemble: who decided | Jev **147 of 318** (46 %), 143 right strictly, 147 with `alsoAccept`; the rest Haiku |
| Ensemble: routing decision | median **1,372 → 1,102 ms**, p95 2,241 → 2,037 ms; when Jev decided: **298 ms** median |
| Ensemble: classifier cost | **$0.000085 → $0.000133** per request (+57 %: Jev $0.00005, Haiku still runs) |
| Ensemble live (14 demo + 20 awkward + 10 attacks) | **14/14, 19/20, 10/10** (the miss, aw-07 "this 👆", fails the same way with Haiku alone: it points at a panel, no classifier); routing median **732 / 616 ms** against **1,356 / 1,351 ms** for Haiku alone on the same tasks the same day; Jev decided 17 of 38 classified requests, all passed |
| Ensemble decision | **not the default** (below): opt-in with `PLEATKIT_CLASSIFIER_ENSEMBLE=jev` and `TYPESAFE_API_KEY` |
| Pointed-panel tail (84.5), 7-file zone, 5 tasks | pass **5/5 = 5/5**; uncached input per call **10,350 → 920 tokens**; edit cost median **$0.0300 → $0.0121** (warm: $0.0104; block 5 `zone-7`: $0.0300); **kept, the default** |
| Panel screenshot in context (17 §14), 10 edits | judge **4.2 → 4.0** (Δ −0.2, needed ≥ +0.5); input +210 to +1,060 tokens per pointed edit; cost $0.180 → $0.176 (noise); **not adopted** |
| Haiku 5.5 as the editor, 69 tasks | **68/69 = 98.6 %** (demo 14/14, apps 35/35, awkward 19/20, the same aw-07); edit cost median $0.0010 / $0.0029 / $0.0023; latency median 5.4 / 7.0 / 5.9 s, p95 12–25 s; **documented as the Free-tier and stand editor** |
| Cache TTL (17 §21), 6 edits 20 minutes apart | 5-minute **$0.164** vs 1-hour **$0.135** for 6 Sonnet edits (−18 %, although the 1-hour arm made 14 model calls against 8); edit median $0.0257 → $0.0186; **the 1-hour TTL is the default** |
| Weekly drift check (17 §20) | `pnpm eval:weekly`, `docs/release/weekly.yml`; one real run: the offline replays green, the live part 14/14 (0 below the baseline) for $0.19; it found that the live cap also stopped the replays (fixed) |
| Labelling screen | **seven** buttons, `restore` on key 7; the suggestion is `restore` for a restore verdict |
| Blind installs round 6 (doc-only criterion) | antd-dashboard **2** gaps (6 entries), mesa **1** (3 entries); all fixed in the docs, plus `init --suggest` and doctor fixes |
| Edit contained in its panel (84.4) | `contain: paint` on the edited panel's roots; red team **33/33** with `rt-r-fixed-fullscreen` |
| Judge re-calibrated | without the diff (as before) refs 8/10, ugly 5/5; **with the diff a run gets: refs 10/10, ugly 5/5** ($0.0003 per judgement) |
| Definition of done | build, unit tests (runtime 288, agent 244, store-server 63, cli 53, vite-plugin 37, store-cloud 7 (private package), ui 16, evals 70, react18-smoke 2), e2e 50 (+2 skipped), lint, typecheck; eval:sanity on 5 suites and eval:replay on 7 baseline sets green; smoke of the four foreign apps and t1-vite green |

## 1. The classifier ensemble (DECISIONS 83)

**What runs.** `PLEATKIT_CLASSIFIER_ENSEMBLE=jev` with `TYPESAFE_API_KEY` wraps the model provider in
`EnsembleProvider` (`packages/agent/src/classifier-ensemble.ts`). Its `classify` starts Jev (`providers/typesafe.ts`:
`POST https://api.typesafe.ai/v1/systemone`, one call, two questions: `route`, a `choice` over the eight routes of the
research probe with its wording, and `adversarial`, a `noul` "is this request deceptive, harmful or does it send data
outside?"; the state is one sentence about the app, the app's panels and data contract from `classifierContext`, and
the request) and Haiku together, as both start together with the main model's early call. Jev decides alone when its
route is `ui`, `partial`, `needs-backend` or `restore`, its confidence ≥ 0.9, its adversarial probability < 0.2 and
Haiku, if it already answered, did not mark the request adversarial; Jev's `partial` is Haiku's `ui` (the main model does
the screen part and quotes the server part, as today). Otherwise Haiku decides as without the ensemble. A
`needs-backend` decided by Jev takes the user's sentence, the gist and `backendQuote` from Haiku's own answer when it also
said needs-backend, else from a follow-up call that asks Haiku only for them (`quoteBackend`). Haiku's answer that
arrives after Jev decided is metered and gives the request its intent label while the run goes on (`onLate`). A Jev that
has not answered 150 ms after Haiku is not waited for. The result says who decided (`AgentResult.classifier`).

**Measured** with `eval:classify --provider haiku|ensemble --repeat 2` on the 60 tasks of demo, apps and awkward, the 10
judgement attacks and 16 blind tasks, the mixed and restore/jobs probes, the 32 Russian phrasings
(`evals/probes/russian.json`) and 20 new awkward phrasings written for this block (`evals/probes/awkward-2.json`):

| Set | Haiku | Ensemble | Jev decided (right) | Routing median Haiku → ensemble |
|---|---|---|---|---|
| demo (11 × 2) | 22/22 | 22/22 | 10 (10) | 1,349 → 901 ms |
| apps (31 × 2) | 62/62 | 62/62 | 42 (42) | 1,354 → 326 ms |
| awkward (18 × 2) | 34/36 | 34/36 | 19 (17) | 1,371 → 356 ms |
| red team, judgement (9 × 2) | 16/18 | 16/18 | 1 (1) | 1,857 → 1,487 ms |
| blind (16 × 2) | 32/32 | 30/32 | 14 (12) | 1,301 → 1,092 ms |
| mixed probes (10 × 2) | 20/20 | 20/20 | 6 (6) | 1,334 → 1,295 ms |
| restore and jobs (12 × 2) | 24/24 | 24/24 | 10 (10) | 1,584 → 1,218 ms |
| Russian (32 × 2) | 56/64 | **57/64** | 29 (29) | 1,340 → 1,151 ms |
| new awkward (20 × 2) | 39/40 | **39/40** | 16 (16) | 1,405 → 1,079 ms |
| **all** | **305/318** | **304/318** | **147 (143)** | **1,372 → 1,102 ms** |

Jev's four strict misses are two requests the tasks also accept: aw-03 "put the card back like it was before" → `restore`
(0.90–0.91; Haiku says the same) and ab-07 "make the tasks look more important" → `ui` (0.92–0.93; an edit is accepted).
The other differences are Haiku's own noise between the runs. The adversarial question kept Jev out of two mixed
requests it routed right (`aw-14` "…email me a summary every morning" 0.74, `aw-17` export to accounting 0.25): Haiku
decided them, right. Every request where Jev saw an attack (`declined` 0.87–1.0, adversarial 0.97–0.99) was left to
Haiku, as the rule says. Live, Jev decided the injection-in-data attack (`rt-j-inject-data-field`) as `ui` 0.91: right
(the request itself is benign; the main model ignored the injected text).

**Decision: the ensemble stays opt-in** (`DEFAULT_CLASSIFIER_ENSEMBLE = 'off'`). DECISIONS 83's bar for the default
(no losses on 30 Russian and 20 new awkward phrasings) is met, but the numbers give it nothing to win: (1) accuracy is
the same (Haiku on prompt 5i already routes the mixed requests that were Jev's strength: 20/20 here, against 12/30 when
the mixed probes were written); (2) the routing decision is 0.3–1 s faster only where the agent waits for it: in the
parallel mode (the default for most apps) the main model's first call starts at once either way and an edit's latency
is the main model's; (3) it sends every request's text to a second processor, which a customer's DPA must list. Where
it does help: an app the automatic mode runs `sequential` (the classifier answers most of its requests alone) saves
about a second on the ~half of its requests Jev decides, and a `restore` answer comes in 0.3 s. Documented in
ARCHITECTURE and production.md; the key is optional, without it the classifier is Haiku alone.

## 2. The pointed-panel tail (DECISIONS 84.5)

When the user points at a panel, the first message carries that panel's file and every dynamic file it imports
(relative imports followed transitively, CSS modules included); the other dynamic files are listed by name, size and
exports (`read_file` shows them). Without a pointed panel, for a migration or a revert, every file goes as before
(`tailOf` in `prompt.ts`; `PLEATKIT_TAIL=all` restores the old tail). Measured on the block-5 `zone-7` tasks with the
panel pointed (`--point`), against a control with the whole zone, same day, same pointing:

| Task | Whole zone (`tail-7a`) | Pointed panel (`tail-7p`) |
|---|---|---|
| sa-08 line chart | $0.0302, 1 call | $0.0417, 1 call (wrote the prefix cache: cold) |
| sa-09 bar chart under the list | $0.0300 | $0.0121 |
| sa-10 sort | $0.0266 | $0.0077 |
| sa-11 compact stats | $0.0353, 1 call | $0.0343, 2 calls |
| aw-14 sort + daily e-mail (partial) | $0.0276 | $0.0086 |
| **median** | **$0.0300** | **$0.0121** (warm $0.0104) |
| pass (browser graded) | 5/5 | 5/5 |

The uncached input of a call fell from 10,350 to about 920 tokens: the expected $0.030 → $0.010 of block 5 holds for
one-call edits. Kept as the default.

## 3. The panel screenshot in context (17 §14)

`AgentRunRequest.targetImage`: a "before" screenshot of the pointed panel goes to the model after the user's images with
one sentence (prompt 5j). The A/B: `shot-a` (pointed, no screenshot, judged; its "before" screenshots were then given to
`shot-b`), 10 edits (crm-01, crm-03, crm-04, crm-13, sa-03, sa-06, sa-11, ta-04, ta-05, ta-07):

| | Without | With the screenshot |
|---|---|---|
| judge mean (1–5) | **4.2** | **4.0** (crm-03 4 → 3, ta-07 5 → 4, the rest equal) |
| cost | $0.180 | $0.176 |
| input tokens per pointed edit | — | +210 (demo) to +1,060 (shadcn tasks table) |

Not adopted: no gain (needed +0.5). The field stays in the protocol; the drawer does not send it. sa-03's reference
changes a helper file, not a panel, so it was not pointed in either arm. While judging, the contrast pre-check failed
shot-b's crm-03 at 1.0:1 although the badge was legible: the pre-check parsed only `rgb()` colours and Tailwind 4's
palette computes to `oklch()`, so a green badge with white text counted as white on the white card. Fixed (any colour
through a canvas); the edit then scored 3.

## 4. Haiku 5.5 as the editor (17 §5)

| Set | Pass | Edit cost median | Latency median (p95) |
|---|---|---|---|
| `haiku-demo` | 14/14 | $0.0010 | 5.4 s (12.3 s) |
| `haiku-apps` | 35/35 | $0.0029 | 7.0 s (14.4 s) |
| `haiku-awkward` | 19/20 | $0.0023 | 5.9 s (25.1 s) |
| **all** | **68/69 (98.6 %)** | | |

The one miss is aw-07 (a screenshot and "this 👆"), which Sonnet misses the same way. Block 2's `apps-haiku` was 33/35;
with the type check in the loop since block 3 the execution errors are gone. Over the 97 % bar: Haiku is documented as
the editor for the Free tier and the built-in stand (brainstorm 16 Р6), at a tenth of Sonnet's cost and 1–2 s slower
median, with a long p95.

## 5. Cache TTL (17 §21)

Two arms side by side, each with its own prompt-cache entry (`PLEATKIT_EVAL_PREFIX_NONCE`), the same six demo edits
20 minutes apart (`--pause 1200`), classifier Haiku, the browser grader off (cost only):

| Edit (start) | 5-minute TTL (`ttl-5m`) | 1-hour TTL (`ttl-1h`) |
|---|---|---|
| crm-01 (0 min) | $0.0270, 1 call, prefix written (1.25×) | $0.0448, 2 calls, prefix written for an hour (2×) |
| crm-03 (20 min) | $0.0240, 1 call, written again | $0.0162, 2 calls, prefix read |
| crm-04 (40 min) | $0.0241, 1 call, written again | $0.0162, 2 calls, read |
| crm-10 (60 min) | $0.0244, 1 call, written again | $0.0099, 1 call, read |
| crm-13 (80 min) | $0.0346, 2 calls, written again | $0.0210, 2 calls, read |
| crm-14 (100 min) | $0.0294, 2 calls, written again | $0.0267, 5 calls, read |
| **6 edits (Sonnet)** | **$0.1635** (8 calls) | **$0.1348** (14 calls) |

The 1-hour arm was **18 % cheaper although it made 14 model calls against 8** (Sonnet's own variance). The prefix alone
(6,325 tokens): written six times at 1.25× ($0.095) against once at 2× and read 13 times ($0.042), $0.009 per edit
saved on the demo (shadcn-admin's 13k prefix: about $0.02). Every edit after the first reads the prefix within the hour:
each read refreshes the entry. **The 1-hour TTL is the default** for the system prefix (`PLEATKIT_CACHE_TTL=1h`,
`5m` restores the old one); the conversation tail stays 5-minute. It costs more only for an app whose edits are
usually more than an hour apart (each edit then writes either way, at 2× instead of 1.25×: +$0.0095 on the demo).
`expectedEditCost` prices a cold edit with the 1-hour write (`prefixTtl`), and `costUsd` prices 1-hour writes from
`cache_creation.ephemeral_1h_input_tokens` (`TokenUsage.cacheWrite1hTokens`).

## 6. Weekly drift check (17 §20)

`pnpm eval:weekly` (`evals/src/weekly.ts`, 15 unit tests): replays every set with a baseline (scripted, live, apps,
awkward, redteam) and the blind sets (offline, $0), then records the 14 demo tasks × 1 live into `weekly-<date>`
(`PLEATKIT_EVAL_BUDGET_USD`, default $0.30, above $1 only with `--force`) and compares them with `evals/baseline.json`
(the expected passes of one trial are the sum of each task's pass share). Drift: a set regressed or could not be
replayed, or the live run is two or more tasks below. It sends one `eval-drift` alert through the 4b channel
(`PLEATKIT_ALERT_WEBHOOK`, `PLEATKIT_ALERT_EMAIL_*`; new `sendAlert` in `alerts.ts`) and exits 1. `docs/release/weekly.yml`
is a GitHub Actions template (Mondays 06:00 UTC). One real run with the live part (`PLEATKIT_EVAL_BUDGET_USD=0.3`): 14/14 live, 0 below the baseline, $0.193, no alert channel configured (it printed the alert). It also showed a bug: the replays inherited the live part's dollar cap and stopped half-way (the runner counts recorded transcripts' costs), so apps and awkward looked regressed; the replays now run without the cap (`replayEnv`, a test), and the offline re-run is clean (scripted 13/14 as pinned, live 42/42, apps 70/70, awkward 31/40 as pinned, blind 16/16 × 2, red team 33/33).

## 7. Block 5 leftovers (DECISIONS 84)

- **Labelling screen** (84.2): a seventh button `restore` (key 7); a request with a `restore` verdict is suggested
  `restore`; `pleatkit labels export` writes it as a probe. e2e `stage5-labels.spec.ts` 2/2.
- **Blind installs, round 6** (84.3), counting only gaps where the agent left `docs/for-agents/` or guessed:

  | App | Entries | Counted | What counted |
  |---|---|---|---|
  | antd-dashboard | 6 | **2** | a render site that spreads props (`<StatsCard {...s} />`: `init --suggest` printed "spread props: list them"); on Windows the stopped background shells left the servers holding the ports, no command in the docs |
  | mesa | 3 | **1** | a panel cut out of page JSX that owns its own `useState` (filter, sort): where does it go |

  Fixed: install.md (props may be any object, `props={s}`, functions and components; local state moves with the panel;
  `netstat`/`taskkill` and the PowerShell line for a port still held; `React.createElement` is refused, write `<Icon />`;
  the open chat is a 420 px side panel), `pleatkit init --suggest` prints `props={s}` / `props={{ ...s, a }}` for spread
  sites, and doctor's `[FAIL] release` advice follows the rule that fired (it always gave the URL advice). Both installs
  passed doctor, ping and the offline browser edit with a reload. Zero counted gaps was not reached (2 and 1).
- **An edit is contained in its panel** (84.4, sub-agent): while a panel runs an edit, `watchEditedPanel` gives each of the
  panel's root elements `contain: paint` (the wrapper stays `display: contents`, so the host's layout is unchanged:
  measured on the five apps, 19 panels, 7,523 elements, 0 moved); a `fixed` root becomes `static`; an element under a root
  that cannot take paint containment (a table row) is contained by its nearest ancestor that can. The z-index cap stays.
  Red-team case `rt-r-fixed-fullscreen` with the browser check `containedInPanel` (fails on a build without it). Known
  cost: a dropdown inside an edited panel is clipped at the panel's edge (UI-kit popovers through a portal are not).
- **The judge re-calibrated** (84.7) on the current rubric: given the line diff a judged run gets (the calibration did
  not pass it), references 10/10 ≥ 4 and ugly edits 5/5 ≤ 2; without the diff 8/10 (sa-08 3, sa-18 "bold barely visible"
  2).

## Recommendations

1. Keep the ensemble as an option for sequential-mode apps; revisit when Haiku's routing regresses on new phrasings
   (the labelled set of DECISIONS 81).
2. The pointed-panel tail only helps pointed requests. A classifier that names the panel ("the users table") could give
   the same saving to unpointed ones, in the sequential mode where the first call waits for it; Jev's choice question is
   a free place to ask.
3. Haiku for the Free tier and the stand: measure its p95 with the warm checker on the stand's own app before launch.
4. Pin the red-team baseline with `rt-r-fixed-fullscreen` when the set is next recorded on 5j (the pin refuses mixed
   prompt versions).
