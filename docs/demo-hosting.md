# The public demo (demo.pleatkit.com)

A live copy of the demo CRM where anyone can open the drawer and try pleatkit without installing anything. One Node
process serves the app, its data API, the agent server and one store-server per visitor, behind nginx. Source:
`apps/demo-crm/server/public/` (server), `apps/demo-crm/src/core/PublicDemo.tsx` (page chrome),
`apps/demo-crm/deploy/` (systemd unit, nginx vhosts, settings template), `scripts/deploy-demo.sh`,
`scripts/demo-pull.sh`, `scripts/demo-report.mjs`.

```
browser ──https──> Cloudflare ──> nginx (demo.pleatkit.com, TLS, HSTS, rate limit)
                                     │ proxy_pass 127.0.0.1:8710
                                     ▼
                     pleatkit-demo.service (node server.mjs, user pleatkit-demo, MemoryMax 768M)
                     ├─ gateway: visitor cookie, rate limits, body limits, CSP, routes every call into the
                     │  visitor's own namespace (strips identity headers, rewrites the app id)
                     ├─ static app (vite build) + /admin
                     ├─ /api/*            the visitor's own copy of the CRM data (in memory)
                     ├─ /pleatkit-store/* the visitor's own store-server (SQLite in /run/pleatkit-demo/visitors/<id>/)
                     ├─ /agent/*          the agent server: recorded answers, the real model (LIVE) or a refusal
                     └─ /var/lib/pleatkit-demo: research log (JSONL), day counters, leads.jsonl
```

## Two modes

| | SCRIPTED (default) | LIVE |
|---|---|---|
| The six example requests (chips) | answered from the recorded fixtures (`e2e/fixtures/agent`), at a realistic pace | the same: always free |
| Free text | a friendly refusal with the contact address | the real agent with the operator's Anthropic key, within the budget |
| Model cost | none | capped per day, per visitor and per request |
| Strip on the page | "live requests: off in this demo" | "live requests: N left today" |

The six requests are the film's two opening requests (customer card fields, a discount that needs the server) and
its four showcase requests (revenue chart, retention heatmap, deals kanban, pipeline pivot):
`apps/demo-crm/src/core/demo-requests.ts`. Only these exact texts (case, spaces and trailing punctuation aside)
reach the scripted provider.

LIVE mode starts every run with the cheap classifier (the off-topic guard, `PLEATKIT_CLASSIFIER_MODEL`): general
chat, code help and prompt-injection attempts get the product's own refusal and no agent run (logged as
`refused_offtopic` with the text). The agent loop skips the classifier for a pointed-at panel or an answered
question; the demo runs one classifier call first in those cases. Without a key, `DEMO_MODE=live` falls back to
SCRIPTED (and says so in the journal). `DEMO_LIVE_PROVIDER=fake` is a stand-in model for local runs and the tests: no
network, made-up but priced usage.

### Budget (LIVE)

| Setting | Default | Meaning |
|---|---|---|
| `DEMO_DAILY_USD` | 5 | hard cap on model spend per UTC day, all visitors |
| `DEMO_LIVE_MAX_USD_PER_REQUEST` | 0.40 | the agent stops a run at this cost; a run starts only while spend + this ceiling (for every run in flight) still fits under the daily cap |
| `DEMO_DAILY_LIVE_REQUESTS` | 100 | live requests per day, all visitors |
| `DEMO_VISITOR_LIVE_REQUESTS` | 5 | live requests per visitor per day (by cookie) |
| `DEMO_VISITOR_IP_FACTOR` | 3 | per IP hash: 3 visitors' worth (an office behind one address) |
| `DEMO_LIVE_CONCURRENCY` | 2 | live runs at a time; more get "busy, try again in a minute" |

At 80 % of the daily dollar cap the journal gets a warning line; when the next run would not fit, free text gets the
cap fallback ("Today's live requests are used up...") and the six requests keep working. The day's counters are in
`stats-YYYY-MM-DD.json` (so a restart keeps the cap) and count scripted, live, refused and capped requests: the
demand beyond the cap stays visible.

## Isolation

- A visitor is a random 128-bit id in an HttpOnly cookie (`pk_demo`, 24 h). Their namespace is `v` + the first 16
  hex of its sha256; the page reads the namespace from a second, readable cookie (`pk_demo_app`) because
  server-compiled bundles are built for it.
- Each visitor has their own store-server (own SQLite file in their own folder under `/run/pleatkit-demo`, a tmpfs
  that systemd creates at start and removes at stop) and their own in-memory copy of the CRM data. Versions, undo
  and the admin view (`/admin`) show only their own changes. The folder is deleted 24 h after the visitor's first
  visit (`DEMO_VISITOR_TTL_HOURS`), and the whole state is wiped on every restart.
- The gateway forces the visitor's namespace on every store, bundle and agent call and strips identity headers the
  browser could set (`authorization`, `x-pleatkit-app`, `x-pleatkit-agent`, `x-pleatkit-act-as`, ...). The visitor
  is admin of their own namespace only. The store-server runs with development headers, which is safe only because
  it is reachable solely through the gateway, in-process.

## Safety

- **Generated code** goes through the product's own path and nothing else: the agent writes files, `check` (static
  rules) and esbuild compile them on the server, the bundle is stored in the visitor's store and runs only in the
  visitor's own browser. The server never executes generated code.
- **No outbound network from generated code.** The static rules refuse absolute URLs in `fetch`, `WebSocket`,
  `EventSource`, `XMLHttpRequest`, workers, dynamic imports, `url()` in styles and navigation
  (`packages/runtime/src/check.ts`); the runtime guard strips off-origin URLs from elements (`url-guard.ts`); and
  the page's CSP is `connect-src 'self'` with no external hosts at all (`apps/demo-crm/server/public/gateway.ts`,
  `DEMO_CSP`). A same-origin request from an edit lands in the visitor's own sandbox. The demo has no
  `allowedHosts`.
- **CSP and headers** on every answer: `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline';
  img-src 'self' data: blob:; connect-src 'self'; worker-src 'none'; object-src 'none'; base-uri 'self';
  form-action 'self'; frame-ancestors 'none'`, plus `X-Frame-Options: DENY`, `nosniff`, `Referrer-Policy`,
  `Permissions-Policy`, `COOP`. nginx adds HSTS.
- **Rate limits** on every route (per client, fixed windows): pages 240/min, store/data/bundles 240/min, agent runs
  12/min, other agent calls 60/min, events and feedback 60/min, leads 5/h, new visitors 30/h; nginx adds 20 r/s with a
  burst of 80 and 20 connections per client. **Body limits**: agent 2 MB, store 1 MB, everything else 64 KB.
- **The key** is read from `/etc/pleatkit-demo/demo.env` in LIVE mode only, by the server process; it is never
  logged and never reaches the browser. `/api/pleatkit-token` and `pleatkit.manifest.json` are not served.

## What is logged

Everything stays on the server; nothing is sent anywhere. The coordinator pulls the files (`scripts/demo-pull.sh`).

`/var/lib/pleatkit-demo/events-YYYY-MM-DD.jsonl` (append-only, one file per UTC day), one JSON object per line:

- `kind: "request"`, one per request: `ts`, `visitor` (cookie hash), `seq` (number in the session), `mode`
  (scripted/live), `route`, `request` (the text as typed), `chip` and `chipId` (suggestion chip or free text),
  `target` (the pointed-at panel), `panels` (files the edit changed), `model`, `models`, `tokens` (input, output,
  cache read, cache write), `costUsd` (from the provider's usage; 0 for scripted), `latencyMs` (total, model,
  classify), `outcome`, `verdict`, `answer` (the agent's text), `error`, `files` (count, bytes), `steps` (progress
  lines shown), `toolCalls`, `modelCalls`, `requestId`.
- `outcome` is one of `applied`, `refused_out_of_scope`, `needs_backend`, `compile_error`, `runtime_error`,
  `timeout`, `cap_reached`, `refused_offtopic`, and, so nothing is forced into a wrong bucket, `clarify`, `restore`,
  `failed`. `runtime_error` arrives later as `kind: "outcome"` when the page rolls back an edit that crashed.
- `kind: "session"`: `undo` (with `msSinceApplied` and `within2min`), `repeat` (the same text again), `rephrase`
  (free text within 90 s of the previous free text, sharing at least half of its words), `admin_opened`,
  `film_click`, `site_click`, `admin_click`, `email_left`.
- `kind: "feedback"`: the strip after each applied edit, "Did it do what you asked? Yes / Not quite", with the reasons
  (`wrong_panel`, `looks_wrong`, `not_what_i_meant`) and the optional comment, against the request id.

`leads.jsonl`: e-mails from the "Leave your email for a free pilot" form (with the visitor hash and the optional
note). `stats-YYYY-MM-DD.json`: the day's counters (no ids). Journald has the process log (no IPs, no request texts).

**Privacy.** The page says next to the composer and under the form: "Requests in this demo are recorded to improve
pleatkit; don't paste private data". No IP address is stored: the rate limiter keys clients by sha256(daily salt +
address), the salt lives in memory and changes every UTC day, and the nginx access log uses a format without
addresses. No cookie banner is needed: the two cookies are functional (the sandbox), there is no tracking.

**Retention.** The JSONL logs and day counters are deleted after 30 days (`DEMO_RETENTION_DAYS`, checked every 10
minutes). Visitor sandboxes live 24 h at most. `leads.jsonl` is kept until the coordinator removes it.

**Report.** `node scripts/demo-report.mjs [--days 1|7] [--classify]` prints counts per outcome, cost total and per
request (p50/p95), latency p50/p95, satisfaction, the undo-within-2-minutes rate, the top 20 requests and the failures
and "Not quite" comments sorted into `out_of_zone`, `backend_needed`, `ambiguous_request`, `generation_failed`,
`style_mismatch`, `missing_data`, `injection_attempt`, `other` (with `--classify` and a key, one call to the
classifier model; otherwise a keyword heuristic). It writes the markdown to `D:/pleatkit-tmp/demo-reports/` when run
locally.

## Settings

All in `/etc/pleatkit-demo/demo.env` (template: `apps/demo-crm/deploy/env.example`); the unit sets the paths.

| Variable | Default | |
|---|---|---|
| `DEMO_MODE` | `scripted` | `scripted` or `live` |
| `PLEATKIT_API_KEY` (or `ANTHROPIC_API_KEY`) | | LIVE only; the operator's key |
| `PLEATKIT_MODEL`, `PLEATKIT_CLASSIFIER_MODEL` | `claude-sonnet-5-5`, `claude-haiku-5-5` | LIVE models |
| `DEMO_DAILY_USD`, `DEMO_DAILY_LIVE_REQUESTS`, `DEMO_VISITOR_LIVE_REQUESTS`, `DEMO_VISITOR_IP_FACTOR`, `DEMO_LIVE_MAX_USD_PER_REQUEST`, `DEMO_LIVE_CONCURRENCY` | 5, 100, 5, 3, 0.40, 2 | the budget above |
| `DEMO_SCRIPTED_DELAY_MS` | 900 | pause before each recorded step |
| `DEMO_VISITOR_TTL_HOURS`, `DEMO_MAX_VISITORS`, `DEMO_RETENTION_DAYS` | 24, 2000, 30 | sandboxes and logs |
| `DEMO_CONTACT_EMAIL`, `DEMO_SITE_URL`, `DEMO_FILM_URL` | `pilot@pleatkit.com`, `https://pleatkit.com`, `https://pleatkit.com/#demo` | links |
| `DEMO_HOST`, `DEMO_PORT`, `DEMO_STATE_DIR`, `DEMO_DATA_DIR`, `DEMO_TRUST_PROXY` | set by the unit | `127.0.0.1`, `8710`, `/run/pleatkit-demo`, `/var/lib/pleatkit-demo`, `1` |
| `DEMO_LIVE_PROVIDER` | `anthropic` | `fake` for local runs without a key |
| `DEMO_TYPECHECK` | on | `0` turns the agent's type check off |

## First deploy

On your machine (bash, Node 22, pnpm, ssh). The deploy script reads `DEMO_SSH_HOST` and `DEMO_SSH_KEY` from the
environment or from a git-ignored `.env.demo-deploy` at the repo root:

```bash
DEMO_SSH_HOST=root@<vps> DEMO_SSH_KEY=~/.ssh/<key> DEMO_INSTALL_NODE=1 scripts/deploy-demo.sh
```

It builds the release, uploads it to `/var/www/pleatkit-demo/releases/<stamp>`, and as root on the server creates the
`pleatkit-demo` system user, installs the release's npm packages (better-sqlite3 and esbuild are native, so they are
installed there), creates `/etc/pleatkit-demo/demo.env` from the template once (SCRIPTED), installs and starts
`pleatkit-demo.service`, checks `http://127.0.0.1:8710/demo/api/health` and rolls back to the previous release if it
does not answer. `DEMO_INSTALL_NODE=1` installs Node 22 from NodeSource when the server has none. It does not touch
nginx, DNS or other sites.

Then, once, by hand:

1. **DNS** (Cloudflare, zone pleatkit.com): `A demo <vps>`, **proxy off** (grey cloud) for now, so certbot reaches
   the server directly.
2. **nginx, step 1** (as root): `cp /var/www/pleatkit-demo/nginx/demo.pleatkit.com.bootstrap.conf
   /etc/nginx/sites-available/demo.pleatkit.com.conf && ln -s ../sites-available/demo.pleatkit.com.conf
   /etc/nginx/sites-enabled/ && nginx -t && systemctl reload nginx`
3. **Certificate** (as root, the webroot the other sites use):
   `certbot certonly --webroot -w /var/www/letsencrypt -d demo.pleatkit.com`
4. **nginx, step 2** (as root): `cp /var/www/pleatkit-demo/nginx/demo.pleatkit.com.conf
   /etc/nginx/sites-available/demo.pleatkit.com.conf && nginx -t && systemctl reload nginx`
5. **DNS**: turn the proxy on (orange cloud). SSL/TLS stays Full (strict).
6. Check: `curl -sI https://demo.pleatkit.com/ | grep -i content-security` and open the page.

Renewal runs with the server's certbot timer (webroot). To go LIVE: put the key and `DEMO_MODE=live` into
`/etc/pleatkit-demo/demo.env`, `systemctl restart pleatkit-demo`, and check that the strip says "N left today".

## Updates and operations

- Deploy again: `scripts/deploy-demo.sh` (the last three releases are kept; `/var/www/pleatkit-demo/app` points at
  the live one). Roll back by hand: `ln -sfn /var/www/pleatkit-demo/releases/<older> /var/www/pleatkit-demo/app &&
  systemctl restart pleatkit-demo`.
- Logs: `journalctl -u pleatkit-demo -f` (journald rotates them). Health: `curl -s 127.0.0.1:8710/demo/api/health`.
- Switch modes or change the budget: edit `/etc/pleatkit-demo/demo.env`, `systemctl restart pleatkit-demo` (visitor
  sandboxes are wiped; the day's spend is kept).
- Pull the data and report: `scripts/demo-pull.sh && node scripts/demo-report.mjs`.
- Origin bypass: CF-Connecting-IP only keys rate limits; to stop anyone from reaching the server around Cloudflare,
  allow ports 80/443 only from Cloudflare's ranges (optional; the daily caps hold either way).

## Local runs and tests

```bash
pnpm build:packages && pnpm --filter @pleatkit/demo-crm build
pnpm --filter @pleatkit/demo-crm demo:public                     # SCRIPTED on http://127.0.0.1:8710
DEMO_MODE=live DEMO_LIVE_PROVIDER=fake pnpm --filter @pleatkit/demo-crm demo:public   # LIVE without a key
pnpm --filter @pleatkit/demo-crm e2e:demo                        # Playwright, headless, both modes
```

`e2e:demo` (`playwright.demo.config.ts`, `e2e-demo/`) starts the server twice (SCRIPTED, and LIVE with the fake
provider and a $0.50 day) and checks the strip and chips, the refusal path, apply and undo, the feedback strip, two
visitor cookies as two sandboxes (edits, data, bundles, admin view), the off-topic refusal and its log record, the cap
fallback, the lead form and the log records. `DEMO_SERVER_COMMAND="node <release>/server.mjs"` runs the same tests
against a built release.

## Limits of this setup

- The feedback strip and the privacy line dock to the drawer's left edge (above it on phones) instead of sitting
  inside it: `packages/ui` is the architect's, and the demo does not change it.
- A runtime crash is told apart from an undo by the page (an undo click or Ctrl+Z just before the version goes
  back); a crash right after a click on undo would be logged as an undo.
- A run the visitor cancels mid-way is logged without its cost (the agent sends no result), and its spend is not
  added to the day's counter; the per-request ceiling bounds it.
- Visitor sandboxes and the per-visitor live counts live in one process: one instance, no horizontal scaling.
