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

**Parallel or sequential classifier.** By default (`PLEATKIT_CLASSIFIER=auto`) the agent starts the main model together with the classifier, which makes an edit about 1.3 s faster, and cancels that call when the classifier answers alone (needs-backend, a clarifying question, off-topic, declined); the cancelled call still costs $0.02 to 0.03 on a large app. So per app it switches to `sequential` while the classifier answered more than 50 % of the app's classified requests alone in the last 7 days (at least 20 such requests; it returns to parallel at 45 %), and logs `classifier parallel -> sequential` on each switch. The history is kept per process and seeded on an app's first request from store-server's request log (`GET /v1/classifier-stats`) when `PLEATKIT_STORE_URL` is set. `GET /agent/v1/classifier-modes` shows the mode and counts per app (an admin's token sees its own app; in development the header `x-pleatkit-admin: 1` sees every app; `/agent/v1/health`, which needs no auth, only says how many apps are tracked), each logged request has `timings.classifierMode`. `PLEATKIT_CLASSIFIER=parallel` or `=sequential` fixes the mode for every app.

**Classifier ensemble (optional, off by default).** With `PLEATKIT_CLASSIFIER_ENSEMBLE=jev` and a `TYPESAFE_API_KEY`, TypeSafe's Jev (a decision model that writes no text, about 0.3 s, $0.042 per million input tokens) routes a request together with the Claude classifier and decides alone when it is sure (an edit, a mixed request, server-only work or "put it back"; confidence at least 0.9 and no sign of an attack); otherwise the Claude classifier decides as before, and it still writes every text the user or the administrator sees. The key is optional: without it the classifier is Claude Haiku alone, and `PLEATKIT_CLASSIFIER_ENSEMBLE=jev` without the key refuses to start. Measured (2026-10-19): the same accuracy as Haiku alone (304 and 305 of 318 requests, Russian included), the routing decision 1.4 → 1.1 s median (0.3 s when Jev decides, 46 % of requests), $0.00013 instead of $0.00009 per request. It shortens edits only where the agent waits for the classifier (an app the automatic mode runs `sequential`) and `restore` answers; in the default parallel mode an edit's latency is the main model's. It sends each request's text, the panel names and the data contract's field names to TypeSafe: list TypeSafe as a sub-processor in your DPA before turning it on. If TypeSafe is slow or down, the Claude classifier's answer is used 150 ms after it arrives.

**Prompt cache TTL.** The cached system prefix (instructions, the app's readonly context) is written for an hour by default (`PLEATKIT_CACHE_TTL=1h`; `5m` is the API's default). A 1-hour write costs 2× input instead of 1.25×, but an app where edits come minutes apart reads the prefix instead of writing it again: with one edit every 20 minutes six edits cost $0.135 instead of $0.164 on a small app. Keep `5m` for an app whose edits are usually more than an hour apart: each edit then writes the prefix either way, and the 1-hour write costs more.

**The pointed panel.** When the user points at a panel, an edit sends that panel's files and what they import, and lists the rest of the zone by name (the model reads a file when it needs it): on a 7-file zone an edit costs $0.012 instead of $0.030. `PLEATKIT_TAIL=all` sends the whole zone every time, as before.

**A cheaper editor.** `PLEATKIT_MODEL=claude-haiku-5-5` passed 68 of 69 eval tasks (98.6 %; Sonnet 5.5 misses the same one) at $0.001 to $0.003 per edit, about a tenth of Sonnet's, 1 to 2 s slower median and with a long tail (p95 up to 25 s). Use it for a free tier or a try-it stand with a dollar limit per org; keep Sonnet 5.5 for paying users.

**Choosing a model** (measured 2026-10-21 on the same 69 tasks with Haiku 5.5 as the classifier: Sonnet and Haiku three trials each on the same day, [block 8](../../evals/REPORT-2026-10-21-block8.md); the other models one trial each, [the matrix report](../../evals/REPORT-2026-10-21-matrix.md)). The agent has two model jobs: the editor (`PLEATKIT_MODEL`, writes the panel code through tools) and the classifier (`PLEATKIT_CLASSIFIER_MODEL`, routes each request first).

| You want | Editor | Classifier | Measured |
|---|---|---|---|
| The default (your Anthropic key) | `claude-sonnet-5-5` | `claude-haiku-5-5` | 204/207 (98.6 %), first try 100 %, 5.4 s median edit (p95 10 s), $0.027 per edit |
| A free tier or a try-it stand | `claude-haiku-5-5` | `claude-haiku-5-5` | 203/207 (98.1 %; one more miss on awkward requests), first try 98.6 %, 6.5 s (p95 11 s), $0.0026 per edit |
| No Anthropic at all (plan B) | `deepseek/deepseek-v4.1-flash` through OpenRouter | `z-ai/glm-5.3-flash` (or `deepseek/deepseek-v4.1-flash`) through OpenRouter | editor 66/69 (two apps edits short), 4.7 s (p95 14 s), $0.001 per edit; classifier 303 of 318 right against Haiku's 305, 1.7 s against 1.4 s, more attacks routed to the editor (8 of 64 against 3) |

Plan B, with an OpenRouter key and no Anthropic key:

```bash
PLEATKIT_PROVIDER=openrouter OPENROUTER_API_KEY=sk-or-… PLEATKIT_MODEL=deepseek/deepseek-v4.1-flash PLEATKIT_CLASSIFIER_MODEL=z-ai/glm-5.3-flash npx pleatkit-agent
```

Mixed: keep Claude as the classifier with an OpenRouter editor (`PLEATKIT_PROVIDER=openrouter`, `OPENROUTER_API_KEY`, `PLEATKIT_CLASSIFIER_PROVIDER=anthropic`, `ANTHROPIC_API_KEY`), or a cheap classifier with Sonnet (`PLEATKIT_CLASSIFIER_PROVIDER=openrouter`, `PLEATKIT_CLASSIFIER_MODEL=…`). OpenRouter's own bill per call (`usage.cost`) is what the agent meters and caps. What plan B loses: about 3 points of pass on large foreign panels, Anthropic's cache control (the 1-hour prefix) and the exact token count behind doctor's price, the refusal fallback, and a routing layer you must list in your DPA (OpenRouter picks the host per call). Haiku as the editor on your own key is a choice, not a risk: on the same day it matched Sonnet on the demo and the foreign apps and missed one more awkward request in sixty, at a tenth of the price; Sonnet stays the default because the rule for switching (within 1 point on every set) was set before the run. Not recommended, measured: GPT-5 mini (90 %, 19 s median), Kimi K2.6 and GLM-5.3 Flash as editors (95–97 % on OpenRouter's fastest hosts with `PLEATKIT_OPENROUTER_SORT=throughput`, which removed their deadline failures, but p95 58–67 s from long reasoning), Gemini 3.7 Flash (88 % on 41 tasks at Sonnet's price), Qwen3-Coder-Next (84 %, no image input), GPT-5 nano (77 %, 45 s); GPT-5 nano and Qwen3-Coder 30B as classifiers (273 and 189 of 318; nano routes attacks as edits).

**Model rate limits and the Anthropic tier.** The agent runs at most `PLEATKIT_MODEL_CONCURRENCY` model calls at a time per process (default 8; the rest wait in a FIFO queue), and retries a call refused with 429 or `overloaded_error` after its `retry-after` (else 1, 2, 4 s), at most `PLEATKIT_RATE_LIMIT_RETRIES` times (default 3). The user sees "The AI service is busy, retrying"; if it still fails, the run ends with a plain message, `rateLimited: true` in the result and an `edit.rate_limited` event (the /admin Plan screen counts them per day). A retry that could not finish before the run's 90 s deadline is not started. Sizing: Anthropic's Start tier allows, per model, 2M input tokens, 400K output tokens and 1,000 requests a minute, and cache reads do not count toward the input limit. One edit reads the cached prefix (about 8k tokens on a small app, 15k on shadcn-admin after the block-3 trimming, 34k before) from the cache, and spends about 1.5 to 3k uncached input tokens on a small app (up to 10k where the panels in the request are large, as on shadcn-admin), 0.5 to 2k output tokens (thinking included) and 2 to 3 requests (the classifier runs on Haiku, which has its own limits). At one edit per user per minute, which is a busy editor, the Start tier holds about 150 concurrent editing users on large panels and several hundred on small ones; the output limit (400K / 2k) is usually the first one reached. Above that, ask Anthropic for a higher tier, or run several agent processes only if the tier allows their sum. Check the real numbers in the Console's usage page and in `pleatkit report`.

Proxies must not buffer SSE: the agent sends a keepalive comment every 15 s; for nginx add `proxy_buffering off; proxy_read_timeout 120s;` on `/agent/`.

## 5. Deploy store-server

```bash
NODE_ENV=production PLEATKIT_APP_ID=crm PLEATKIT_APP_KEY=mk_live_… PLEATKIT_JWT_SECRET=… \
PLEATKIT_STORE_DB=/data/pleatkit.db npx pleatkit-store
```

Back up the SQLite file (it is WAL; use `sqlite3 .backup`). Route `/pleatkit/b/*` of the app to store-server's `/v1/b/*` (public, signed, immutable bundles). Bodies are limited to 4 MiB (`PLEATKIT_STORE_BODY_LIMIT`).

The pilot report (`GET /v1/report?from&to`, admin only, CSV or `&format=json`) has, after the request and outcome columns, `token_cost_usd` (the metered tokens of the range priced by pleatkit's model price table), `unpriced_tokens` (tokens of models without a price), `dev_hours_saved` (applied edits × minutes per edit / 60) and `cost_per_applied_edit_usd`; rows per day and organization, then one per organization (`date` = `all`), then the total. Minutes per edit: `PLEATKIT_REPORT_MINUTES_PER_EDIT` (default 20), or `&minutesPerEdit=` per request.

## 6. Content-Security-Policy (server compile, the default)

```
script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; form-action 'self'
```

The static rules refuse remote URLs in edits; the CSP is the second line. With `pleatkit({ allowedHosts: ['images.example-cdn.com'] })` (images and links of edits may then point to those hosts over https, section 7), add each host to `img-src` and widen nothing else: `img-src 'self' data: https://images.example-cdn.com`. `pleatkit doctor` lists the hosts it finds in the manifest and warns when `img-src` leaves one out. With `isolated` panels, serve `assets/pleatkit-isolated-host-*.js` with `Access-Control-Allow-Origin: *`. Check: `pnpm exec pleatkit doctor --url https://app.example.com` (`csp`, `secure-context`). Serve over https: on plain http (not localhost) the browser has no WebCrypto, so signed bundles cannot be verified.

## 7. Privacy settings

- The DOM of a pointed panel goes to the model as structure only. `pleatkit({ sendDomText: true })` sends visible text (e-mails and numbers masked). Mark sensitive parts with `data-pleatkit-private`: never sent.
- `pleatkit({ protected: ['[data-consent]', '.legal'] })`: elements edits must keep and must not hide.
- `pleatkit({ allowedHosts: ['images.example-cdn.com'] })`: hosts that `<img src>`/`srcSet` and `<a href>` of edits may point to (an image CDN, a docs site), only over `https:` on the default port. Exact host names: no scheme, path, port or wildcard; list each subdomain. Everything else (video, forms, iframes, styles, scripts) stays on the app's origin. Default: none. Add the hosts to the CSP's `img-src` (section 6).
- `pleatkit({ isolateEdits: true, isolated: true })`: every edited panel runs in a sandboxed iframe (slower, props must be serializable).

## 8. Before each release

```bash
pnpm build
pnpm exec pleatkit check-snapshots --store https://… --app crm --manifest dist/pleatkit.manifest.json --typecheck
```

Lists the users whose version would not carry over. They are not broken: their panels are marked stale and they can reset or ask the agent to carry the edit over.

## 9. Operations

Alerts, freezes and the kill switch: [`docs/ops/incident.md`](../ops/incident.md). Quotas per app are data (`PUT /v1/admin/plan`). Export for a customer or a user: `pleatkit export`.
