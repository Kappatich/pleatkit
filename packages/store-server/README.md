# @pleatkit/store-server

The open store of [pleatkit](https://github.com/Kappatich/pleatkit) (MIT): self-host it next to your app.

- Per-user snapshots (insert-only) and heads with compare-and-set, signed bundles served from `/v1/b`.
- The agent request log, quotas (token buckets) and per-app limits, usage events (append-only).
- The audit chain (SHA-256 per app), roles `user` / `support` / `admin`, "view as a user" (support reads, only an
  admin writes as the user; every call audited), flags and the kill switch.
- The pilot report, the wish-map store, code search and rollback by selection, release carry-over runs, export.
- Erasure: `DELETE /v1/admin/users/:id` and `DELETE /v1/admin/apps/:id` (admin, confirm token, an audit tombstone
  without personal data stays), `pleatkit erase`.
- Hono + Drizzle + SQLite (better-sqlite3), Node 22.

```bash
pnpm add @pleatkit/store-server
PLEATKIT_STORE_DB=.pleatkit/store.db npx pleatkit-store            # http://localhost:8790, demo headers in development
NODE_ENV=production PLEATKIT_APP_KEY=mk_live_… PLEATKIT_JWT_SECRET=… npx pleatkit-store
```

Your backend mints user tokens with `mintUserToken` from `@pleatkit/store-server/token`. In the app,
`new HttpStore({ baseUrl: '/pleatkit-store', userId, appId, token })` from `@pleatkit/runtime`.

**Self-host and cloud.** This package is the whole store you self-host. The managed pleatkit cloud runs the same
core plus a private package of cloud-only modules (the learning layer, later billing and region routing) that plugs
in through `StoreExtension` (`createStoreApp(db, { extensions })`); the binary loads it only when the deployment's
`package.json` depends on it (`PLEATKIT_STORE_EXTENSIONS=none` turns that off).

MIT. Changes: [CHANGELOG.md](https://github.com/Kappatich/pleatkit/blob/main/CHANGELOG.md).
