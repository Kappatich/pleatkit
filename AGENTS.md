# AGENTS.md

For coding agents (and people) working in this repository; keep it under 200 lines. For agents installing pleatkit
into another app, read [`docs/for-agents/AGENTS.md`](docs/for-agents/AGENTS.md) instead.

## Read first, in this order

1. `docs/ARCHITECTURE.md`: how it works today. If your change deviates, edit ARCHITECTURE.md in the same commit.
2. `docs/evals.md`: how the agent is measured (suites, graders, replay, the eval rule for prompt and model changes).
3. `CHANGELOG.md`: what changed and what broke, newest first; `docs/ROADMAP.md` for what comes next.
4. The latest report of the area you touch: `evals/REPORT-*.md` for the agent, prompts and models; the package's
   `README.md` and its tests otherwise.

Comments cite internal numbering such as "DECISIONS 70.1" or "brainstorm 05 #4": those are the maintainers' design
notes, kept private; the code, the tests and the docs above are the source of truth.

## The monorepo

| Path | What | Notes |
|---|---|---|
| `packages/runtime` | browser runtime: engine, `check` (shared with the server), loader, stores, React bindings | MIT; no Node APIs in `src/` |
| `packages/agent` | agent server: model loop, tools, providers, bundle signing, alerts | MIT |
| `packages/store-server` | the open store: snapshots, heads, request log, quotas, audit, roles, releases, erasure; `StoreExtension` | MIT, published |
| `packages/vite-plugin` | zones, manifest, digests, externals | MIT |
| `packages/ui` | chat drawer | the architect owns the look; ask before touching |
| `packages/cli` | doctor, ping, keys, export, check-snapshots, report, digest, carry-over | MIT |
| `apps/demo-crm` | the demo app and all e2e tests | Playwright, headless only |
| `examples/t1-vite` | the install docs, followed into a fresh Vite app | `pnpm build && pnpm smoke` |
| `site/` | the landing page | the architect owns it |

## Commands

```bash
pnpm install && pnpm build && pnpm test && pnpm e2e && pnpm lint   # the definition of done
pnpm typecheck
pnpm dev                                                         # demo + agent + store, one command
cd examples/t1-vite && pnpm build && pnpm smoke                    # the docs still work
node scripts/release-check.mjs                                   # before a release: versions, metadata, dry-run publish
```

No model key is needed: the agent runs the `scripted` provider (recorded answers in `apps/demo-crm/e2e/fixtures/agent`).
`pnpm agent:live` and `pnpm e2e:live` need `PLEATKIT_API_KEY` and spend money; never run them without being asked.

## Rules

- Keys never in the repository, a `VITE_` variable or a log. `.env` is never committed.
- `git add` with explicit paths; other people's uncommitted files may be in the tree.
- Every behaviour change has a test; keep every existing test green. Security rules get a bypass case in
  `packages/runtime/test/check.test.ts`.
- The static rules, auth, signatures, quotas, schema and the system prompt are CODEOWNERS paths (`.github/CODEOWNERS`):
  keep those diffs small and explain them.
- A prompt or model change comes with an eval report (`pnpm eval:replay && pnpm eval:report`, `docs/evals.md`), and bumps `PROMPT_VERSION`.
- Headless browsers only; never play sound; stop only processes you started.
- Add a `CHANGELOG.md` entry for user-visible changes (mark breaks **Breaking** with the migration step); a change
  measured with a model records its numbers, cost and model in an eval report.

## Where things are

- Wire protocol browser ↔ agent: `packages/runtime/src/protocol.ts`.
- The one `check`: `packages/runtime/src/compiler.ts` (`Compiler.compile`) + `check.ts` (rules).
- Server trust: the agent takes context, readonly sources and types from `PLEATKIT_MANIFEST` (`packages/agent/src/manifest.ts`).
- Incidents: `docs/ops/incident.md`. Production setup: `docs/for-agents/production.md`. Support: `docs/support-playbook.md`.
- Roles and impersonation: `packages/store-server/src/auth.ts`; /admin screens: `apps/demo-crm/src/core/Admin*.tsx`.
