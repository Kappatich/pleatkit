# pleatkit

Let the users of your web app change its interface by asking for it. An AI agent rewrites the parts of your
React app you allowed it to touch; the change is compiled (on your agent server and signed, or in the user's
browser), swapped in without a reload,
and kept as that user's personal version, with undo, history and an admin who can see and roll back every edit.

- **Three zones.** `dynamic` files the agent may rewrite, `readonly` files it may read, everything else is `core`
  (the agent only sees type declarations).
- **Snapshots, not patches.** Every edit is a full snapshot of the dynamic zone; undo is the parent snapshot.
- **Draft, check, commit.** Nothing changes until the whole zone compiles; a broken edit is refused before the
  user sees it, a panel that crashes while rendering is rolled back automatically.
- **Keys stay on your server.** The browser talks to the agent server; the model key is only in its environment.

Design: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md). Measurements: the eval reports in [`evals/`](evals/)
(how they are made: [`docs/evals.md`](docs/evals.md)); changes: [`CHANGELOG.md`](CHANGELOG.md).
Contributing: [`CONTRIBUTING.md`](CONTRIBUTING.md).

**Measured numbers, not estimates** (Claude Sonnet 5.5 at medium effort with prompt caching, stage 5, 2026-10-18/19;
every report is in [`evals/`](evals/); the run transcripts are available on request). pleatkit was installed into four open-source admin
templates that are not ours (shadcn-admin, TailAdmin, an Ant Design dashboard, a CSS-modules app without Tailwind), two
of them blind by fresh coding agents that saw only [`docs/for-agents/`](docs/for-agents/). Across 450+ live runs on
these apps and the demo, **98–100 %** of the requests pass every check, the rendered result in a headless browser
included; **4–5 s median** per edit (p95 under 9 s); **$0.01–0.03** per edit on your key, growing with the editable
zone's size (**$0.0085 + $0.026 per 1,000 lines**; `pleatkit doctor` tells you the expected price before the first
request). Requests that are not edits (server work, a question back, off-topic) cost **$0.0001**. Claude Haiku 5.5 as
the editor (`PLEATKIT_MODEL=claude-haiku-5-5`) passes **68 of 69** at $0.001–0.003 per edit, slower (p95 up to 25 s):
the editor for a free tier. **33 of 33** red-team attacks are refused; a screenshot judge (Haiku, $0.0002 per
judgement) says a designer would accept about 80 % of edits made from deliberately awkward requests. Reports by
block: [block 1](evals/REPORT-2026-10-18.md) (demo), [block 2–3](evals/REPORT-2026-10-18-foreign.md) (foreign apps,
the classifier, trimmed context), [block 4](evals/REPORT-2026-10-19.md) (judge, red team, chains, money),
[block 5](evals/REPORT-2026-10-19-block5.md) (blind installs, cost by zone size, warm type check),
[block 6](evals/REPORT-2026-10-19-block6.md) (pointed-panel tail, cache TTL, Haiku, the optional Jev ensemble, the
weekly drift check).

**Other models.** The agent also runs on any OpenAI-compatible API, OpenRouter included (`PLEATKIT_PROVIDER=openrouter`;
the classifier can come from another vendor with `PLEATKIT_CLASSIFIER_PROVIDER`). On the same 69 tasks
([the model matrix](evals/REPORT-2026-10-21-matrix.md), 2026-10-21) Claude Sonnet 5.5 and Haiku 5.5 pass 68, DeepSeek
V4.1 Flash 66 at $0.001 per edit and 4.7 s median (the non-Anthropic plan B), Kimi K2.6 63, GLM-5.3 Flash and GPT-5 mini
62, Qwen3-Coder-Next 58, GPT-5 nano 53 (Gemini 3.7 Flash 36 of the 41 it ran). As the classifier DeepSeek and GLM-5.3
Flash match Haiku (306 and 303 of 318 against 305) but are slower and dearer per request through OpenRouter. Sonnet 5.5
stays the default; [choosing a model](docs/for-agents/production.md#4-deploy-the-agent-server).

## Packages

| Package | What it does | Repo |
|---|---|---|
| `@pleatkit/vite-plugin` | zones, manifest (dynamic sources, readonly sources, core `.d.ts`), externals registry, fallback bundle, runtime Tailwind module, isolated-panel host | pleatkit (public, MIT) |
| `@pleatkit/runtime` | `<PleatkitProvider>`, `<Dynamic>`, snapshot engine (draft/check/commit/undo/redo/reset), signed server bundles or esbuild-wasm in the page, Tailwind 4 at runtime, safe mode, `LocalStore` (IndexedDB) and `HttpStore` | pleatkit (public, MIT) |
| `@pleatkit/ui` | chat drawer, "point at a panel" picker, history, undo/reset, toasts, stale-version banner | pleatkit (public, MIT) |
| `@pleatkit/agent` | Node agent server: model loop with zone-checked tools, server-side check, SSE progress, providers `anthropic` / `openai-compatible` / `scripted` | pleatkit (public, MIT) |
| `@pleatkit/cli` | `pleatkit doctor` (setup checks with fixes), `init --suggest` (zones from the import graph), `ping`, `keys new`, `keys public`, `export`, `labels export` | pleatkit (public, MIT) |
| `@pleatkit/store-server` | the open store: snapshots, heads, bundles, the request log with approve/reject/rollback, request labels, quotas and plans, usage events, the audit chain, roles `user` and `admin`, flags and the kill switch, export and erasure; Hono + Drizzle + SQLite | pleatkit (public, MIT) |
| `apps/demo-crm` | demo CRM with two users, three dynamic panels and an `/admin` dashboard | pleatkit (public) |

### Open source and cloud

- **pleatkit** (public, MIT): everything you need to install it and to trust it, self-hosted: vite-plugin, runtime,
  ui, the agent server and its edit loop, the checks, the CLI, **the store** (`@pleatkit/store-server`: versions,
  undo, the request log with approve/reject/rollback, roles `user` and `admin`, quotas, usage events, the audit
  chain, flags and the kill switch, export, erasure, request labels) and the demo with its admin screens. Bring your
  own model key; no backend of ours is involved.
- **pleatkit cloud** (private, the managed service): the same open core plus private extension packages
  (`@pleatkit/store-cloud`, `@pleatkit/agent-cloud`, `@pleatkit/admin-cloud`) that add what a vendor needs across
  all of its customers: the pilot report (`GET /v1/report`, CSV with cost and hours saved), the wish map (requests
  the panels could not serve, grouped into themes), carrying users' edits over to a new release and rolling that
  back, code search across users' versions with rollback by selection, the `support` role with "view as a user",
  the weekly digest and the learning layer.

**Self-host: the open core. Cloud: the same core plus the cloud packages** (DECISIONS 70.1, 89). Nothing in the open
packages imports a cloud package: they plug in through `StoreExtension` (`PLEATKIT_STORE_EXTENSIONS`) and
`AgentExtension` (`PLEATKIT_AGENT_EXTENSIONS`), loaded only for a deployment whose `package.json` depends on them.
Without them the open store answers 404 on the cloud routes and 403 `cloud-feature` on a `support` token or an
`x-pleatkit-act-as` header.

## Run the demo

Node 22+, pnpm 10.

```bash
pnpm install
pnpm dev          # builds the packages, then starts web + data + agent + store-server; Ctrl+C stops all of them
```

- http://localhost:5173 : the CRM. Click **Customize** and ask, for example, *"In the customer card add phone,
  city and source; highlight an overdue payment date in red"*. Switch to `bob` in the header: his card is unchanged.
- http://localhost:5173/admin : every request, its verdict and status, the diff against the previous version,
  the agent's tool log, counters for the week; roll back, reject, or take a backend request into work.
- `?dev=1` shows the developer panel (edit a dynamic file by hand), `?isolated=1` runs the dashboard panel in a
  sandboxed iframe, `?store=local` keeps snapshots in the browser instead of store-server.

Without a key the agent uses the **scripted** provider, which replays the recorded answers in
`apps/demo-crm/e2e/fixtures/agent/` (the four scenarios of the architecture doc). With a key it uses Claude:

```bash
# PowerShell
$env:PLEATKIT_API_KEY = "<your Anthropic key>"; pnpm dev
# bash
PLEATKIT_API_KEY=<your Anthropic key> pnpm dev
```

Ports: web 5173, data 8787, agent 8789, store-server 8790 (`WEB_PORT`, `DATA_PORT`, `AGENT_PORT`, `STORE_PORT`).

## Install into your own Vite + React project (5 steps)

**1. Install.**

```bash
pnpm add @pleatkit/runtime @pleatkit/ui
pnpm add -D @pleatkit/vite-plugin @pleatkit/agent
```

**2. Configure the Vite plugin** and proxy the agent so the browser stays on one origin:

```ts
// vite.config.ts
import pleatkit from '@pleatkit/vite-plugin'

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    pleatkit({
      zones: {
        dynamic: ['src/dynamic/**'],                              // the agent rewrites these
        readonly: ['src/readonly/**', 'src/components/ui/**'],   // the agent reads these
      },
      // what dynamic code may import from your app (everything else is refused at check time)
      externals: ['react', 'react-dom', 'react/jsx-runtime', '@/components/ui/*', '@/lib/utils', '@/readonly/*'],
      css: 'tailwind',            // compile Tailwind 4 utilities for edits at runtime ('palette' = no runtime CSS)
      tailwindEntry: 'src/index.css',
      isolated: true,             // optional: enables <Dynamic isolated>
    }),
  ],
  // the agent, and the signed bundles of edits (compile: 'server', the default); with store-server point /pleatkit/b at its /v1/b
  server: { proxy: { '/agent': 'http://localhost:8789', '/pleatkit/b': { target: 'http://localhost:8789', rewrite: (p) => p.replace(/^\/pleatkit\/b/, '/agent/v1/b') } } },
})
```

Add `"types": ["@pleatkit/vite-plugin/client"]` to `tsconfig.json` for the `virtual:pleatkit` modules.

**3. Move the panels users may change into `src/dynamic/<id>.tsx`** (each with a default-exported component) and
render them through `<Dynamic>` instead of importing them:

```tsx
<Dynamic id="customer-card" props={{ customer }} />
```

Keep types, API clients and formatting helpers the panels use in `src/readonly/`, so the agent can read them.
Give entities a free-form `meta` field if you can: many "add a field" requests then need no backend change.

**4. Wrap the app and add the chat.**

```tsx
import * as config from 'virtual:pleatkit'
import { HttpStore, PleatkitProvider } from '@pleatkit/runtime'
import { PleatkitChat } from '@pleatkit/ui'

// the users' versions in store-server; new LocalStore() keeps them in this browser for a quick look
const store = new HttpStore({ baseUrl: '/pleatkit-store', userId: currentUser.id, appId: 'my-app' })

<PleatkitProvider config={config} store={store} userId={currentUser.id}>
  <App />
  <PleatkitChat agentUrl="/agent" />
</PleatkitProvider>
```

**5. Run the agent server** next to your app, with the key in its environment only:

```bash
PLEATKIT_API_KEY=<key> npx pleatkit-agent        # http://localhost:8789/agent
```

**Check the setup:** `npx pleatkit doctor` (package `@pleatkit/cli`, run in the app folder after `vite build`) checks the plugin and zones, a single React 19 shared with the runtime, that every `<Dynamic id>` has a file with a default export, that externals resolve, that a CSP (if any) allows `blob:` and `'wasm-unsafe-eval'`, and that no API key is in the client bundle or a `VITE_` variable. It prints a fix for each problem and exits with 1 when something fails.

Optional: `npx pleatkit-store` (store-server, SQLite) plus `HttpStore` for server-side snapshots, cross-device
versions and the admin dashboard; set `PLEATKIT_STORE_URL` on the agent so every run is logged there.

## Environment variables

Agent server (`@pleatkit/agent`): keys are read from the environment only, never from the browser or from files.

Every variable is `PLEATKIT_*` (the pre-rename `MORPHKIT_*` names are no longer read since 0.2, CHANGELOG). App keys
keep their `mk_live_` prefix: existing keys stay valid.

| Variable | Default | Meaning |
|---|---|---|
| `PLEATKIT_PROVIDER` | `anthropic` if `PLEATKIT_API_KEY` is set, else `scripted` | `anthropic`, `openai-compatible` (also `openai`, `openrouter`), `scripted` |
| `PLEATKIT_API_KEY` | | model API key. With `PLEATKIT_PROVIDER=anthropic`, `ANTHROPIC_API_KEY` / `POLYMORPH_API_KEY` are accepted too |
| `PLEATKIT_MODEL` | `claude-sonnet-5-5` | main model (required for `openai-compatible`) |
| `PLEATKIT_CLASSIFIER_MODEL` | `claude-haiku-5-5` | request classifier (ui / needs-backend / unclear) |
| `PLEATKIT_CACHE_TAIL` | `after-first` | `after-first`: the first call of an edit caches only the system prompt (a one-call edit and a cancelled early call do not pay the 1.25× write of the request's tail); `always`: every call writes the tail, as before |
| `PLEATKIT_CLASSIFIER` | `auto` | `parallel`: the classifier and the main model start together (an edit is ~1.3 s faster, the main call is cancelled when the classifier answers alone); `sequential`: the main model waits for the classifier; `auto`: per app, `sequential` while the classifier answered more than 50 % of the app's classified requests alone in the last 7 days (at least 20 of them; back to `parallel` at 45 %), history from store-server's request log when `PLEATKIT_STORE_URL` is set |
| `PLEATKIT_BASE_URL` | SDK default | API base URL; `PLEATKIT_PROVIDER=openrouter` defaults to `https://openrouter.ai/api/v1`, where `OPENROUTER_API_KEY` is used when set (so `PLEATKIT_API_KEY` can stay the Anthropic key of the classifier) |
| `PLEATKIT_CLASSIFIER_PROVIDER` | the main provider | `anthropic`, `openai-compatible`, `openrouter`, `openai`: the classifier from its own provider, with `PLEATKIT_CLASSIFIER_MODEL`, `PLEATKIT_CLASSIFIER_API_KEY` (default `ANTHROPIC_API_KEY` / `OPENROUTER_API_KEY`, then `PLEATKIT_API_KEY`) and `PLEATKIT_CLASSIFIER_BASE_URL` |
| `PLEATKIT_OPENROUTER_REFERER` / `PLEATKIT_OPENROUTER_TITLE` | the repo / `pleatkit` | OpenRouter's attribution headers |
| `PLEATKIT_OPENROUTER_SORT` | OpenRouter's routing | `throughput`, `latency` or `price`: which host OpenRouter picks for each call (`provider.sort`) |
| `PLEATKIT_EFFORT` | `medium` | Anthropic effort (`low` … `max`); for `openai-compatible` the reasoning effort (`minimal` … `high`; unset: the model's default) |
| `PLEATKIT_FALLBACKS` | on | `off` disables Anthropic server-side refusal fallback (`fallbacks: "default"`) |
| `PLEATKIT_STORE_URL` | | store-server URL; each run (request, verdict, tool log, usage) is logged there |
| `PLEATKIT_FIXTURES` | `fixtures` | directory of scripted answers (`*.json`) |
| `PLEATKIT_AGENT_PORT` | `8789` | |
| `PLEATKIT_MAX_CALLS` / `PLEATKIT_TIMEOUT_MS` / `PLEATKIT_MAX_OUTPUT_TOKENS` | `12` / `90000` / `8000` | limits per edit. The output budget counts **visible** tokens only (text and tool calls); thinking is billed but not limited, and reported per run |
| `PLEATKIT_CORS_ORIGIN` | | allowed browser origin if the app calls the agent cross-origin |
| `PLEATKIT_APP_ID` / `PLEATKIT_APP_KEY` / `PLEATKIT_JWT_SECRET` | | the app this agent serves, its app key (`mk_live_…`) and the user-JWT secret; **required with `NODE_ENV=production`** |
| `PLEATKIT_PLAN` / `PLEATKIT_LIMITS` | `free` | plan used when store-server has none for the app; JSON overrides such as `{"userDailyUsd": 2, "perEditUsd": 0.2}` |
| `PLEATKIT_TYPECHECK` / `PLEATKIT_TYPECHECK_ROOT` | auto | the agent loop type-checks edits against the manifest's readonly sources and `.d.ts` when the app's `node_modules` are found (`_ROOT`, or the folder above the manifest's `dist/`); `0` turns it off, `1` forces it and also checks server compiles; `pleatkit check-snapshots --typecheck` runs the same before a release |
| `PLEATKIT_MODEL_CONCURRENCY` / `PLEATKIT_RATE_LIMIT_RETRIES` | 8 / 3 | model calls at a time per agent process (the rest queue, first come first served); retries of a call refused with 429 or `overloaded_error` (after `retry-after`, else 1, 2, 4 s); a run still refused ends `failed` with `rateLimited: true` |
| `PLEATKIT_ALERT_WEBHOOK` / `PLEATKIT_ALERT_EMAIL_URL` + `_TO` + `_TOKEN` | | alerts on static-rule violations, 50/80/100 % of the app's daily budget and automatic freezes ([`docs/ops/incident.md`](docs/ops/incident.md)) |
| `PLEATKIT_FREEZE` | on | `off`, or JSON `{"violationsPerHour": 3, "requestsPerMinute": 12, "userShareOfAppBudget": 0.3}`: when one user is frozen (`edits.enabled: false` for that user only) |
| `PLEATKIT_MANIFEST` / `PLEATKIT_MANIFESTS` | | path or URL of the app build's `pleatkit.manifest.json` (or a JSON map app id → path/URL): the static rules, readonly sources and core types come from it, never from the browser. **Required with `NODE_ENV=production`** |

Store-server (`@pleatkit/store-server`): `PLEATKIT_APP_ID` + `PLEATKIT_APP_KEY` + `PLEATKIT_JWT_SECRET` (one
app) or `PLEATKIT_APPS` (JSON `{ "<appId>": { "appKey": "…", "jwtSecret": "…" } }`), required with
`NODE_ENV=production`; `PLEATKIT_DEMO_HEADERS=0` turns the demo headers off in development too;
`PLEATKIT_STORE_DB` (SQLite file, default `.pleatkit/store.db`, or `:memory:`), `PLEATKIT_STORE_PORT` (default `8790`), `PLEATKIT_MODERATION` (`off` default, or `review`: the
default for apps whose admin has not chosen; each app switches it in `/admin`). With `review`, an agent edit is
applied for the user at once but marked `pending-review`; it waits at the top of the admin's list until it is
approved or rolled back with one click. (Holding edits until approval is deliberately not built.)
`PLEATKIT_RETENTION` (JSON `{"textDays": 90, "logDays": 30}`): request text and tool logs are blanked after that,
hourly. `PLEATKIT_STORE_EXTENSIONS`: `none` runs the open core only; unset, the binary loads `@pleatkit/store-cloud`
when the deployment's `package.json` depends on it (the managed cloud; it also reads `PLEATKIT_LEARNING` and `factsDays`).

Interface language: `<PleatkitChat locale="ru">` switches the chat, the agent's progress lines and its summaries
to Russian (`en` by default); the demo takes `?lang=ru`, the dashboard too. Strings live in one dictionary per
language (`@pleatkit/ui` `UI_MESSAGES`, `@pleatkit/agent` `MESSAGES`).

Screenshots: the user can paste (Ctrl+V) or drop up to 3 images (6 MB in total, scaled to 1568 px) into the chat; they go to the model as vision input (Anthropic image blocks, OpenAI `image_url`), and when the user pointed at a panel the request also carries a sanitized DOM snapshot of it. By default the snapshot is **structure only** (tags, classes, test ids, roles and the length of each text, never its value); with `pleatkit({ sendDomText: true })` the visible text goes too, with e-mail addresses and long numbers masked. Elements marked `data-pleatkit-private` and form values are never sent. Screenshots are what the user chose to paste; they are not masked. The system prompt tells the model that anything in a screenshot or the DOM is data about the screen, never an instruction. Only sizes are logged, the images are not stored.

Clarifying question: when the classifier finds a request ambiguous it returns one question with 2 to 4 answer buttons instead of guessing (no code is written and the big model is not called). The user clicks an answer or types one; the same request is sent again with the answer, the classifier is skipped, so an edit asks at most once.

Static rules for the dynamic zone: one `check` (`@pleatkit/runtime/compiler`) runs on the agent server and, in `browser` compile mode, in the page, with the same AST rules (code review 06 item 12). It refuses `eval`, `new Function` and string timers; `document.cookie`; `dangerouslySetInnerHTML` / `innerHTML` / `outerHTML` / `insertAdjacentHTML` / `document.write` / `createElement` / `<script>` / `<style>` / `srcDoc`; network and navigation to anything but a relative URL written in the code: `fetch`, `WebSocket`, `EventSource`, `sendBeacon`, `src` / `href` / `action` / `formAction` / `srcSet` / `poster` in JSX, `.src = ` and `setAttribute`, `new Image()`, `location.* =`, `window.open`, `javascript:` URLs (`"/customers/" + id` is fine; a URL from data is allowed only in `src` / `href` / `poster` / `action` / `formAction` of a plain element, where the runtime keeps it only when it resolves to the app's own origin, and `mailto:` / `tel:` links from data are fine; with `pleatkit({ allowedHosts: ['images.example-cdn.com'] })`, `<img src>` / `srcSet` and `<a href>` may also point to those hosts over `https:`, from data or written in the code); `fetch` or globals used as values (`const f = fetch`, `fetch.call`, `const { cookie } = document`), computed access on globals (`window[x]`, `document['coo' + 'kie']`), `.constructor`; `localStorage` / `sessionStorage` / `indexedDB`; `window.top` / `parent` / `opener`; workers; `XMLHttpRequest`; `import()` of URLs or computed specifiers and imports outside the externals and the zone; absolute or computed `url()` in styles, strings and Tailwind classes (`bg-[url(https://…)]`). `.css` files of the zone are checked too: no remote `url()` or `@import`, no global selectors (`html`, `body`, `:root`, `*`) and nothing aimed at pleatkit's own UI. With `pleatkit({ protected: ['[data-consent]'] })` the listed elements must stay in their panels and must not be hidden. The context of the rules comes from the server's manifest (`PLEATKIT_MANIFEST`), not from the browser. A violation comes back to the model like a compile error (`file:line:col text [rule]`), is logged as a violation for the admin, and `finish` refuses to commit until it is fixed. The Content-Security-Policy is the second line: `img-src 'self' data:; form-action 'self'; connect-src 'self'` (see the CSP section).

**How the Anthropic provider calls Claude:** official `@anthropic-ai/sdk`; `claude-haiku-5-5` classifies the
request first with a structured output (backend work goes straight to the admin, the big model is not called;
when the user pointed at a panel the classifier is skipped);
`claude-sonnet-5-5` then works with adaptive thinking, `output_config.effort: "medium"`, five tools with
`strict: true` (`list_files`, `read_file`, `write_file` limited to the dynamic zone, `check`, `finish`), one
`cache_control` breakpoint covering the tools, the instructions, the readonly sources and the core types, and an
append-only history (thinking blocks are passed back unchanged). `finish` re-runs the check and refuses while the
code does not compile, so the model gets the errors and fixes them.

## Compile modes and Content Security Policy

Edits are compiled in one of two places (`pleatkit({ compile })`, V1 B1):

- **`server` (default).** The agent server compiles the snapshot with native esbuild (and the app's Tailwind
  input), checks it with the same static rules as the agent's `check`, signs it with the app key and stores it.
  The browser loads it from the app's own origin, `/pleatkit/b/<app>/<key>.js` (+ `.css`, `.json` with the
  signature), with a `<script type="module" integrity="sha384-…">` and `import()` of the same URL, so what runs is
  exactly what was signed. Route `/pleatkit/b` of the app to store-server's `/v1/b` (or the agent's `/agent/v1/b`
  when there is no store-server). After a chat edit the agent already compiled the result, so the commit is a
  download: send → repaint **69–81 ms median** over three runs with the scripted agent on localhost (browser
  compile: 79–95 ms; `docs/metrics-stage4a.json`).
- **`browser`.** esbuild-wasm (14 MB, 3.8 MB gzip) and the Tailwind compiler run in the page; edits load from
  `blob:` URLs. Useful in development and with `LocalStore` without an agent server. If WebAssembly cannot load
  (CSP, a proxy that blocks `.wasm`, iOS memory), the runtime switches to `server` by itself.

With a public key in the build (`PLEATKIT_PUBLIC_KEY`, or `pleatkit({ publicKey })`; `npx pleatkit keys public`
prints it) the runtime runs only bundles signed by the app key (ed25519, V1 A3): a bundle changed in storage, on a
CDN or on the wire is refused and the user sees the original version. A public key always means `server` mode.

CSP for `server` mode (checked in e2e with `?csp=strict-no-blob`: no `blob:`, no WebAssembly, no workers):

```
script-src 'self';                  # signed edits load from /pleatkit/b on the app's origin
style-src 'self' 'unsafe-inline';   # runtime CSS of edits is a <style> element
connect-src 'self';                 # agent server and store-server behind the same origin (or list them)
img-src 'self' data:;               # the static rules refuse remote images; the CSP is the second line (05 #1);
                                    # with allowedHosts, add https://<each host> here and nowhere else (63.1)
form-action 'self';                 # no form posts to another site, whatever an edit renders
```

CSS of edits cannot reach the host app or pleatkit's UI: the zone's `.css` is confined to the panels with
`@scope ([data-pleatkit-id])`, all edit CSS sits in `@layer pleatkit-edits` below the app's own unlayered CSS, and
the chat drawer renders in a shadow root (`<PleatkitChat shadow={false}>` renders it in place).

CSP for `browser` mode (checked in e2e with `?csp=strict`):

```
script-src 'self' blob: 'wasm-unsafe-eval';   # blob: modules of edits; WebAssembly for the compiler
worker-src blob:;
style-src 'self' 'unsafe-inline';
connect-src 'self';
```

`'wasm-unsafe-eval'` is required in `browser` mode: without it Chrome refuses `WebAssembly.compile()`. No
`'unsafe-inline'` for scripts is needed in either mode.

The `isolated` mode renders a panel in an `<iframe sandbox="allow-scripts" srcdoc>`; the frame inherits the
page's CSP. Its host script is a separate file (`assets/pleatkit-isolated-host-<hash>.js`), loaded with
`crossorigin="anonymous"` from the opaque-origin frame (`Origin: null`), so **serve that one file with
`Access-Control-Allow-Origin: *`** (Vite dev and `vite preview` do it for you; on a CDN or nginx add the header for
`/assets/pleatkit-isolated-host-*`). Server bundles are loaded inside the frame by URL too; store-server and the
agent serve `/v1/b/` with `Access-Control-Allow-Origin: *` (public, immutable, content-addressed files). If the
host never starts, the panel shows an error after 15 s.

## Runtime reliability

- **Safe mode (V1 B2).** Before a user's version goes live the runtime writes a boot record (localStorage); once
  the page has stayed responsive for a second after the swap it is marked mounted. If the previous load of that
  version never got there (a render or effect that loops forever, a crash) and the tab was not simply closed in
  the first 5 s, the next start shows the original version with a banner ("Try my version again" / "Reset to
  the original"). `?pleatkit=safe` forces it.
- **Error boundary (V1 B3).** A panel error rolls the edit back only when the stack has frames of the edit's
  bundle (`pleatkit://…`, `/pleatkit/b/…` or `blob:`); an error thrown by the app's own code (bad data, a host
  hook) shows "not caused by your edit" with "Try again" instead.
- **State on swap (V1 B4).** Text in inputs and textareas (with focus and selection) and scroll positions inside
  a panel survive a new version of it (matched by `data-testid`, `name` or `id`, else by position).
- **Releases (V1 B5).** Snapshots record a hash per base file. After a release, edits to files the release did not
  change are carried over by themselves (a new snapshot; undo returns to the old one); only panels both sides
  changed are marked stale (`data-pleatkit-stale`), and the banner offers reset or "ask the agent".
- **Instances (V1 B6).** Each app instance (namespace = `appId`) has its own externals registry
  (`globalThis.__pleatkit.apps[appId]`) and stylesheet. Externals are registered lazily (`() => import()`), so a
  library only edits use loads when such an edit runs. One esbuild version (0.28.2) in the browser, the agent and
  the plugin; peers React 18–19, Vite 6–8 (React 18 checked by `apps/react18-smoke`); the demo runs under
  `StrictMode`.
- **Error reporting (V1 B7).** Every bundle ends with `//# sourceURL=pleatkit://<bundle>/bundle.js`;
  `engine.tags()` / `usePleatkitTags()` give `pleatkit.snapshotId`, `pleatkit.bundle`, `pleatkit.app`, e.g.
  `Sentry.setTags(usePleatkitTags())`.

## Security model and limits of the demo

- Each user's edits run in that user's own browser and are visible only to them (an edit can only harm the
  person who asked for it). `isolated` panels additionally run in an opaque-origin iframe with no access to the
  page, its cookies or storage; props cross by `postMessage`, so they must be serializable.
- The agent server is stateless; the browser is the source of truth for files and re-checks everything before
  committing. Writes outside the dynamic zone are refused and logged as violations.
- **Authentication (V1 A1).** With `NODE_ENV=production`, store-server and the agent server refuse to start
  without credentials: an app key `mk_live_…` (server to server: agent → store-server, and the seed of the
  bundle-signing key) and a user-JWT secret. Your backend mints a 15-minute HS256 user token after its own
  sign-in check, and the browser sends it as `Authorization: Bearer …`:

  ```ts
  import { mintUserToken } from '@pleatkit/store-server/token' // also in @pleatkit/runtime/security
  const token = await mintUserToken({ secret: process.env.PLEATKIT_JWT_SECRET!, userId: user.id, appId: 'crm', orgId: user.orgId, role: user.isAdmin ? 'admin' : 'user' })
  // browser: new HttpStore({ baseUrl: '/pleatkit-store', userId, appId: 'crm', token: getToken }); <PleatkitChat token={getToken} />
  ```

  `npx pleatkit keys new` prints a fresh app key, JWT secret and public key. The demo headers
  (`x-pleatkit-user` / `x-pleatkit-admin` / `x-pleatkit-agent`) work only outside production and only for apps
  without credentials; e2e runs the token path on `?app=e2e-secure&auth=token`.
- **Quotas (V1 A4).** On by default, as per-app data (plan `free` unless store-server has another plan for the
  app, `PUT /v1/admin/plan`): dollars per edit (the loop stops), dollars and edits per user per day, dollars and
  edits per app per day, server compiles per user per day. Token buckets refill evenly over 24 h; they live in
  store-server's SQLite when `PLEATKIT_STORE_URL` is set, otherwise in the agent process. Over the limit the user
  gets one fixed sentence and no model is called. Requests that are not about the app at all (poems, general
  questions) are refused by the classifier with one cheap reply.
- **AI disclaimer (V1 A5).** The chat drawer always shows "AI answers can be inaccurate. Check the result."
- No server-side type checking (esbuild only strips types). Edits that conflict with a release (both changed the
  same file) are not merged automatically: the panel is marked stale; the user resets or asks the agent.

## Data, operations and versions (V1 F)

- **Tenancy and placement (F1, F2).** Every row in store-server carries `app_id`, `org_id` (from the user token's
  `org` claim, `default` otherwise) and, where it describes something that happened, `region`
  (`PLEATKIT_REGION`) and `environment` (the token's `env` claim, else `PLEATKIT_ENVIRONMENT`).
- **Usage ledger (F3).** An append-only `events` table (UPDATE and DELETE are refused by triggers):
  `edit.requested`, `tokens.used` (per model) and `cost.usd` from the agent server; `edit.applied`,
  `edit.reverted` (user undo or admin), `edit.alive24h` (hourly sweep: the edit is still in the user's version a
  day later) and `editor.active` (once per user per day) from store-server. Retries never count twice (dedupe
  keys). `GET /v1/admin/events`.
- **Versions (F4).** The store API is under `/v1/` (the unversioned routes remain as aliases); snapshots carry
  `schemaVersion`; every request records the agent's `promptVersion` and model; bundle keys include the compiler
  version (`esbuild@0.28.2+f3`).
- **Idempotency (F5).** Writes to store-server and `POST /agent/v1/run` accept `Idempotency-Key`: a retry gets the
  first response (`Idempotent-Replayed: true`) instead of a second write or a second model run; the same key with
  a different body is refused (422). `HttpStore` and the chat send keys and retry once on network errors.
- **Flags and kill switch (F6).** `PUT /v1/admin/flags { scope: 'app' | 'org' | 'user', scopeId, key, value }`;
  user overrides org overrides app. `pleatkit.enabled: false` shows everyone the original version, hides the
  chat and makes the agent refuse; `edits.enabled: false` keeps versions but takes no new edits. Read by the
  runtime (`GET /v1/flags`) and the agent server (cached 15 s).
- **Audit (F7).** An append-only `audit` table with one SHA-256 hash chain per app: snapshot writes, head moves,
  requests, links, admin actions, settings, plan, flags, stored bundles, exports, each with its actor.
  `GET /v1/admin/audit?verify=1` recomputes the chain and names the first broken row.
- **Export (F9).** `npx pleatkit export --store <url> --app <id> [--user <id>]` (authenticates with
  `PLEATKIT_APP_KEY`) writes one JSON file: snapshots with their files, heads, requests, events, and for an app
  the audit chain, flags, settings and plan (`GET /v1/admin/export`).
- **Erasure (DECISIONS 70.2).** `npx pleatkit erase --user <id> --app <id>` (or `--app <id>` alone for the whole
  app) deletes everything the store keeps about the subject: snapshots, heads, requests, usage events, bundles made
  from the user's files, run records, flags, quota buckets, request labels, and the rows of any loaded extension.
  The first run prints what would go and a confirm token; `--confirm <token>` erases. One audit row stays, a
  tombstone with the counts and a random id, without personal data. Admin only (`DELETE /v1/admin/users/:id`,
  `DELETE /v1/admin/apps/:id`). [docs/security/retention.md](docs/security/retention.md).
- **Plans as data (F14).** Limits live in the default plan table of the agent server and per app in store-server
  (`PUT /v1/admin/plan`); see "Quotas" above.
- **Roles (C8).** User tokens carry `role: 'user' | 'admin'`: a user reads and writes their own version, an admin
  every user's and the /admin routes. Other roles and acting as another user (`x-pleatkit-act-as`) are refused with
  403 `cloud-feature` unless a store extension provides them (the pleatkit cloud's `support` role and "view as a
  user"). [docs/support-playbook.md](docs/support-playbook.md).
- **In the pleatkit cloud only (DECISIONS 89).** The pilot report (`GET /v1/report`), the wish map, carrying users'
  edits over to a new release with its rollback, code search across versions with rollback by selection, the
  `support` role and the weekly digest. In the open store these routes answer 404; the open CLI has no `digest` or
  `carry-over` command.
- **Bug reports.** `pleatkit report` writes `pleatkit-report.md` (doctor, versions, redacted config). Security
  reports: [SECURITY.md](SECURITY.md). Support matrix: [SUPPORTED.md](SUPPORTED.md). Plans: [docs/ROADMAP.md](docs/ROADMAP.md).

### Telemetry (F8)

`@pleatkit/cli` and `@pleatkit/vite-plugin` can send anonymous install-funnel events: the event name
(`plugin.build`, `plugin.dev`, `doctor.run`, `doctor.fail:<check>`, `ping.ok`, `ping.fail`, `keys.new`,
`export.run`), a few enum-like properties (compile mode, CSS mode, Vite major), the package version, the Node
major, the OS platform and a random install id kept in `~/.pleatkit/telemetry.json`. Never code, file names,
paths, URLs, keys or user data (values with `/`, `\`, `:` or spaces are dropped before sending).
**Off** with `PLEATKIT_TELEMETRY=0`, `DO_NOT_TRACK=1` or in CI. In this version no collector exists yet, so
nothing is sent and no install id is written unless `PLEATKIT_TELEMETRY_URL` is set; the first event that is
sent prints a one-line notice.

### Open source and closed parts (F12)

- `packages/runtime`, `vite-plugin`, `ui`, `agent`, `cli` and `apps/*`, `examples/*`: MIT, published to npm
  (once publishing is enabled, `docs/RELEASING.md`). They depend on nothing closed.
- `packages/store-server`: MIT and published since 0.2 (DECISIONS 70.1): the store you self-host. The open
  packages know it only through the HTTP contract (`HttpStore`, the agent's `StoreClient`), so any store with the
  same `/v1` API is a drop-in replacement.
- The managed cloud's extension package (`@pleatkit/store-cloud`) is private and lives in the pleatkit-cloud
  repository; nothing in this repository depends on it.

### Changelog and breaking changes (F11)

Changes are listed per version in [`CHANGELOG.md`](CHANGELOG.md). Policy, from the first public release:
semantic versioning per package; while the version is `0.x`, a minor bump (`0.1` → `0.2`) may break and every
break is marked **Breaking** in the changelog with the migration step. Wire contracts are versioned separately
and never broken in place: the HTTP API lives under `/v1/` (a breaking change gets `/v2/` while `/v1/` keeps
working for at least two minor releases), snapshots carry `schemaVersion` (old snapshots are always readable),
bundle keys include the compiler version (a compiler change rebuilds bundles instead of reusing them). Event
and audit names are append-only: new names are added, existing ones never change meaning.

## Develop

```bash
pnpm build        # all packages + demo
pnpm test         # Vitest: runtime, vite-plugin, ui, agent (fake model APIs), store-server
pnpm e2e          # Playwright, headless, scripted provider: the four scenarios through the chat, admin, isolation
pnpm dev:smoke    # starts `pnpm dev` on spare ports, checks all servers + one agent run, stops it, checks nothing is left
pnpm lint && pnpm typecheck

# with a real key (spends tokens):
pnpm agent:live   # scenario 1 on Claude without a browser: timings, usage, cost -> docs/metrics-anthropic.json
PLEATKIT_LIVE=1 pnpm e2e:live   # scenario 1 through the chat on Claude, request -> re-render
```
