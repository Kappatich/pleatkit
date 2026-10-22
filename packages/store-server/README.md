# @pleatkit/store-server

The open store of [pleatkit](https://github.com/Kappatich/pleatkit) (MIT): self-host it next to your app.

- Per-user snapshots (insert-only) and heads with compare-and-set, signed bundles served from `/v1/b`.
- The agent request log, quotas (token buckets) and per-app limits, usage events (append-only).
- The request log with approve, reject and rollback, request labels, the audit chain (SHA-256 per app), roles
  `user` and `admin`, flags and the kill switch, export.
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
core plus a private package, `@pleatkit/store-cloud`, that plugs in through `StoreExtension`
(`createStoreApp(db, { extensions })`: tables, routes, middleware, extra roles, acting as a user, jobs, erasure
hooks) and adds the pilot report (`GET /v1/report`), the wish map, release carry-over runs, code search with
rollback by selection, the `support` role with "view as a user", and the learning layer. The binary loads it only
when the deployment's `package.json` depends on it (`PLEATKIT_STORE_EXTENSIONS=none` turns that off). Without it
those routes answer 404, and a role other than `user`/`admin` or an `x-pleatkit-act-as` header gets 403
`{ code: 'cloud-feature' }`.

MIT. Changes: [CHANGELOG.md](https://github.com/Kappatich/pleatkit/blob/main/CHANGELOG.md).
