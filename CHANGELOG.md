# Changelog

All notable changes to the pleatkit packages. Versions follow semver; while they are `0.x`, a minor version may
break, and every break is marked **Breaking** with its migration step. Policy: README, "Changelog and breaking
changes". Nothing is published to npm yet. 0.3.0 is the first public release; it contains everything below, the
"Unreleased" sections included (they are the stages that led to it).

## 0.3.0 (prepared 2026-10-18, not published yet; numbered 0.3.0 at the founder's request, there was no 0.2.0)

### Added
- **The store is open source.** `@pleatkit/store-server` is MIT and published (DECISIONS 70.1): snapshots, heads,
  bundles, the request log, quotas and per-app limits, usage events, the audit chain, roles and "view as", flags and
  the kill switch, the report, releases and carry-over runs, code search, export, erasure. Self-host: the open
  store. Cloud: the same core plus the private `@pleatkit/store-cloud`, which plugs in through `StoreExtension`
  (`createStoreApp(db, { extensions })`: tables, routes, jobs, hooks); `runMaintenance` runs the core's and the
  extensions' hourly jobs; the `pleatkit-store` binary loads `PLEATKIT_STORE_EXTENSIONS` (`none` for the open core
  only; unset: `@pleatkit/store-cloud` when the deployment's `package.json` depends on it).
- **Erasure** (DECISIONS 70.2): `DELETE /v1/admin/users/:id` and `DELETE /v1/admin/apps/:id`, admin only, with a
  confirm token for the counts shown (409 `confirm-required` without it); one transaction deletes the subject's
  snapshots, heads, requests, usage events, bundles, run records, idempotent replies, quota buckets, flags,
  carry-over rows, wish-map references and the extensions' rows; an audit tombstone (`erase.user` / `erase.app`,
  counts, a random id, no personal data) stays. `pleatkit erase --user <id> --app <id> | --app <id> [--confirm]`.
  `docs/security/retention.md` and the DPA template's erasure clause (section 10).
- **Wish map limits** (DECISIONS 70.3): one clustering call reads at most 500 requests (the newest) and costs at
  most $0.50 by the estimate before the call; what does not fit the budget is grouped without the model.
  `PLEATKIT_WISHES_MAX_ITEMS`, `PLEATKIT_WISHES_BUDGET_USD`, `pleatkit digest --wishes-max-items
  --wishes-budget-usd`; `GET /v1/admin/wish-items?limit=` (default 500, at most 2000) also returns `total`.
  `ModelProvider.clusterModel` (optional) names the model the estimate prices.
- `scripts/release-check.mjs`: build, tests, the version matrix, package metadata and a dry-run publish.
- A README and the MIT `LICENSE` in every public package.

### Changed
- **Breaking (support role):** `x-pleatkit-act-as` writes are for `admin` only (DECISIONS 70.5); a `support` token
  gets 403 `support-read-only` on every write while acting as a user (reads unchanged), and the refused attempt is
  audited. Migration: support asks an admin, or the user restores the version in the drawer.
- **Carry-over cap per user** (DECISIONS 70.4): without `--per-user-usd`, `pleatkit carry-over` caps each migration
  at the `perEditUsd` of the app's plan in store-server (else `PLEATKIT_PLAN` / `PLEATKIT_LIMITS`, else `free`); the
  command prints the cap and where it came from.
- **Breaking (store, cloud-only data):** the learning layer moved to `@pleatkit/store-cloud`: `request_facts`,
  `app_salts`, `PUT /v1/admin/learning`, the `learning` field of `/v1/admin/settings` and `PLEATKIT_LEARNING`. The
  open store has none of them (they were `off` by default); the flag now lives in `learning_settings` and is copied
  from the old `app_settings.learning` column once. `applyRetention` no longer deletes facts (`applyFactsRetention`
  in the cloud package). `sweepAlive24h` takes an `onAlive` callback instead of writing facts.
- `GET /v1/admin/wish-items` filters in SQL (it used to read 2000 rows and filter them), newest first.
- Package builds empty `dist` first, so a removed module never ships from an old build.

### Fixed
- **A compiled bundle is in the store before "compiled" is answered** (DECISIONS 70.8): the agent server cached a
  bundle before store-server had it, so a second compile of the same key answered at once and the browser could ask
  for a bundle the store did not have yet; a failed store write stayed cached and was never retried. Compiles of one
  key now wait for one store write, and a failed write is not cached.
- The weekly digest and the wish map read the store's range up to and including the current millisecond (`to` is
  exclusive), so a request logged in the same millisecond is counted.

### Removed
- **Breaking:** the compatibility names of the rename (DECISIONS 69), kept for one release only: the `Morphkit*`
  aliases (`MorphkitEngine`, `MorphkitProvider`, `useMorphkit*`, `MorphkitUiRoot`, `MORPHKIT_FRAME`, the
  `Morphkit*` types; the named `morphkit` export of the Vite plugin), the `morphkit` and `morphkit-agent` binaries,
  `virtual:morphkit/*`, the `x-morphkit-*` request headers, the `MORPHKIT_*` environment fallback and
  `@pleatkit/runtime/env` (`pleatkitEnv`), the `morphkit.enabled` kill-switch key, `?morphkit=safe`, the
  `morphkit:boot:*` migration, the one-time copy of IndexedDB `morphkit*` and the `~/.morphkit` telemetry id.
  Nothing was published under the old name; migration: the recipe under "Renamed" below. The three aliases in
  `@pleatkit/ui` (`MorphkitChat`, `MorphkitChatProps`, `useMorphkitUiStyles`) go with `docs/release/ui-0.2.patch`.

## Unreleased (stage 4c block 2, 2026-10-18)

### Added
- **Roles** `support` and `admin` in user tokens (`mintUserToken({ role })`). `support` reads everything under
  `/v1/admin` except the export and changes nothing there. **Impersonation**: `x-pleatkit-act-as: <user>` with a
  support or admin token (`new HttpStore({ userId, viewer, token })`) reads and writes that user's version; every
  such call is written to the audit chain with both ids (`impersonate.read|write`). `docs/support-playbook.md`.
- **Pilot report** `GET /v1/report?from&to`: CSV per day and organization (requests by verdict, applied, undone,
  rolled back, live after 24 h, carry-overs, cost, users, orgs) and a total; `&format=json`.
- **Wish map**: `POST /agent/v1/wishes` and the weekly digest group the requests the panels could not serve into
  themes per panel with one classifier call (`ModelProvider.cluster`, optional; scripted fixtures take `wishes`),
  stored in store-server (`GET|PUT /v1/admin/wishes`, `GET /v1/admin/wish-items`).
- **Code search** `GET /v1/admin/snapshots?grep=` and **rollback by selection** `POST /v1/admin/snapshots/rollback
  { grep, confirm }` (each matching live version goes to the user's nearest earlier version without the text).
- **Bulk carry-over** after a release: `pleatkit carry-over --release <hash> --budget-usd <n>` (no model where the
  release did not touch the user's files, the agent where it did, never past the budget, resumable, `--dry-run`,
  `--retry`, `--rollback`); store-server keeps runs (`/v1/admin/releases`). `manifestReleaseHash` in
  `@pleatkit/runtime/compiler`.
- `pleatkit digest --week` (markdown; `--send` through `PLEATKIT_ALERT_WEBHOOK` / `PLEATKIT_ALERT_EMAIL_*`),
  `pleatkit report` (a bug report with secrets redacted). Alert kind `digest`.
- `providerFromEnv` in `@pleatkit/agent`. `SECURITY.md`, `SUPPORTED.md`, `docs/ROADMAP.md`, issue templates,
  `docs/security/*` and the pilot agreement drafts for counsel (internal drafts, not in this repository).

### Changed
- **Breaking (docs and the example, not the API):** the install guide and `examples/t1-vite` use `HttpStore` with
  store-server by default (`pnpm store`, a `/pleatkit-store` proxy, `/pleatkit/b` pointed at store-server).
  `LocalStore` stays for a quick look. Existing installs keep working as they are.

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
and `ping`, docs for coding agents. Details: the internal development log (not in this repository).
