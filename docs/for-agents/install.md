# Install morphkit into a Vite + React app

Every step: **run** the command, **expect** the output, and if it differs, do what **if not** says. Paths: `<APP>` is the app folder (run commands there unless a step says otherwise), `<MORPHKIT>` is a local checkout of morphkit. Use forward slashes in paths, also on Windows.

The commands use pnpm; with npm use `npm install` / `npx` instead of `pnpm add` / `pnpm exec`.

## Step 0. Prerequisites

Run:

```bash
node -v && pnpm -v
```

Expect: `v22.x` or newer, then `10.x` or newer.

If not: install Node 22 LTS and pnpm 10 (`npm install -g pnpm@10`). The app must use React 19 and Vite 6 or 7: check with `pnpm list react vite` in `<APP>`.

## Step 1. Get the morphkit packages

morphkit is not published to npm yet; build it from a checkout (one time):

```bash
git clone https://github.com/Kappatich/morphkit.git <MORPHKIT>
cd <MORPHKIT>
pnpm install
pnpm build:packages
```

Expect: the last lines end with `Done`, and this prints `5 packages built`:

```bash
node -e "const fs=require('fs');const ps=['vite-plugin','runtime','ui','agent','cli'];ps.forEach(p=>fs.accessSync('packages/'+p+'/dist/index.js'));console.log(ps.length+' packages built')"
```

If not: `pnpm build:packages` prints the failing package first; fix that (usually a Node older than 22).

## Step 2. Add the packages to the app

In `<APP>`:

```bash
pnpm add link:<MORPHKIT>/packages/runtime link:<MORPHKIT>/packages/ui
pnpm add -D link:<MORPHKIT>/packages/vite-plugin link:<MORPHKIT>/packages/agent link:<MORPHKIT>/packages/cli @types/node@^22
```

If the app uses Tailwind 4 already, nothing more. To let edits use Tailwind classes in an app without it:

```bash
pnpm add -D tailwindcss@^4 @tailwindcss/vite@^4
```

Expect: lines like `+ @morphkit/runtime 0.1.0 <- ../morphkit/packages/runtime` for all five packages, then `Done`.

If not:
- `ERR_PNPM_...workspace`, or pnpm installs a different project: the app is inside another pnpm workspace. Add `--ignore-workspace` to every `pnpm add` / `pnpm install` in the app.
- Once morphkit is on npm, the same step is `pnpm add @morphkit/runtime @morphkit/ui && pnpm add -D @morphkit/vite-plugin @morphkit/agent @morphkit/cli`.

## Step 3. Configure Vite

Edit `vite.config.ts` so it has the morphkit plugin, the `@` alias, one React and two proxies: `/agent` (the agent server) and `/morphkit/b` (the signed bundles of edits it compiles; edits are compiled on the server by default, `compile: 'server'`). A complete file for an app with Tailwind:

```ts
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import morphkit from '@morphkit/vite-plugin'

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    morphkit({
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
    dedupe: ['react', 'react-dom'], // required while morphkit is linked from a checkout
  },
  server: { proxy: { '/agent': 'http://localhost:8789', '/morphkit/b': { target: 'http://localhost:8789', rewrite: (p) => p.replace(/^\/morphkit\/b/, '/agent/v1/b') } } },
  preview: { proxy: { '/agent': 'http://localhost:8789', '/morphkit/b': { target: 'http://localhost:8789', rewrite: (p) => p.replace(/^\/morphkit\/b/, '/agent/v1/b') } } },
})
```

With store-server (`HttpStore`), point `/morphkit/b` at store-server's `/v1/b` instead: it keeps the bundles across agent restarts. `compile: 'browser'` in the plugin options compiles in the page with esbuild-wasm instead (no `/morphkit/b` proxy needed, but the CSP must allow `blob:` and `'wasm-unsafe-eval'`).

Keep the app's existing plugins and options; add only what is missing. With Tailwind, `src/index.css` must start with `@import "tailwindcss";`. If the app has a UI kit the panels should use (for example `src/components/ui/*`), add it to `readonly` and to `externals` (`'@/components/ui/*'`).

Run:

```bash
pnpm exec morphkit doctor
```

Expect: a line `[ok]   config: morphkit plugin found in vite.config.ts` (other checks may still fail until step 6).

If not: `[FAIL] config: no morphkit plugin` means the plugin is not in `plugins`; `could not load the Vite config` prints the error from Vite (usually a missing package from step 2).

## Step 4. TypeScript

In the tsconfig that covers `src` (`tsconfig.app.json` in a `create vite` app, otherwise `tsconfig.json`), inside `compilerOptions` add:

```json
"types": ["vite/client", "@morphkit/vite-plugin/client"],
"paths": { "@/*": ["./src/*"] }
```

If `types` already exists, add the two entries to it. Run:

```bash
pnpm exec tsc -b
```

Expect: no output, exit code 0 (or the app's usual type check command passes).

If not: `Cannot find module 'virtual:morphkit'` means the `types` entry is missing; `Cannot find module '@/...'` means `paths` is missing; `Cannot find module 'node:url'` means `@types/node` from step 2 is missing.

## Step 5. Create the zones

1. Pick the panels users may change (see "Decide the zones" in [AGENTS.md](AGENTS.md)). For each one, move the component to `src/dynamic/<id>.tsx` with `export default`. `<id>` is lowercase with dashes, for example `orders-table`.
2. Move what those panels import from the app (types, API client, formatters) to `src/readonly/` and import it as `@/readonly/<file>`. Dynamic files may import only other dynamic files, `react`, and what is in `externals`.
3. Where the app rendered the panel, render it through `<Dynamic>` and pass its props:

```tsx
import { Dynamic } from '@morphkit/runtime'

<Dynamic id="orders-table" props={{ orders }} />
```

Run:

```bash
pnpm exec morphkit doctor
```

Expect: `[ok]   panels: 1 <Dynamic> panel, each with a file and a default export` (with your count) and `[ok]   externals: N externals resolve`.

If not: the `[FAIL]` line names the id and the file; create the file, add `export default`, or fix the id. An external that does not resolve is either a typo or a file that does not exist under `src/`.

## Step 6. Wrap the app and add the chat

In the entry file (`src/main.tsx`), wrap the app in `MorphkitProvider` and add `MorphkitChat`:

```tsx
import * as config from 'virtual:morphkit'
import { LocalStore, MorphkitProvider } from '@morphkit/runtime'
import { MorphkitChat } from '@morphkit/ui'

const store = new LocalStore('my-app') // edits stay in this browser; HttpStore for server-side storage
const userId = currentUser.id // the signed-in user; each user gets their own version

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <MorphkitProvider config={config} store={store} userId={userId}>
      <App />
      <MorphkitChat agentUrl="/agent" />
    </MorphkitProvider>
  </StrictMode>,
)
```

If the app has no users yet, use a fixed id such as `'demo-user'`. `<MorphkitChat locale="ru">` switches the chat to Russian.

Run:

```bash
pnpm build
```

Expect: the build ends with `✓ built in …`, the list includes `dist/morphkit.manifest.json` (and `dist/assets/esbuild-….wasm`, used only with `compile: 'browser'` or as a fallback).

If not: see [troubleshooting.md](troubleshooting.md) ("Build fails").

## Step 7. Run the agent server

Add a script to the app's `package.json`: `"agent": "morphkit-agent"`. Then, in a second terminal (it keeps running):

```bash
pnpm agent
```

Expect, without a key: `morphkit agent on http://localhost:8789/agent (provider scripted, model scripted)`. With `MORPHKIT_API_KEY=<key> pnpm agent`: `(provider anthropic, model claude-sonnet-5-5)`.

If not: `EADDRINUSE` means port 8789 is taken; set `MORPHKIT_AGENT_PORT` and change the two proxy targets in `vite.config.ts` to match.

The key lives only in this process's environment. In production run the agent as its own Node service and route `/agent` (and `/morphkit/b`, or point it at store-server) of the app's origin to it.

Production (`NODE_ENV=production`): the agent server and store-server refuse to start without `MORPHKIT_APP_ID`, `MORPHKIT_APP_KEY` (`mk_live_…`) and `MORPHKIT_JWT_SECRET`. `pnpm exec morphkit keys new` prints all three plus `MORPHKIT_PUBLIC_KEY`; put the first three in the servers' secret store, never in the repo or a `VITE_` variable. The app's backend mints a 15-minute user token per signed-in user (`mintUserToken` from `@morphkit/store-server/token`), and the app passes it to `HttpStore({ token })`, `<MorphkitChat token>` and `<MorphkitProvider token>`. Build the app with `MORPHKIT_PUBLIC_KEY` set (or `morphkit({ publicKey })`): the runtime then runs only bundles signed by the app key.

Next: [verify.md](verify.md).
