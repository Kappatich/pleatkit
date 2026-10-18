# Taking pleatkit to production

After [install.md](install.md) works on a developer machine (HttpStore against a local store-server, scripted or real model, no credentials), this is the path to real users. Each step: what to set, how to check it.

## 1. Pieces and where they run

| Piece | Runs | Holds |
|---|---|---|
| your app (Vite build) | CDN / your web server | the manifest (`dist/pleatkit.manifest.json`), the public key of the app key |
| your backend | your servers | the user-JWT secret; mints a 15-minute user token after its own sign-in |
| `@pleatkit/agent` | a Node 22 service you deploy | the model key, the app key, the JWT secret, the app's manifest |
| `@pleatkit/store-server` (or pleatkit cloud) | a Node 22 service + SQLite volume (Postgres later) | snapshots, heads, request log, signed bundles, quotas, audit |

Put the agent and the store behind the app's origin (`/agent`, `/pleatkit-store`, `/pleatkit/b`) so the browser needs no CORS and the CSP stays `'self'`.

## 2. Keys

```bash
pnpm exec pleatkit keys new
```

Prints `PLEATKIT_APP_KEY` (`mk_live_…`), `PLEATKIT_JWT_SECRET` and the public key. App key and JWT secret go into the secret store of the agent server and store-server (both get the same values); the JWT secret also goes to your backend. The public key goes into the build (`PLEATKIT_PUBLIC_KEY` at build time, or `pleatkit({ publicKey })`): then the runtime runs only bundles the agent signed. Never in a `VITE_` variable, never committed. Check: `pnpm exec pleatkit doctor` → `[ok] secrets`.

## 3. Your backend mints user tokens

```ts
import { mintUserToken } from '@pleatkit/store-server/token' // or @pleatkit/runtime/security
app.get('/api/pleatkit-token', requireSession, async (req, res) => {
  res.json({ token: await mintUserToken({ secret: process.env.PLEATKIT_JWT_SECRET!, userId: req.user.id, appId: 'crm', orgId: req.user.orgId, role: req.user.isAdmin ? 'admin' : 'user' }) })
})
```

In the browser, pass a function that returns a fresh token, and refresh on expiry:

```tsx
const token = (o?: { refresh?: boolean }) => getPleatkitToken({ force: o?.refresh })
const store = new HttpStore({ baseUrl: '/pleatkit-store', userId, appId: 'crm', token })
<PleatkitProvider config={config} store={store} userId={userId} token={token} onAuthExpired={() => getPleatkitToken({ force: true })}>
```

A 401 from store-server or the agent (token expired mid-session) gets one retry with a fresh token.

## 4. Deploy the agent server

```bash
NODE_ENV=production \
PLEATKIT_APP_ID=crm PLEATKIT_APP_KEY=mk_live_… PLEATKIT_JWT_SECRET=… \
PLEATKIT_MANIFEST=/srv/app/dist/pleatkit.manifest.json \
PLEATKIT_STORE_URL=http://store:8790 \
PLEATKIT_API_KEY=… PLEATKIT_MODEL=claude-sonnet-5-5 \
PLEATKIT_ALERT_WEBHOOK=https://hooks.slack.com/… \
npx pleatkit-agent
```

It refuses to start in production without the credentials or `PLEATKIT_MANIFEST`: the static rules, readonly sources and types come from the build's manifest, never from the browser. Deploy the manifest together with each release of the app (same file the app was built with). Edits are type-checked against your `.d.ts` by default when the app's `node_modules` are found (`PLEATKIT_TYPECHECK_ROOT=/srv/app`, or the folder above the manifest's `dist/`); `PLEATKIT_TYPECHECK=0` turns it off, `=1` also checks server compiles. On shadcn-admin a warm check adds about 1.4 s to an edit, on smaller apps 0.1 to 0.3 s.

**Model rate limits and the Anthropic tier.** The agent runs at most `PLEATKIT_MODEL_CONCURRENCY` model calls at a time per process (default 8; the rest wait in a FIFO queue), and retries a call refused with 429 or `overloaded_error` after its `retry-after` (else 1, 2, 4 s), at most `PLEATKIT_RATE_LIMIT_RETRIES` times (default 3). The user sees "The AI service is busy, retrying"; if it still fails, the run ends with a plain message, `rateLimited: true` in the result and an `edit.rate_limited` event (the /admin Plan screen counts them per day). A retry that could not finish before the run's 90 s deadline is not started. Sizing: Anthropic's Start tier allows, per model, 2M input tokens, 400K output tokens and 1,000 requests a minute, and cache reads do not count toward the input limit. One edit reads the cached prefix (about 8k tokens on a small app, 15k on shadcn-admin after the block-3 trimming, 34k before) from the cache, and spends about 1.5 to 3k uncached input tokens on a small app (up to 10k where the panels in the request are large, as on shadcn-admin), 0.5 to 2k output tokens (thinking included) and 2 to 3 requests (the classifier runs on Haiku, which has its own limits). At one edit per user per minute, which is a busy editor, the Start tier holds about 150 concurrent editing users on large panels and several hundred on small ones; the output limit (400K / 2k) is usually the first one reached. Above that, ask Anthropic for a higher tier, or run several agent processes only if the tier allows their sum. Check the real numbers in the Console's usage page and in `pleatkit report`.

Proxies must not buffer SSE: the agent sends a keepalive comment every 15 s; for nginx add `proxy_buffering off; proxy_read_timeout 120s;` on `/agent/`.

## 5. Deploy store-server

```bash
NODE_ENV=production PLEATKIT_APP_ID=crm PLEATKIT_APP_KEY=mk_live_… PLEATKIT_JWT_SECRET=… \
PLEATKIT_STORE_DB=/data/pleatkit.db npx pleatkit-store
```

Back up the SQLite file (it is WAL; use `sqlite3 .backup`). Route `/pleatkit/b/*` of the app to store-server's `/v1/b/*` (public, signed, immutable bundles). Bodies are limited to 4 MiB (`PLEATKIT_STORE_BODY_LIMIT`).

## 6. Content-Security-Policy (server compile, the default)

```
script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; form-action 'self'
```

The static rules refuse remote URLs in edits; the CSP is the second line. With `isolated` panels, serve `assets/pleatkit-isolated-host-*.js` with `Access-Control-Allow-Origin: *`. Check: `pnpm exec pleatkit doctor --url https://app.example.com` (`csp`, `secure-context`). Serve over https: on plain http (not localhost) the browser has no WebCrypto, so signed bundles cannot be verified.

## 7. Privacy settings

- The DOM of a pointed panel goes to the model as structure only. `pleatkit({ sendDomText: true })` sends visible text (e-mails and numbers masked). Mark sensitive parts with `data-pleatkit-private`: never sent.
- `pleatkit({ protected: ['[data-consent]', '.legal'] })`: elements edits must keep and must not hide.
- `pleatkit({ isolateEdits: true, isolated: true })`: every edited panel runs in a sandboxed iframe (slower, props must be serializable).

## 8. Before each release

```bash
pnpm build
pnpm exec pleatkit check-snapshots --store https://… --app crm --manifest dist/pleatkit.manifest.json --typecheck
```

Lists the users whose version would not carry over. They are not broken: their panels are marked stale and they can reset or ask the agent to carry the edit over.

## 9. Operations

Alerts, freezes and the kill switch: [`docs/ops/incident.md`](../ops/incident.md). Quotas per app are data (`PUT /v1/admin/plan`). Export for a customer or a user: `pleatkit export`.
