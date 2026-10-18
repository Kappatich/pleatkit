# AGENTS.md

For coding agents working in this repository (DECISIONS 43: under 200 lines). For agents installing pleatkit into
another app, read [`docs/for-agents/AGENTS.md`](docs/for-agents/AGENTS.md) instead.

## Read first, in this order

1. `docs/V1.md`: what is in scope now (the frozen v1) and what is not.
2. `docs/DECISIONS.md`: numbered decisions; later ones override earlier ones.
3. `docs/ARCHITECTURE.md`: how it works today. If your change deviates, edit ARCHITECTURE.md in the same commit.
4. `docs/DEVLOG.md`: what each stage did, its numbers and its open questions (newest at the end).
5. The brainstorm your task cites (`docs/brainstorm/NN-*.md`).

## The monorepo

| Path | What | Notes |
|---|---|---|
| `packages/runtime` | browser runtime: engine, `check` (shared with the server), loader, stores, React bindings | MIT; no Node APIs in `src/` |
| `packages/agent` | agent server: model loop, tools, providers, bundle signing, alerts | MIT |
| `packages/store-server` | snapshots, heads, request log, quotas, audit, facts | private (pleatkit-cloud) |
| `packages/vite-plugin` | zones, manifest, digests, externals | MIT |
| `packages/ui` | chat drawer | the architect owns the look; ask before touching |
| `packages/cli` | doctor, ping, keys, export, check-snapshots | MIT |
| `apps/demo-crm` | the demo app and all e2e tests | Playwright, headless only |
| `examples/t1-vite` | the install docs, followed into a fresh Vite app | `pnpm build && pnpm smoke` |
| `site/` | the landing page | the architect owns it |

## Commands

```bash
pnpm install && pnpm build && pnpm test && pnpm e2e && pnpm lint   # the definition of done
pnpm typecheck
pnpm dev                                                         # demo + agent + store, one command
cd examples/t1-vite && pnpm build && pnpm smoke                    # the docs still work
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
- Write the DEVLOG section of your stage with numbers, deviations and open questions; record cost and model.

## Where things are

- Wire protocol browser ↔ agent: `packages/runtime/src/protocol.ts`.
- The one `check`: `packages/runtime/src/compiler.ts` (`Compiler.compile`) + `check.ts` (rules).
- Server trust: the agent takes context, readonly sources and types from `PLEATKIT_MANIFEST` (`packages/agent/src/manifest.ts`).
- Incidents: `docs/ops/incident.md`. Production setup: `docs/for-agents/production.md`.
