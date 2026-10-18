# Changelog

All notable changes to the morphkit packages. Versions follow semver; while they are `0.x`, a minor version may
break, and every break is marked **Breaking** with its migration step. Policy: README, "Changelog and breaking
changes". Nothing is published to npm yet; the entries below are the state of `main`.

## Unreleased (Stage 4c block 1, 2026-10-18)

### Fixed
- **Agent typecheck with an app root** (`MORPHKIT_TYPECHECK=1` + `MORPHKIT_TYPECHECK_ROOT`): relative imports inside
  packages' own `.d.ts` (`react/jsx-runtime`) now resolve on disk. Before, React's JSX types were lost, every element
  was `any` and `key` on a component was a type error, so edits to list-rendering panels were refused.

### Changed
- Agent instructions: three examples and three anti-examples; `PROMPT_VERSION` `2026-10-18.4c1`. Eval report:
  `evals/report/index.html` (`docs/evals.md`).

## Unreleased (Stage 4a, 2026-10-18)

### Added
- **Server compile (default).** `morphkit({ compile: 'server' | 'browser' })`, default `server`: the agent server
  compiles, checks, signs and stores each edit; the browser loads it from `/morphkit/b/<app>/<key>.js` with SRI.
  No `blob:` and no WebAssembly in the CSP. `compile: 'browser'` keeps the esbuild-wasm path and falls back to the
  server when WebAssembly cannot load. Agent routes `POST /agent/v1/compile`, `GET /agent/v1/b/<app>/<file>`;
  store-server `GET /v1/b/<app>/<file>` (public, immutable).
- **Signed bundles.** ed25519 signatures with a key derived from the app key; `morphkit({ publicKey })` or
  `MORPHKIT_PUBLIC_KEY` at build time makes the runtime refuse unsigned or altered bundles.
- **Production auth.** App keys (`mk_live_…`) and 15-minute HS256 user tokens (`mintUserToken`, exported from
  `@morphkit/store-server/token` and `@morphkit/runtime/security`); `HttpStore({ token })`,
  `<MorphkitChat token>`, `<MorphkitProvider token>`. `morphkit keys new | public`.
- **Quotas** per edit, per user and per app per day, as per-app plan data (`PUT /v1/admin/plan`); off-topic
  requests refused by the classifier (verdict `refused`).
- **Reliability:** safe mode (`?morphkit=safe`, automatic after a load that did not mount), rollback only for
  errors with edit frames, input and scroll state kept across swaps, per-file release carry-over with per-panel
  `stale`, per-app registries and stylesheets, lazy externals, `//# sourceURL=morphkit://…` and
  `engine.tags()` / `useMorphkitTags()`.
- **Foundations:** org/region/environment on every row, append-only usage events and audit chain, Idempotency-Key
  on writes and agent runs, flags and a kill switch (`morphkit.enabled`, `edits.enabled`), `morphkit export`,
  opt-out anonymous telemetry (no collector configured yet), `promptVersion` on requests.
- AI disclaimer line in the chat drawer (en/ru).

### Changed
- **Breaking (configuration):** with the default `compile: 'server'`, apps need a `/morphkit/b` proxy (to the
  agent's `/agent/v1/b`, or store-server's `/v1/b`). Migration: add the proxy from `docs/for-agents/install.md`
  step 3, or set `compile: 'browser'` to keep the previous behaviour.
- **Breaking (servers):** with `NODE_ENV=production`, store-server and the agent server refuse to start without
  `MORPHKIT_APP_KEY` and `MORPHKIT_JWT_SECRET`; demo headers work only outside production. Migration:
  `npx morphkit keys new`, then mint user tokens in your backend.
- The store API moved under `/v1/` (unversioned routes still answer). `HttpStore` and the chat use `/v1`.
- Compiled bundles reach host modules through `globalThis.__morphkit.apps[<appId>]`; bundle keys changed
  (format 3), so existing caches are rebuilt once.
- Peer ranges: React `^18 || ^19`, Vite `^6 || ^7 || ^8`; `@morphkit/vite-plugin` pins esbuild `0.28.2` (was `^0.25`).
- `morphkit doctor` checks the CSP for the configured compile mode and accepts React 18.

### Fixed
- One user could plant a bundle in another user's bundle cache (shared per app, first write wins): browser-made
  bundles are now private to their user; only signed server bundles are shared.
- `morphkit doctor` misread a CSP `<meta content="…">` that contains single quotes.

## 0.1.0 (Stages 1 to 3b, 2026-10-17/18)

First working version: zones and manifest (Vite plugin), runtime with snapshots, undo/redo and esbuild-wasm,
agent server with Anthropic / OpenAI-compatible / scripted providers and static rules, chat UI (screenshots,
clarifying question, en/ru), store-server with request log, moderation and admin dashboard, `morphkit doctor`
and `ping`, docs for coding agents. Details: `docs/DEVLOG.md`.
