# Taking morphkit to production

After [install.md](install.md) works on a developer machine (LocalStore, scripted or real model, no credentials), this is the path to real users. Each step: what to set, how to check it.

## 1. Pieces and where they run

| Piece | Runs | Holds |
|---|---|---|
| your app (Vite build) | CDN / your web server | the manifest (`dist/morphkit.manifest.json`), the public key of the app key |
| your backend | your servers | the user-JWT secret; mints a 15-minute user token after its own sign-in |
| `@morphkit/agent` | a Node 22 service you deploy | the model key, the app key, the JWT secret, the app's manifest |
| `@morphkit/store-server` (or morphkit cloud) | a Node 22 service + SQLite volume (Postgres later) | snapshots, heads, request log, signed bundles, quotas, audit |

Put the agent and the store behind the app's origin (`/agent`, `/morphkit-store`, `/morphkit/b`) so the browser needs no CORS and the CSP stays `'self'`.

## 2. Keys

```bash
pnpm exec morphkit keys new
```

Prints `MORPHKIT_APP_KEY` (`mk_live_…`), `MORPHKIT_JWT_SECRET` and the public key. App key and JWT secret go into the secret store of the agent server and store-server (both get the same values); the JWT secret also goes to your backend. The public key goes into the build (`MORPHKIT_PUBLIC_KEY` at build time, or `morphkit({ publicKey })`): then the runtime runs only bundles the agent signed. Never in a `VITE_` variable, never committed. Check: `pnpm exec morphkit doctor` → `[ok] secrets`.

## 3. Your backend mints user tokens

```ts
import { mintUserToken } from '@morphkit/store-server/token' // or @morphkit/runtime/security
app.get('/api/morphkit-token', requireSession, async (req, res) => {
  res.json({ token: await mintUserToken({ secret: process.env.MORPHKIT_JWT_SECRET!, userId: req.user.id, appId: 'crm', orgId: req.user.orgId, role: req.user.isAdmin ? 'admin' : 'user' }) })
})
```

In the browser, pass a function that returns a fresh token, and refresh on expiry:

```tsx
const token = (o?: { refresh?: boolean }) => getMorphkitToken({ force: o?.refresh })
const store = new HttpStore({ baseUrl: '/morphkit-store', userId, appId: 'crm', token })
<MorphkitProvider config={config} store={store} userId={userId} token={token} onAuthExpired={() => getMorphkitToken({ force: true })}>
```

A 401 from store-server or the agent (token expired mid-session) gets one retry with a fresh token.

## 4. Deploy the agent server

```bash
NODE_ENV=production \
MORPHKIT_APP_ID=crm MORPHKIT_APP_KEY=mk_live_… MORPHKIT_JWT_SECRET=… \
MORPHKIT_MANIFEST=/srv/app/dist/morphkit.manifest.json \
MORPHKIT_STORE_URL=http://store:8790 \
MORPHKIT_API_KEY=… MORPHKIT_MODEL=claude-sonnet-5-5 \
MORPHKIT_ALERT_WEBHOOK=https://hooks.slack.com/… \
npx morphkit-agent
```

It refuses to start in production without the credentials or `MORPHKIT_MANIFEST`: the static rules, readonly sources and types come from the build's manifest, never from the browser. Deploy the manifest together with each release of the app (same file the app was built with). Optional: `MORPHKIT_TYPECHECK=1` (+ `MORPHKIT_TYPECHECK_ROOT=/srv/app` with `node_modules`) refuses edits with type errors against your `.d.ts`.

Proxies must not buffer SSE: the agent sends a keepalive comment every 15 s; for nginx add `proxy_buffering off; proxy_read_timeout 120s;` on `/agent/`.

## 5. Deploy store-server

```bash
NODE_ENV=production MORPHKIT_APP_ID=crm MORPHKIT_APP_KEY=mk_live_… MORPHKIT_JWT_SECRET=… \
MORPHKIT_STORE_DB=/data/morphkit.db npx morphkit-store
```

Back up the SQLite file (it is WAL; use `sqlite3 .backup`). Route `/morphkit/b/*` of the app to store-server's `/v1/b/*` (public, signed, immutable bundles). Bodies are limited to 4 MiB (`MORPHKIT_STORE_BODY_LIMIT`).

## 6. Content-Security-Policy (server compile, the default)

```
script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; form-action 'self'
```

The static rules refuse remote URLs in edits; the CSP is the second line. With `isolated` panels, serve `assets/morphkit-isolated-host-*.js` with `Access-Control-Allow-Origin: *`. Check: `pnpm exec morphkit doctor --url https://app.example.com` (`csp`, `secure-context`). Serve over https: on plain http (not localhost) the browser has no WebCrypto, so signed bundles cannot be verified.

## 7. Privacy settings

- The DOM of a pointed panel goes to the model as structure only. `morphkit({ sendDomText: true })` sends visible text (e-mails and numbers masked). Mark sensitive parts with `data-morphkit-private`: never sent.
- `morphkit({ protected: ['[data-consent]', '.legal'] })`: elements edits must keep and must not hide.
- `morphkit({ isolateEdits: true, isolated: true })`: every edited panel runs in a sandboxed iframe (slower, props must be serializable).

## 8. Before each release

```bash
pnpm build
pnpm exec morphkit check-snapshots --store https://… --app crm --manifest dist/morphkit.manifest.json --typecheck
```

Lists the users whose version would not carry over. They are not broken: their panels are marked stale and they can reset or ask the agent to carry the edit over.

## 9. Operations

Alerts, freezes and the kill switch: [`docs/ops/incident.md`](../ops/incident.md). Quotas per app are data (`PUT /v1/admin/plan`). Export for a customer or a user: `morphkit export`.
