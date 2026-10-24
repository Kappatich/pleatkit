# Changelog

All notable changes to the pleatkit packages. Versions follow semver; while they are `0.x`, a minor version may
break, and every break is marked **Breaking** with its migration step. Policy: README, "Changelog and breaking
changes". Nothing is published to npm yet. 0.3.0 is the first public release; it contains everything below, the
"Unreleased" sections included (they are the stages that led to it).

## 0.4.0 (unreleased)

The open-core boundary (DECISIONS 89): the open packages keep what you need to install pleatkit and to trust it (the
agent and its edit loop, the checks, the drawer, versions and undo, the request log with approve/reject/rollback,
roles `user` and `admin`, quotas and plans, usage events, the audit chain, flags and the kill switch, export, erasure,
request labels); what a vendor needs across all of its customers moves to the private pleatkit cloud packages
(`@pleatkit/store-cloud`, `@pleatkit/agent-cloud`, `@pleatkit/admin-cloud`). Every package is 0.4.0.

### Breaking (self-hosters)
- **store-server: routes removed.** `GET /v1/report` (the pilot report and its money columns, with
  `PLEATKIT_REPORT_MINUTES_PER_EDIT` and the `reportMinutesPerEdit` option), `/v1/admin/wish-items`,
  `GET|PUT /v1/admin/wishes`, `/v1/admin/releases*` (list, get, start, items, finish, rollback),
  `GET /v1/admin/snapshots?grep=` and `POST /v1/admin/snapshots/rollback` now answer 404. The exports `buildReport`,
  `reportCsv`, `REPORT_COLUMNS`, `CARRY_OVER_PREFIX`, `grepSnapshots`, `planSelectionRollback`, `WishCluster` and the
  schema tables `releases`, `release_items`, `wish_maps` are gone. A 0.3 database keeps those tables, but the open
  store no longer creates them and its erasure no longer reaches them: drop them (`DROP TABLE releases;
  DROP TABLE release_items; DROP TABLE wish_maps;`) if you used them.
- **The `support` role and "view as a user" are refused.** The open store knows the roles `user` and `admin`. A user
  token with another role (`support`), a development `x-pleatkit-role: support` header, or any
  `x-pleatkit-act-as` header gets 403 `{ "code": "cloud-feature" }` unless a store extension provides them. A token
  with an unknown but well-formed role is now 403 `cloud-feature` instead of 401. `UserRole` is `'user' | 'admin'`
  plus any lowercase role word for extensions. `HttpStore`'s `viewer` option is gone (pass `headers`).
- **CLI commands moved.** `pleatkit digest` and `pleatkit carry-over` are removed from `@pleatkit/cli` (they are
  `pleatkit-ops digest|carry-over` in the cloud). `pleatkit report` (the bug report), `pleatkit erase` and
  `pleatkit check-snapshots` stay.
- **agent: the wish map, digest and bulk carry-over are gone.** `POST /agent/v1/wishes` answers 404;
  `PLEATKIT_WISHES_MAX_ITEMS` / `PLEATKIT_WISHES_BUDGET_USD` and the `wishes` option are removed, as are the exports
  of `wishes.ts`, `digest.ts` and `carry-over.ts`. `ModelProvider.cluster` and `clusterModel` are replaced by the
  generic `completeJson(call, signal)` and `classifierModel`; scripted fixtures no longer have a `wishes` key
  (extra keys are kept for extensions); the `digest` alert kind is now `summary`.
- **The demo admin** shows requests, labels, flags, events, audit and plan; the Wishes, Releases and code-search
  screens, the report half of the Plan screen and the `?as=support` view are gone.
- **Migration:** use the pleatkit cloud for these features, or stay on the `v0.3.0` git tag.

### Added
- `StoreExtension` gets `roles`, `actAs(who, target)`, `adminAccess(who, method, path)` and `middleware(api, ctx)`;
  `ExtensionContext` gets `event`, `outcome` and `setHead`. `AuthError` carries a `code`; `CLOUD_FEATURE` is exported.
- `AgentExtension { name, routes(app, ctx) }` and `createAgentApp({ extensions })`: the context has the provider, the
  store URL and client, `fetch`, `log`, `manifest(appId)`, `adminApp(c, body)`, `appKey(appId)` and
  `reportUsage(appId, events)`. `pleatkit-agent` loads `PLEATKIT_AGENT_EXTENSIONS` (`none`, a module list, or
  `@pleatkit/agent-cloud` when the deployment's `package.json` depends on it), like the store's
  `PLEATKIT_STORE_EXTENSIONS`.
- `ModelProvider.completeJson({ name, instructions, message, schema, maxTokens, scripted? })`: one structured call
  on the classifier model outside the edit loop (Anthropic structured output, OpenAI-compatible JSON mode, scripted
  through the call's own `scripted(fixtures)`, recorded as a `kind: 'json'` transcript line and replayed).

### Changed
- ui: design v4 warm. The chat drawer takes the landing page's v4 look through its `--mk-*` tokens (light and dark,
  `data-mk-theme="dark"` as before): warm paper and ink, no pure black or white, a paper gradient on the drawer, a red
  square before the title, the version button as a pill (red wash with a dot when there are changes), the request as a
  dark gradient bubble, the result as a card with a round check, the live step as a pill with a pulsing dot, pill
  chips, 4px buttons, a 12px composer with a soft shadow and a red gradient send button. The drawer now uses the host
  app's font (it set Helvetica before); mono is a JetBrains Mono stack, still without loading fonts. Class names, test
  ids, the mobile bottom sheet and reduced motion are unchanged. The demo's /admin and dashboard panels follow (8px
  panes with a soft shadow, tinted table headers, status pills), and the demo darkens with `data-mk-theme="dark"`.
- demo video: real sound samples instead of the synthesized track, and a new closing card (76 s, 8.7 MB, a fresh
  take). `scripts/record-demo.mjs` mixes WAV samples from `apps/demo-crm/e2e/sounds/` (`<kind>-<n>.wav`, 48 kHz mono,
  peak -6 dBFS, read in Node without dependencies) at the same event times: five keystrokes from a recorded
  mechanical keyboard, never the same one twice in a row and ±1.5 dB each (typing peaks at -26 dBFS), a UI click,
  Material Design transition sounds for the drawer and the camera moves (-24 and -26 dBFS), a two-note Material
  confirmation when the change lands and a warmer one on the closing card (-18 dBFS), and a soft low impact for the
  title bands and the plates. The generators are gone; the mix still peaks at or below -12 dBFS (it peaks at -18)
  and the script now prints each kind's peak. Sources are CC0 (Kenney, unicaegames on OpenGameArt) and CC BY 4.0
  (Google's Material Design product sounds); `docs/sounds/CREDITS.md` lists every file with its pack, author,
  license and the attribution text. The closing card reads "pleatkit.com" and "your customers change their own
  screens by asking" instead of "open source · MIT"; the landing page loads the film as `demo.mp4?v=v6`.
- demo video re-shot (78 s, 8.5 MB): show, don't tell. The camera now lives inside the page (the app and the
  drawer are wrapped in one element that is translated and scaled with a CSS transition, so a zoom is real pixels):
  it zooms on the launcher, the composer while the request is typed, the customer card while it changes and the
  undo and redo buttons, and pulls back to the whole page in between. The app, the drawer and the admin view are each
  introduced once by a plate (everything else dimmed, a large title in the dark part), then a thin red frame with one
  name tag stays while the whole area is in view. While the card changes, everything else is blurred with four
  backdrop-blurred rects. Four bottom captions and the closing card replace the pill labels; the persona is not named
  in the film, and the note that the agent's answers are recorded moved to the closing card. A soft whoosh per
  camera move and a low thud per plate join the synthesized track (peak checked at or below -12 dBFS); the poster is
  the zoomed changed card. Typing is paced by the wall clock, and the drawer is opened once before the start mark, so
  the film keeps its length on a loaded machine.
- demo video re-recorded on design v4, with sound and labels. `pnpm demo:video` now records a 74 s film (the limit
  in `scripts/record-demo.mjs` is 90 s and 20 MB): a visible 26 px pointer with a ripple on every click, motion labels
  for the customer's app, the pleatkit drawer and the admin view, the panels that do not change blurred while the
  agent works, a flash on the changed card, full-frame title bands between the scenes and a closing card. The sound
  track (key ticks, clicks, the drawer swish, an applied whoosh and chime, the band swell) is synthesized in the
  script from the spec's event timeline (`docs/.video/events.json`), with no samples or downloads, and muxed as AAC;
  the landing's `<video>` stays muted until the viewer unmutes it. Same five beats and scripted provider as before.

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
