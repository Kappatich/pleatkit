# morphkit

Let the users of your web app change its interface by asking for it. An AI agent rewrites the parts of your
React app you allowed it to touch; the change is compiled in the user's browser, swapped in without a reload,
and kept as that user's personal version, with undo, history and an admin who can see and roll back every edit.

- **Three zones.** `dynamic` files the agent may rewrite, `readonly` files it may read, everything else is `core`
  (the agent only sees type declarations).
- **Snapshots, not patches.** Every edit is a full snapshot of the dynamic zone; undo is the parent snapshot.
- **Draft, check, commit.** Nothing changes until the whole zone compiles; a broken edit is refused before the
  user sees it, a panel that crashes while rendering is rolled back automatically.
- **Keys stay on your server.** The browser talks to the agent server; the model key is only in its environment.

Design: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md). Progress and measurements: [`docs/DEVLOG.md`](docs/DEVLOG.md).

## Packages

| Package | What it does | Repo |
|---|---|---|
| `@morphkit/vite-plugin` | zones, manifest (dynamic sources, readonly sources, core `.d.ts`), externals registry, fallback bundle, runtime Tailwind module, isolated-panel host | morphkit (public, MIT) |
| `@morphkit/runtime` | `<MorphkitProvider>`, `<Dynamic>`, snapshot engine (draft/check/commit/undo/redo/reset), esbuild-wasm compiler, Tailwind 4 in the browser, `LocalStore` (IndexedDB) and `HttpStore` | morphkit (public, MIT) |
| `@morphkit/ui` | chat drawer, "point at a panel" picker, history, undo/reset, toasts, stale-version banner | morphkit (public, MIT) |
| `@morphkit/agent` | Node agent server: model loop with zone-checked tools, server-side check, SSE progress, providers `anthropic` / `openai-compatible` / `scripted` | morphkit (public, MIT) |
| `@morphkit/store-server` | snapshots, heads, bundles and the request log per user; admin actions; Hono + Drizzle (SQLite in the demo) | **morphkit-cloud** (private) |
| `apps/demo-crm` | demo CRM with two users, three dynamic panels and an `/admin` dashboard | morphkit (public) |

### Two repositories

- **morphkit** (public, MIT): the library everyone can self-host: vite-plugin, runtime, ui, agent and the demo.
  With `LocalStore` it works with no backend of ours at all (bring your own model key).
- **morphkit-cloud** (private): the hosted part: `@morphkit/store-server` (Postgres through the same Drizzle schema),
  real authentication, the admin dashboard as a product, multi-tenant app namespaces, billing. `store-server` lives
  in this monorepo for now (marked `private`, `UNLICENSED`) and depends on no other morphkit package, so it can
  move out without changes; the runtime only knows the HTTP contract through `HttpStore`.

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
$env:MORPHKIT_API_KEY = "<your Anthropic key>"; pnpm dev
# bash
MORPHKIT_API_KEY=<your Anthropic key> pnpm dev
```

Ports: web 5173, data 8787, agent 8789, store-server 8790 (`WEB_PORT`, `DATA_PORT`, `AGENT_PORT`, `STORE_PORT`).

## Install into your own Vite + React project (5 steps)

**1. Install.**

```bash
pnpm add @morphkit/runtime @morphkit/ui
pnpm add -D @morphkit/vite-plugin @morphkit/agent
```

**2. Configure the Vite plugin** and proxy the agent so the browser stays on one origin:

```ts
// vite.config.ts
import morphkit from '@morphkit/vite-plugin'

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    morphkit({
      zones: {
        dynamic: ['src/dynamic/**'],                              // the agent rewrites these
        readonly: ['src/readonly/**', 'src/components/ui/**'],   // the agent reads these
      },
      // what dynamic code may import from your app (everything else is refused at check time)
      externals: ['react', 'react-dom', 'react/jsx-runtime', '@/components/ui/*', '@/lib/utils', '@/readonly/*'],
      css: 'tailwind',            // compile Tailwind 4 utilities for edits in the browser ('palette' = no runtime CSS)
      tailwindEntry: 'src/index.css',
      isolated: true,             // optional: enables <Dynamic isolated>
    }),
  ],
  server: { proxy: { '/agent': 'http://localhost:8789' } },
})
```

Add `"types": ["@morphkit/vite-plugin/client"]` to `tsconfig.json` for the `virtual:morphkit` modules.

**3. Move the panels users may change into `src/dynamic/<id>.tsx`** (each with a default-exported component) and
render them through `<Dynamic>` instead of importing them:

```tsx
<Dynamic id="customer-card" props={{ customer }} />
```

Keep types, API clients and formatting helpers the panels use in `src/readonly/`, so the agent can read them.
Give entities a free-form `meta` field if you can: many "add a field" requests then need no backend change.

**4. Wrap the app and add the chat.**

```tsx
import * as config from 'virtual:morphkit'
import { LocalStore, MorphkitProvider } from '@morphkit/runtime'
import { MorphkitChat } from '@morphkit/ui'

const store = new LocalStore()   // or new HttpStore({ baseUrl: '/morphkit-store', userId, appId })

<MorphkitProvider config={config} store={store} userId={currentUser.id}>
  <App />
  <MorphkitChat agentUrl="/agent" />
</MorphkitProvider>
```

**5. Run the agent server** next to your app, with the key in its environment only:

```bash
MORPHKIT_API_KEY=<key> npx morphkit-agent        # http://localhost:8789/agent
```

Optional: `npx morphkit-store` (store-server, SQLite) plus `HttpStore` for server-side snapshots, cross-device
versions and the admin dashboard; set `MORPHKIT_STORE_URL` on the agent so every run is logged there.

## Environment variables

Agent server (`@morphkit/agent`): keys are read from the environment only, never from the browser or from files.

| Variable | Default | Meaning |
|---|---|---|
| `MORPHKIT_PROVIDER` | `anthropic` if `MORPHKIT_API_KEY` is set, else `scripted` | `anthropic`, `openai-compatible` (also `openai`, `openrouter`), `scripted` |
| `MORPHKIT_API_KEY` | | model API key. With `MORPHKIT_PROVIDER=anthropic`, `ANTHROPIC_API_KEY` / `POLYMORPH_API_KEY` are accepted too |
| `MORPHKIT_MODEL` | `claude-sonnet-5-5` | main model (required for `openai-compatible`) |
| `MORPHKIT_CLASSIFIER_MODEL` | `claude-haiku-5-5` | request classifier (ui / needs-backend / unclear) |
| `MORPHKIT_BASE_URL` | SDK default | API base URL; for OpenRouter `https://openrouter.ai/api/v1` |
| `MORPHKIT_EFFORT` | `medium` | Anthropic effort (`low` … `max`) |
| `MORPHKIT_FALLBACKS` | on | `off` disables Anthropic server-side refusal fallback (`fallbacks: "default"`) |
| `MORPHKIT_STORE_URL` | | store-server URL; each run (request, verdict, tool log, usage) is logged there |
| `MORPHKIT_FIXTURES` | `fixtures` | directory of scripted answers (`*.json`) |
| `MORPHKIT_AGENT_PORT` | `8789` | |
| `MORPHKIT_MAX_CALLS` / `MORPHKIT_TIMEOUT_MS` / `MORPHKIT_MAX_OUTPUT_TOKENS` | `12` / `90000` / `8000` | limits per edit |
| `MORPHKIT_CORS_ORIGIN` | | allowed browser origin if the app calls the agent cross-origin |

Store-server (`@morphkit/store-server`): `MORPHKIT_STORE_DB` (SQLite file, default `.morphkit/store.db`, or
`:memory:`), `MORPHKIT_STORE_PORT` (default `8790`).

**How the Anthropic provider calls Claude:** official `@anthropic-ai/sdk`; `claude-haiku-5-5` classifies the
request first with a structured output (backend work goes straight to the admin, the big model is not called);
`claude-sonnet-5-5` then works with adaptive thinking, `output_config.effort: "medium"`, five tools with
`strict: true` (`list_files`, `read_file`, `write_file` limited to the dynamic zone, `check`, `finish`), one
`cache_control` breakpoint covering the tools, the instructions, the readonly sources and the core types, and an
append-only history (thinking blocks are passed back unchanged). `finish` re-runs the check and refuses while the
code does not compile, so the model gets the errors and fixes them.

## Content Security Policy

Edits are compiled in the browser and loaded as modules from `blob:` URLs; esbuild-wasm runs in a worker
created from a `blob:` URL. A strict CSP needs:

```
script-src 'self' blob:;
worker-src blob:;
style-src 'self' 'unsafe-inline';     # runtime CSS for edits is injected as a <style> element
connect-src 'self';                   # agent server and store-server behind the same origin (or list them)
```

The `isolated` mode renders a panel in an `<iframe sandbox="allow-scripts" srcdoc>`; the frame inherits the
page's CSP, and its host script is inlined in `srcdoc`, so it additionally needs `'unsafe-inline'` for scripts or
a hash of that script. A CSP without `blob:` in `script-src` is not supported in this version (a Service Worker
that serves modules from your own origin would lift that; it is not built).

## Security model and limits of the demo

- Each user's edits run in that user's own browser and are visible only to them (an edit can only harm the
  person who asked for it). `isolated` panels additionally run in an opaque-origin iframe with no access to the
  page, its cookies or storage; props cross by `postMessage`, so they must be serializable.
- The agent server is stateless; the browser is the source of truth for files and re-checks everything before
  committing. Writes outside the dynamic zone are refused and logged as violations.
- **Demo authorization only:** store-server trusts the `x-morphkit-user` / `x-morphkit-admin` headers. Put real
  authentication in front of it before production.
- No server-side type checking (esbuild only strips types), no merging of user edits into a new release (the
  snapshot is marked stale; the user resets or asks the agent to carry the edits over).

## Develop

```bash
pnpm build        # all packages + demo
pnpm test         # Vitest: runtime, vite-plugin, ui, agent (fake model APIs), store-server
pnpm e2e          # Playwright, headless, scripted provider: the four scenarios through the chat, admin, isolation
pnpm dev:smoke    # starts `pnpm dev` on spare ports, checks all servers + one agent run, stops it, checks nothing is left
pnpm lint && pnpm typecheck

# with a real key (spends tokens):
pnpm agent:live   # scenario 1 on Claude without a browser: timings, usage, cost -> docs/metrics-anthropic.json
MORPHKIT_LIVE=1 pnpm e2e:live   # scenario 1 through the chat on Claude, request -> re-render
```
