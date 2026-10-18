# Install pleatkit into a Vite + React app

Every step: **run** the command, **expect** the output, and if it differs, do what **if not** says. Paths: `<APP>` is the app folder (run commands there unless a step says otherwise), `<PLEATKIT>` is a local checkout of pleatkit. Use forward slashes in paths, also on Windows.

The commands use pnpm; with npm use `npm install` / `npx` instead of `pnpm add` / `pnpm exec`.

## Step 0. Prerequisites

Run:

```bash
node -v && pnpm -v
```

Expect: `v22.x` or newer, then `10.x` or newer.

If not: install Node 22 LTS and pnpm 10 (`npm install -g pnpm@10`). The app must use React 19 and Vite 6 or 7: check with `pnpm list react vite` in `<APP>`.

## Step 1. Get the pleatkit packages

pleatkit is not published to npm yet; build it from a checkout (one time):

```bash
git clone https://github.com/Kappatich/pleatkit.git <PLEATKIT>
cd <PLEATKIT>
pnpm install
pnpm build:packages
```

Expect: the last lines end with `Done`, and this prints `6 packages built`:

```bash
node -e "const fs=require('fs');const ps=['vite-plugin','runtime','ui','agent','cli','store-server'];ps.forEach(p=>fs.accessSync('packages/'+p+'/dist/index.js'));console.log(ps.length+' packages built')"
```

If not: `pnpm build:packages` prints the failing package first; fix that (usually a Node older than 22).

## Step 2. Add the packages to the app

In `<APP>`:

```bash
pnpm add link:<PLEATKIT>/packages/runtime link:<PLEATKIT>/packages/ui
pnpm add -D link:<PLEATKIT>/packages/vite-plugin link:<PLEATKIT>/packages/agent link:<PLEATKIT>/packages/cli link:<PLEATKIT>/packages/store-server @types/node@^22
```

If the app uses Tailwind 4 already, nothing more. To let edits use Tailwind classes in an app without it:

```bash
pnpm add -D tailwindcss@^4 @tailwindcss/vite@^4
```

Expect: lines like `+ @pleatkit/runtime 0.1.0 <- ../pleatkit/packages/runtime` for all six packages, then `Done`.

`@pleatkit/store-server` is the server that keeps every user's version (snapshots, the request log, the admin's levers). It runs as its own process (step 7); the browser talks to it through `HttpStore`.

If not:
- `ERR_PNPM_...workspace`, or pnpm installs a different project: the app is inside another pnpm workspace. Add `--ignore-workspace` to every `pnpm add` / `pnpm install` in the app.
- Once pleatkit is on npm, the same step is `pnpm add @pleatkit/runtime @pleatkit/ui && pnpm add -D @pleatkit/vite-plugin @pleatkit/agent @pleatkit/cli @pleatkit/store-server` (the store is open source since 0.2; with the managed cloud you point `HttpStore` at the cloud instead and skip it).

## Step 3. Configure Vite

Edit `vite.config.ts` so it has the pleatkit plugin, the `@` alias, one React and three proxies: `/agent` (the agent server), `/pleatkit-store` (store-server, the users' versions) and `/pleatkit/b` (the signed bundles of edits, kept by store-server; edits are compiled on the server by default, `compile: 'server'`). A complete file for an app with Tailwind:

```ts
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import pleatkit from '@pleatkit/vite-plugin'

const proxy = {
  '/agent': 'http://localhost:8789',
  '/pleatkit-store': { target: 'http://localhost:8790', rewrite: (p: string) => p.replace(/^\/pleatkit-store/, '') },
  '/pleatkit/b': { target: 'http://localhost:8790', rewrite: (p: string) => p.replace(/^\/pleatkit\/b/, '/v1/b') },
}

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    pleatkit({
      zones: {
        dynamic: ['src/dynamic/**'], // the agent rewrites these
        readonly: ['src/readonly/**'], // the agent reads these
      },
      // everything dynamic code may import from the app
      externals: ['react', 'react-dom', 'react/jsx-runtime', '@/readonly/*'],
      css: 'tailwind', // 'palette' if the app has no Tailwind
      tailwindEntry: 'src/index.css', // the CSS file with @import "tailwindcss"
    }),
  ],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
    dedupe: ['react', 'react-dom'], // required while pleatkit is linked from a checkout
  },
  server: { proxy },
  preview: { proxy },
})
```

Without store-server (a quick look with `LocalStore`, step 6), point `/pleatkit/b` at the agent instead: `{ target: 'http://localhost:8789', rewrite: (p) => p.replace(/^\/pleatkit\/b/, '/agent/v1/b') }`, and drop `/pleatkit-store`. `compile: 'browser'` in the plugin options compiles in the page with esbuild-wasm instead (no `/pleatkit/b` proxy needed, but the CSP must allow `blob:` and `'wasm-unsafe-eval'`).

Keep the app's existing plugins and options; add only what is missing. With Tailwind, `src/index.css` must start with `@import "tailwindcss";`. If the app has a UI kit the panels should use (for example `src/components/ui/*`), add it to `readonly` and to `externals` (`'@/components/ui/*'`).

Run:

```bash
pnpm exec pleatkit doctor
```

Expect: a line `[ok]   config: pleatkit plugin found in vite.config.ts` (other checks may still fail until step 6).

If not: `[FAIL] config: no pleatkit plugin` means the plugin is not in `plugins`; `could not load the Vite config` prints the error from Vite (usually a missing package from step 2).

## Step 4. TypeScript

In the tsconfig that covers `src` (`tsconfig.app.json` in a `create vite` app, otherwise `tsconfig.json`), inside `compilerOptions` add:

```json
"types": ["vite/client", "@pleatkit/vite-plugin/client"],
"paths": { "@/*": ["./src/*"] }
```

If `types` already exists, add the two entries to it. Run:

```bash
pnpm exec tsc -b
```

Expect: no output, exit code 0 (or the app's usual type check command passes).

If not: `Cannot find module 'virtual:pleatkit'` means the `types` entry is missing; `Cannot find module '@/...'` means `paths` is missing; `Cannot find module 'node:url'` means `@types/node` from step 2 is missing.

## Step 5. Create the zones

1. Pick the panels users may change (see "Decide the zones" in [AGENTS.md](AGENTS.md)). For each one, move the component to `src/dynamic/<id>.tsx` with `export default`. `<id>` is lowercase with dashes, for example `orders-table`.
2. Move what those panels import from the app (types, API client, formatters) to `src/readonly/` and import it as `@/readonly/<file>`. Dynamic files may import only other dynamic files, `react`, and what is in `externals`.
3. Where the app rendered the panel, render it through `<Dynamic>` and pass its props:

```tsx
import { Dynamic } from '@pleatkit/runtime'

<Dynamic id="orders-table" props={{ orders }} />
```

Run:

```bash
pnpm exec pleatkit doctor
```

Expect: `[ok]   panels: 1 <Dynamic> panel, each with a file and a default export` (with your count) and `[ok]   externals: N externals resolve`.

If not: the `[FAIL]` line names the id and the file; create the file, add `export default`, or fix the id. An external that does not resolve is either a typo or a file that does not exist under `src/`.

## Step 6. Wrap the app and add the chat

In the entry file (`src/main.tsx`), wrap the app in `PleatkitProvider` and add `PleatkitChat`:

```tsx
import * as config from 'virtual:pleatkit'
import { HttpStore, PleatkitProvider } from '@pleatkit/runtime'
import { PleatkitChat } from '@pleatkit/ui'

const userId = currentUser.id // the signed-in user; each user gets their own version
// every user's version lives in store-server: it follows them to other browsers, and /admin can see and roll it back
const store = new HttpStore({ baseUrl: '/pleatkit-store', userId, appId: 'my-app' })

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <PleatkitProvider config={config} store={store} userId={userId}>
      <App />
      <PleatkitChat agentUrl="/agent" />
    </PleatkitProvider>
  </StrictMode>,
)
```

If the app has no users yet, use a fixed id such as `'demo-user'`. `<PleatkitChat locale="ru">` switches the chat to Russian.

For a quick look without store-server, `new LocalStore('my-app')` keeps the edits in this browser (IndexedDB) instead: no admin view, nothing on other devices. Switch to `HttpStore` before anyone else uses the app.

Run:

```bash
pnpm build
```

Expect: the build ends with `✓ built in …`, the list includes `dist/pleatkit.manifest.json` (and `dist/assets/esbuild-….wasm`, used only with `compile: 'browser'` or as a fallback).

If not: see [troubleshooting.md](troubleshooting.md) ("Build fails").

## Step 7. Run store-server and the agent server

Add two scripts to the app's `package.json`: `"store": "pleatkit-store"` and `"agent": "pleatkit-agent"`, and `.pleatkit/` to `.gitignore` (store-server's SQLite file). Then, in two more terminals (both keep running):

```bash
pnpm store
PLEATKIT_STORE_URL=http://localhost:8790 pnpm agent
```

Expect: `pleatkit store-server on http://localhost:8790 (.pleatkit/store.db; no credentials, demo headers ON (development only))`, then, without a key, `pleatkit agent on http://localhost:8789/agent (provider scripted, model scripted)`. With `PLEATKIT_API_KEY=<key>` on the agent: `(provider anthropic, model claude-sonnet-5-5)`. On Windows `cmd`, set the variable first: `set PLEATKIT_STORE_URL=http://localhost:8790 && pnpm agent`.

If not: `EADDRINUSE` means port 8790 or 8789 is taken; set `PLEATKIT_STORE_PORT` / `PLEATKIT_AGENT_PORT` and change the proxy targets in `vite.config.ts` to match. A store-server that exits with `refusing to start without credentials` runs with `NODE_ENV=production`: see below.

The model key lives only in the agent's environment. In production run both as their own Node services and route `/agent`, `/pleatkit-store` and `/pleatkit/b` of the app's origin to them ([production.md](production.md)).

Production (`NODE_ENV=production`): the agent server and store-server refuse to start without `PLEATKIT_APP_ID`, `PLEATKIT_APP_KEY` (`mk_live_…`) and `PLEATKIT_JWT_SECRET`. `pnpm exec pleatkit keys new` prints all three plus `PLEATKIT_PUBLIC_KEY`; put the first three in the servers' secret store, never in the repo or a `VITE_` variable. The app's backend mints a 15-minute user token per signed-in user (`mintUserToken` from `@pleatkit/store-server/token`), and the app passes it to `HttpStore({ token })`, `<PleatkitChat token>` and `<PleatkitProvider token>`. Build the app with `PLEATKIT_PUBLIC_KEY` set (or `pleatkit({ publicKey })`): the runtime then runs only bundles signed by the app key.

Next: [verify.md](verify.md).
