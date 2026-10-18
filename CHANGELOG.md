# Changelog

All notable changes to the pleatkit packages. Versions follow semver; while they are `0.x`, a minor version may
break, and every break is marked **Breaking** with its migration step. Policy: README, "Changelog and breaking
changes". Nothing is published to npm yet; the entries below are the state of `main`.

## Unreleased (rename to pleatkit, 2026-10-18)

### Renamed
The product is now **pleatkit** (DECISIONS 66, 68); the repositories are `Kappatich/pleatkit` and the private
`Kappatich/pleatkit-cloud`. **Breaking** for code that uses the new names only after the next release; until then
every old name below keeps working:

- Packages `@morphkit/*` → `@pleatkit/*`; CLI binary `morphkit` → `pleatkit`, `morphkit-agent` → `pleatkit-agent`
  (the old binary names stay as aliases for one release); store-server binary `pleatkit-store`.
- Identifiers `Morphkit*` / `useMorphkit*` / `morphkit()` / `MORPHKIT_FRAME` → `Pleatkit*` / `usePleatkit*` /
  `pleatkit()` / `PLEATKIT_FRAME`. The old names are exported as `@deprecated` aliases from `@pleatkit/runtime`,
  `@pleatkit/runtime/compiler`, `@pleatkit/ui` and `@pleatkit/vite-plugin` (named export `morphkit`).
- Environment variables `MORPHKIT_*` → `PLEATKIT_*`. The old names are read when the new one is unset, with one
  deprecation line at startup (`pleatkitEnv` in `@pleatkit/runtime/env`).
- Virtual modules `virtual:morphkit/*` → `virtual:pleatkit/*` (old ids resolve, with a warning); build output
  `dist/pleatkit.manifest.json`, `assets/pleatkit-isolated-host-*.js`; bundle frames `pleatkit://`; bundle URL
  `/pleatkit/b/`; demo token route `/api/pleatkit-token`.
- DOM attributes `data-morphkit-*` → `data-pleatkit-*` (`data-pleatkit-private`, `-id`, `-ui-layer`, `-bundle`,
  `-css`, `-modified`, `-stale`, …); test ids `pleatkit-isolated-*`. Request headers `x-morphkit-*` →
  `x-pleatkit-*`; store-server accepts the old headers for one release.
- Browser storage: IndexedDB `morphkit` → `pleatkit` (and `morphkit-<x>` → `pleatkit-<x>`) is copied once into
  the new database; the safe-mode record `morphkit:boot:*` moves to `pleatkit:boot:*`; `?morphkit=safe` still
  works; the kill switch also honours a stored `morphkit.enabled: false`; `~/.morphkit` telemetry id carries over.
- Unchanged: the app key prefix `mk_live_` (existing keys stay valid), CSS classes `.mk-*` and tokens `--mk-*`.
- `PROMPT_VERSION` `2026-10-18.4c1.pleatkit` (the instructions name the product); replay 13/14, as before.

Migrating an existing install:

```bash
pnpm remove @morphkit/runtime @morphkit/ui @morphkit/vite-plugin @morphkit/agent @morphkit/cli
pnpm add @pleatkit/runtime @pleatkit/ui && pnpm add -D @pleatkit/vite-plugin @pleatkit/agent @pleatkit/cli
grep -rl morphkit src vite.config.* tsconfig*.json | xargs sed -i 's/@morphkit/@pleatkit/g; s/Morphkit/Pleatkit/g; s/morphkit/pleatkit/g'
sed -i 's/^MORPHKIT_/PLEATKIT_/' .env      # and the same in the servers' secret store; keys are unchanged
pnpm build && pnpm exec pleatkit doctor   # no [FAIL]; the agent prints no deprecation line
```

## Unreleased (Stage 4c block 1, 2026-10-18)

### Fixed
- **Agent typecheck with an app root** (`PLEATKIT_TYPECHECK=1` + `PLEATKIT_TYPECHECK_ROOT`): relative imports inside
  packages' own `.d.ts` (`react/jsx-runtime`) now resolve on disk. Before, React's JSX types were lost, every element
  was `any` and `key` on a component was a type error, so edits to list-rendering panels were refused.

### Changed
- Agent instructions: three examples and three anti-examples; `PROMPT_VERSION` `2026-10-18.4c1`. Eval report:
  `evals/report/index.html` (`docs/evals.md`).

## Unreleased (Stage 4a, 2026-10-18)

### Added
- **Server compile (default).** `pleatkit({ compile: 'server' | 'browser' })`, default `server`: the agent server
  compiles, checks, signs and stores each edit; the browser loads it from `/pleatkit/b/<app>/<key>.js` with SRI.
  No `blob:` and no WebAssembly in the CSP. `compile: 'browser'` keeps the esbuild-wasm path and falls back to the
  server when WebAssembly cannot load. Agent routes `POST /agent/v1/compile`, `GET /agent/v1/b/<app>/<file>`;
  store-server `GET /v1/b/<app>/<file>` (public, immutable).
- **Signed bundles.** ed25519 signatures with a key derived from the app key; `pleatkit({ publicKey })` or
  `PLEATKIT_PUBLIC_KEY` at build time makes the runtime refuse unsigned or altered bundles.
- **Production auth.** App keys (`mk_live_…`) and 15-minute HS256 user tokens (`mintUserToken`, exported from
  `@pleatkit/store-server/token` and `@pleatkit/runtime/security`); `HttpStore({ token })`,
  `<PleatkitChat token>`, `<PleatkitProvider token>`. `pleatkit keys new | public`.
- **Quotas** per edit, per user and per app per day, as per-app plan data (`PUT /v1/admin/plan`); off-topic
  requests refused by the classifier (verdict `refused`).
- **Reliability:** safe mode (`?pleatkit=safe`, automatic after a load that did not mount), rollback only for
  errors with edit frames, input and scroll state kept across swaps, per-file release carry-over with per-panel
  `stale`, per-app registries and stylesheets, lazy externals, `//# sourceURL=pleatkit://…` and
  `engine.tags()` / `usePleatkitTags()`.
- **Foundations:** org/region/environment on every row, append-only usage events and audit chain, Idempotency-Key
  on writes and agent runs, flags and a kill switch (`pleatkit.enabled`, `edits.enabled`), `pleatkit export`,
  opt-out anonymous telemetry (no collector configured yet), `promptVersion` on requests.
- AI disclaimer line in the chat drawer (en/ru).

### Changed
- **Breaking (configuration):** with the default `compile: 'server'`, apps need a `/pleatkit/b` proxy (to the
  agent's `/agent/v1/b`, or store-server's `/v1/b`). Migration: add the proxy from `docs/for-agents/install.md`
  step 3, or set `compile: 'browser'` to keep the previous behaviour.
- **Breaking (servers):** with `NODE_ENV=production`, store-server and the agent server refuse to start without
  `PLEATKIT_APP_KEY` and `PLEATKIT_JWT_SECRET`; demo headers work only outside production. Migration:
  `npx pleatkit keys new`, then mint user tokens in your backend.
- The store API moved under `/v1/` (unversioned routes still answer). `HttpStore` and the chat use `/v1`.
- Compiled bundles reach host modules through `globalThis.__pleatkit.apps[<appId>]`; bundle keys changed
  (format 3), so existing caches are rebuilt once.
- Peer ranges: React `^18 || ^19`, Vite `^6 || ^7 || ^8`; `@pleatkit/vite-plugin` pins esbuild `0.28.2` (was `^0.25`).
- `pleatkit doctor` checks the CSP for the configured compile mode and accepts React 18.

### Fixed
- One user could plant a bundle in another user's bundle cache (shared per app, first write wins): browser-made
  bundles are now private to their user; only signed server bundles are shared.
- `pleatkit doctor` misread a CSP `<meta content="…">` that contains single quotes.

## 0.1.0 (Stages 1 to 3b, 2026-10-17/18)

First working version: zones and manifest (Vite plugin), runtime with snapshots, undo/redo and esbuild-wasm,
agent server with Anthropic / OpenAI-compatible / scripted providers and static rules, chat UI (screenshots,
clarifying question, en/ru), store-server with request log, moderation and admin dashboard, `pleatkit doctor`
and `ping`, docs for coding agents. Details: `docs/DEVLOG.md`.
