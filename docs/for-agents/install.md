# Install pleatkit into a Vite + React app

Every step: **run** the command, **expect** the output, and if it differs, do what **if not** says. Paths: `<APP>` is the app folder (run commands there unless a step says otherwise), `<PLEATKIT>` is a local checkout of pleatkit. Use forward slashes in paths, also on Windows.

The commands use pnpm; npm works too (step 2 shows its form, and `npx` replaces `pnpm exec`). Tested on a fresh `create vite` app and on four existing open-source apps: shadcn-admin (pnpm, Tailwind, TanStack Router), TailAdmin (npm, Tailwind, React Router), an Ant Design dashboard (pnpm 9, Vite 5 → 6, React Router, TanStack Query, no Tailwind) and a CSS-modules dashboard (npm, Vite 8, React Router, TanStack Query, no Tailwind). Everything you need is in this folder (`docs/for-agents/`); links outside it are background only.

## Step 0. Prerequisites

If the app has no `node_modules` yet, install its own dependencies first with its own package manager (`pnpm install --frozen-lockfile`, or `npm ci`; if an install script of one of its dependencies fails, add `--ignore-scripts`, see step 2) and check that its `build` passes before you change anything.

Run:

```bash
node -v && pnpm -v
```

Expect: `v22.x` or newer, then `10.x` or newer. pnpm is needed for the checkout in step 1; an npm app itself stays on npm (use the npm forms of the commands).

If not: install Node 22 LTS and pnpm 10 (`npm install -g pnpm@10`). An app that pins pnpm 9 in `package.json#packageManager` switches pnpm to 9.x inside its folder: that works too, keep the pin.

The app must use React 18 or 19 and Vite 6, 7 or 8: check with `pnpm list react vite` (or `npm ls react vite`) in `<APP>`. **Vite 5 or older:** upgrade to Vite 6 first, the smallest supported step (`pnpm add -D vite@^6`, and the app's Vite plugins to a version that supports Vite 6, e.g. `@vitejs/plugin-react@^4` or `@vitejs/plugin-react-swc@^3.8`; check the installed version first with `pnpm list @vitejs/plugin-react @vitejs/plugin-react-swc`: if the lockfile already has a version that supports Vite 6, leave the plugin and its range as they are; `ERR_PNPM_ADDING_TO_ROOT` means the app has its own `pnpm-workspace.yaml`: add `-w`, here and in step 2; if the app's own install needed `--ignore-scripts`, add it here too), then check that the app's own `build` still passes before going on. pnpm does not warn about it: packages added with `link:` are not checked against their peer ranges.

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

In `<APP>`, with `<PLEATKIT>` written **relative to the app** (`../pleatkit`): pnpm stores the path as you type it, so an absolute path (`C:/Users/…/pleatkit`) ends up in `package.json` and `pnpm-lock.yaml` and works only on your machine.

```bash
pnpm add link:<PLEATKIT>/packages/runtime link:<PLEATKIT>/packages/ui
pnpm add -D link:<PLEATKIT>/packages/vite-plugin link:<PLEATKIT>/packages/agent link:<PLEATKIT>/packages/cli link:<PLEATKIT>/packages/store-server
```

With npm (it has no `link:`; a folder path makes the same symlink):

```bash
npm install <PLEATKIT>/packages/runtime <PLEATKIT>/packages/ui
npm install -D <PLEATKIT>/packages/vite-plugin <PLEATKIT>/packages/agent <PLEATKIT>/packages/cli <PLEATKIT>/packages/store-server
```

`vite.config.ts` imports `node:url`: if the app has no `@types/node` yet, add it (`pnpm add -D @types/node@^22`). Keep the app's own version when it has one; do not downgrade it.

If the app uses Tailwind 4 already, nothing more. To let edits use Tailwind classes in an app without it:

```bash
pnpm add -D tailwindcss@^4 @tailwindcss/vite@^4
```

Expect: lines like `+ @pleatkit/runtime 0.3.0 <- ../pleatkit/packages/runtime` for all six packages, then `Done` (npm: `added N packages`, and `node_modules/@pleatkit/*` are links to the checkout).

`@pleatkit/store-server` is the server that keeps every user's version (snapshots, the request log, the admin's levers). It runs as its own process (step 7); the browser talks to it through `HttpStore`.

If not:
- `ERR_PNPM_...workspace`, or pnpm installs a different project: the app is inside another pnpm workspace. Add `--ignore-workspace` to every `pnpm add` / `pnpm install` in the app.
- `ERR_PNPM_ADDING_TO_ROOT`: the app has its own `pnpm-workspace.yaml` (a one-package workspace, `packages: ['.']`), so it is a workspace root. Add `-w` to every `pnpm add`. pnpm 9 may then print lines like `… is already in devDependencies, was not moved`: harmless.
- An absolute path in the specs (`link:C:/Users/…`): rewrite it to the relative form (`link:../pleatkit/packages/runtime`) in both files, then `pnpm install --frozen-lockfile` must pass.
- `pnpm add` fails in another package's install script (for example a Windows path-length error in a Storybook addon's postinstall): pleatkit's packages need no install scripts, so `pnpm add --ignore-scripts …` is safe; the app's own scripts are its business.
- On Windows pnpm writes the specs with backslashes (`link:..\pleatkit\packages\runtime`) in `package.json` and `pnpm-lock.yaml`, whatever you typed: replace them with forward slashes in both files (they work on every OS), then `pnpm install --frozen-lockfile` must pass. A command that does it (bash; it touches only `link:` specs):

  ```bash
  node -e "const fs=require('fs');for(const f of ['package.json','pnpm-lock.yaml'])fs.writeFileSync(f,fs.readFileSync(f,'utf8').replace(/link:[^\s\",']+/g,(m)=>m.split(String.fromCharCode(92)).filter(Boolean).join('/')))"
  ```
- npm: `Unsupported URL Type "link:"`: use the folder paths of the npm form above.
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

Keep the app's existing plugins and options; add only what is missing. Other aliases stay: the `'@'` entry matches only imports that start with `@/`, not `@mocks/…` or a scoped package such as `@ant-design/icons`. If the config imports `defineConfig` from `vitest/config` (with a `test` block), keep it. A separate `vitest.config.ts` needs the same `@` alias only if a test imports a page that renders `<Dynamic>` or a `src/readonly` module; vitest keeps its own Vite and needs no upgrade. If the app resolves `@` with Vite 8's `resolve.tsconfigPaths: true`, still add `resolve.alias` for `@` as above: pleatkit's virtual modules (`virtual:pleatkit/externals` imports `@/readonly/*`) are outside every tsconfig, so `tsconfigPaths` does not resolve their imports.

**An app without Tailwind** (CSS modules, plain CSS, CSS-in-JS, or a component library such as Ant Design, MUI, Mantine or Chakra): use `css: 'palette'` and no `tailwindEntry`, and do not add Tailwind for pleatkit (its reset would restyle the app). Edits then style the way the panel already does: the app's components (list the library and its icon package in `externals`: `'antd'`, `'@ant-design/icons'`), inline styles and the app's CSS variables, and CSS modules inside the dynamic zone (step 5). The agent is told the app has no Tailwind. With Tailwind, the entry CSS must have `@import "tailwindcss";` (pass its path as `tailwindEntry` when it is not `src/index.css`, e.g. `src/styles/index.css`). An app that runs Tailwind through PostCSS (`@tailwindcss/postcss`, no `@tailwindcss/vite`) keeps its PostCSS setup; `css: 'tailwind'` works the same.

What the panels import goes into `externals`:
- the app's UI kit (for example `src/components/ui/*`): add it to `readonly` and to `externals` (`'@/components/ui/*'`). If the kit's folder also holds stylesheets, tests or stories, re-export what the panels use from a small readonly module instead (`src/readonly/ui.ts`: `export { Card, CardHeader } from '@/components/ui/Card'`, step 5): a readonly glob on the folder puts every matching file into every prompt. A trailing `*` matches the files directly in that folder only; a kit with one folder per component (`ui/badge/Badge.tsx`) needs each module listed (`'@/components/ui/badge/Badge'`), and a folder with an `index.tsx` is listed as the folder (`'@/components/ui/table'`);
- the npm packages the panels use besides React: a chart library (`'recharts'`, `'react-apexcharts'`), icons (`'lucide-react'`), a table library (`'@tanstack/react-table'`), i18n (`'react-i18next'`). They load only when a panel or an edit uses them (lazy externals). An entry names a module exactly: `'antd'` does not cover `'antd/es/table'`; import from the package root (`TableColumnsType` from `'antd'`) or list the subpath too. Imports used only as types (`import type …`, or names used only in type positions) are erased before the check and need no entry.
- `designSystem` (optional; `pleatkit init --suggest` prints it): which UI-kit components the agent's design-system digest describes (`designSystem: { components: ['@/components/ui/*'] }`), see [recipes.md](recipes.md) "The design-system profile". It names the kit's own modules even when the panels reach the kit through a readonly re-export module; it only selects what the digest describes and needs no `externals` entry. Without it the agent still sees the kit's types.

Keep the readonly zone to what the panels need: every readonly file is in every edit's prompt (`pleatkit doctor` reports its size, step 5). The dynamic zone costs per edit: every edit sends all of its files, so **a zone under 450 lines keeps a one-call edit under $0.02** with Sonnet 5.5 (measured: about $0.0085 plus $0.026 per 1,000 lines of the zone); `pleatkit doctor` warns over 450 lines, or for one panel over 300 (`zone-size`). Files the panels import that are not readonly reach the agent as `.d.ts` only.

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

If `types` already exists, add the two entries to it. If it did not exist, it now limits the global types to these two: when `tsc` then reports globals it no longer knows (`process`, `describe`), add their packages to the list (`"node"`, `"vitest/globals"`). Run the app's own type check: the `tsc …` part of its `build` script, or its `typecheck` script (`pnpm exec tsc -b` in a `create vite` app; `pnpm exec tsc` when the build script says `tsc && vite build`).

Expect: no output, exit code 0.

Do not run `tsc -b` in an app whose build uses plain `tsc`: when a referenced tsconfig (`tsconfig.node.json`) is `composite` without `noEmit`, `tsc -b` writes `vite.config.js`, `vite.config.d.ts` and `*.tsbuildinfo` into the app, and Vite then loads that `vite.config.js` instead of your `vite.config.ts`. If it happened, delete those files.

If not: `Cannot find module 'virtual:pleatkit'` means the `types` entry is missing; `Cannot find module '@/...'` means `paths` is missing; `Cannot find module 'node:url'` means `@types/node` from step 2 is missing.

### Optional: let `pleatkit init --suggest` draft the zones

```bash
pnpm exec pleatkit init --suggest --panels src/features/users/components/users-table.tsx,src/components/overview.tsx:revenue-chart
```

It reads the app's import graph (it never runs the app, no model, free) and prints, for each panel: its id and `src/dynamic/<id>.tsx`, whether to move it or to copy it (copy when other files import it: a story, a test, a barrel), the helper files that go with it (its CSS module too; a global stylesheet of a copied component stays), the `<Dynamic>` line for every place the app renders it with the props it needs (router hooks the panel calls, such as `route.useSearch()` or `useNavigate()`, become props, with the lines to add to the page), and the panel's import lines after the move. Then: the readonly re-export modules with exactly the names the panels use (for shared code, and for a UI-kit folder that also holds stylesheets or tests), the externals in the form step 3 asks for (a flat kit as `'@/components/ui/*'`, a kit with a folder per component one module each), and the plugin block with `css` and `tailwindEntry`. Without `--panels` it ranks the components the pages render (tables, charts, cards, stat tiles) and picks up to five: which panels users may change is your decision, so check the list. A panel written inline in a page is not a file yet: move it into a component first (suggest names pages that render several stat tiles inline), then pass that file in `--panels`. `--write` creates only the readonly re-export modules; moving the panels and editing the pages and `vite.config.ts` stay yours. `--json` prints the same plan for tools. Measured on four apps: with `--panels`, 0 manual edits left to the configuration on each (externals, readonly modules, props, helper files, css mode); the work it cannot do is cutting panels out of inline page JSX.

## Step 5. Create the zones

1. Pick the panels users may change (see "Decide the zones" in [AGENTS.md](AGENTS.md)). For each one, move the component to `src/dynamic/<id>.tsx` with `export default`. `<id>` is lowercase with dashes, for example `orders-table`. A panel written inline in a large page (a card and its column definitions inside `ecommerce.tsx`) is extracted into that file with what it needs. State that only the panel uses (a table's own sort or filter in `useState`, not in the URL) moves into the panel with it; data hooks, router hooks and URL state stay in the page and arrive as props. A component with other users besides the page (a Storybook story, an export from the app's component barrel) is **copied** into `src/dynamic/<id>.tsx` instead: the page renders the copy through `<Dynamic>`, the original stays for the others.
2. Move what those panels import from the app (types, API client, formatters) to `src/readonly/` and import it as `@/readonly/<file>`. Dynamic files may import only other dynamic files, `react`, and what is in `externals`. When the code is used all over the app, leave it where it is and add a small readonly module that re-exports what the panel needs (`export { roles, type User } from '@/features/users/data'`): the agent reads that module and sees the rest as `.d.ts`. A panel made of several files (a table and its columns) is one `src/dynamic/<id>.tsx` plus helper files next to it that it imports relatively. A panel's CSS module moves with it: `import styles from './OrdersPage.module.css'` becomes `src/dynamic/<id>.module.css` (only the rules the panel uses) imported relatively; a dynamic file never imports a CSS file from outside the dynamic zone. `pleatkit doctor` accepts `.css` and `.module.css` files in the zone, and edits compile them with the panel (CSS modules keep their local class names, as in Vite). A plain (global) stylesheet that a **copied** component imports (`import './styles.css'`) stays where it is: the original still imports it, so its rules keep applying to the copy's class names; copy into the zone only rules you want edits to change.
3. Where the app rendered the panel, render it through `<Dynamic>` and pass its props:

```tsx
import { Dynamic } from '@pleatkit/runtime'

<Dynamic id="orders-table" props={{ orders }} />
```

Hooks of the router or of the page (`route.useSearch()`, `useNavigate()`) stay in the page: pass their results as props (`props={{ data, search, navigate }}`), see [recipes.md](recipes.md). `props` is any object, the same one the component got: a site that spreads (`<StatCard {...s} />`) becomes `<Dynamic id="stat-card" props={s} />`, and props may hold functions and components (callbacks, an `icon` component); `pleatkit init --suggest` prints these lines.

One id may be rendered in several places; a user's edit of `src/dynamic/<id>.tsx` then changes all of them. To keep a screen as it is, leave that render site on the original component. In a headless check, find a panel by its wrapper `[data-pleatkit-id="<id>"]`; the wrapper has `display: contents` and no box, so screenshot or measure its children (`[data-pleatkit-id="<id>"] > *`).

Two things in existing panels that the check refuses or that change the layout:
- An image or link whose URL comes from data on a plain element (`<img src={product.image}>`, `<a href={row.url}>`) is allowed: at render time the runtime keeps the URL only when it is a relative path or points to the app's own origin, and drops it otherwise (`//cdn.other.com/a.jpg`, `javascript:`, `data:`). Images from another host (a CDN) are not shown: keep the file name in the data and write the folder in the code (``src={`/images/product/${product.image}`}``), or serve them through your origin. A URL from data passed to a component's prop (`<Avatar src={row.url}>`) or to `fetch` is still refused by the static rules, and so is every later edit of the zone; `pleatkit doctor` reports such lines (`[FAIL] release`).
- `React.createElement(…)` in a panel is refused (rule `no-raw-html`, like `innerHTML`): render a component passed as a prop as JSX, `const { icon: Icon } = props` then `<Icon />`.
- `<Dynamic>` renders a wrapper with `display: contents`. A parent that spaces its children with margins (`space-y-6`, `space-x-*`, `divide-*`) loses the spacing around it: use `flex flex-col gap-6` (or a grid gap) on the parent instead.

Run:

```bash
pnpm exec pleatkit doctor
```

Expect: `[ok]   panels: 1 <Dynamic> panel, each with a file and a default export` (with your count), `[ok]   release: the release's N dynamic files pass the agent's check` and `[ok]   externals: N entries (M modules) resolve` (an entry with `/*` counts every module it matches). A `/*` entry that matches no module yet (`@/readonly/*` before `src/readonly/` has a file) is a `[warn]`.

If not: the `[FAIL]` line names the id and the file; create the file, add `export default`, or fix the id. An external that does not resolve is either a typo or a file that does not exist under `src/`. `[FAIL] release` lists the lines the check refuses (see above and [troubleshooting.md](troubleshooting.md)).

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

If the app has no users yet, use a fixed id such as `'demo-user'`. When the user comes from a React context (an auth provider, `useAuth()`), create the provider inside it: [recipes.md](recipes.md) "User id from an auth hook". `<PleatkitChat locale="ru">` switches the chat to Russian.

`appId` names the app in store-server: lowercase letters, digits and dashes, for example the package name (`'mesa'`, `'antd-dashboard'`). It must stay the same: another `appId` starts every user from the original version. In production it must equal the servers' `PLEATKIT_APP_ID`.

While open, the chat is a side panel about 420 px wide on the right that narrows the page (wide tables and stat tiles reflow); it closes with ×. The chat's **Customize** button sits fixed at the bottom right (20 px from the edges, above everything); it can cover the last few pixels of content there (a table's last cell): give the app's main scroll area about 72 px of bottom padding if that matters. There is no option to move it in 0.3: if the app has its own floating button there, move the app's button up by about 64 px (Ant Design: `<FloatButton.Group style={{ insetBlockEnd: 112 }}>`, its default is 48; MUI `Fab`, Mantine `Affix`: raise `bottom` by 64).

For a quick look without store-server, `new LocalStore('my-app')` keeps the edits in this browser (IndexedDB) instead: no admin view, nothing on other devices. Switch to `HttpStore` before anyone else uses the app.

Run:

```bash
pnpm build
```

Expect: the build ends with `✓ built in …`, the list includes `dist/pleatkit.manifest.json` (and `dist/assets/esbuild-….wasm`, about 14 MB, used only with `compile: 'browser'` or as a fallback; it is fetched only then). Harmless notes:
- for externals the app imports statically as well: on Vite 8 `[INEFFECTIVE_DYNAMIC_IMPORT]`, on Vite 6 and 7 `(!) … is dynamically imported by virtual:pleatkit/externals but also statically imported by …`: the module is simply not split into its own chunk;
- the runtime and the chat join the entry chunk, so an app close to the limit now gets `(!) Some chunks are larger than 500 kB after minification`: raise `build.chunkSizeWarningLimit` if you mind;
- on Vite 8, `[PLUGIN_TIMINGS] … pleatkit buildStart`: the plugin compiles and checks the release's dynamic files when the build starts (a few seconds).

On a large app the first note lists every module that imports React on one line (hundreds of kB of output). Keep the log and read only what matters: `pnpm build > build.log 2>&1; grep -a -E 'built in|pleatkit\.manifest|\[pleatkit\]|rror' build.log`.

If not: see [troubleshooting.md](troubleshooting.md) ("Build fails").

## Step 7. Run store-server and the agent server

Add two scripts to the app's `package.json`: `"store": "pleatkit-store"` and `"agent": "pleatkit-agent"`, and `.pleatkit/` to `.gitignore` (store-server's SQLite file). Then, in two more terminals (both keep running; with npm: `npm run store`, `npm run agent`):

```bash
pnpm run store
PLEATKIT_STORE_URL=http://localhost:8790 pnpm run agent
```

Write `pnpm run store`, not `pnpm store`: `pnpm store` is pnpm's own command (it prints pnpm's usage and exits 0, and no server starts).

Expect lines that start like `pleatkit store-server on http://localhost:8790 (open core; .pleatkit/store.db; no credentials, demo headers ON (development only))` and, without a key, `pleatkit agent on http://localhost:8789/agent (provider scripted, model scripted, logging to http://localhost:8790, …)`. With `PLEATKIT_API_KEY=<key>` on the agent: `(provider anthropic, model claude-sonnet-5-5, …)`. On Windows `cmd`, set the variable first: `set PLEATKIT_STORE_URL=http://localhost:8790 && pnpm agent`.

If not: `EADDRINUSE` means a port is taken; see "Other ports" below. A store-server that exits with `refusing to start without credentials` runs with `NODE_ENV=production`: see below.

**Other ports** (the defaults are 8790 for store-server, 8789 for the agent, 5173 for `vite dev`, 4173 for `vite preview`). Change all the places that name a port together:

| Moved | Where |
|---|---|
| store-server, e.g. 8812 | `PLEATKIT_STORE_PORT=8812 pnpm run store`; the agent's `PLEATKIT_STORE_URL=http://localhost:8812`; the `/pleatkit-store` and `/pleatkit/b` proxy targets in `vite.config.ts` |
| agent, e.g. 8811 | `PLEATKIT_AGENT_PORT=8811 pnpm run agent`; the `/agent` proxy target |
| the app | `pnpm exec vite preview --port 5191 --strictPort` (or `vite --port 5191`); then `pleatkit ping --url http://localhost:5191`. When `vite.config.ts` reads the ports from the environment (below), start vite with the same variables: `PLEATKIT_AGENT_PORT=8811 PLEATKIT_STORE_PORT=8812 pnpm exec vite preview --port 5191 --strictPort` |

The proxies are in both `server.proxy` and `preview.proxy` (the example shares one object). To keep the ports out of the file, read them from the environment in `vite.config.ts`: `const AGENT = process.env.PLEATKIT_AGENT_PORT ?? '8789'`. Then a `vite` started without the variables proxies to the default ports (another app's servers, if they run there): start `vite` with the same variables as the servers, or put your ports in the defaults. On Windows, stopping the terminal (or a background shell) of `pnpm run agent`, `pnpm run store` or `vite preview` can leave the node process running and holding the port: find it with `netstat -ano | findstr :8789` (the last column is the process id) and stop it with `taskkill /PID <pid> /F` (PowerShell: `Get-NetTCPConnection -LocalPort 8789 | ForEach-Object { Stop-Process -Id $_.OwningProcess }`); the same for the store port and vite's.

The model key lives only in the agent's environment. In production run both as their own Node services and route `/agent`, `/pleatkit-store` and `/pleatkit/b` of the app's origin to them ([production.md](production.md)).

Production (`NODE_ENV=production`): the agent server and store-server refuse to start without `PLEATKIT_APP_ID`, `PLEATKIT_APP_KEY` (`mk_live_…`) and `PLEATKIT_JWT_SECRET`. `pnpm exec pleatkit keys new` prints all three plus `PLEATKIT_PUBLIC_KEY`; put the first three in the servers' secret store, never in the repo or a `VITE_` variable. The app's backend mints a 15-minute user token per signed-in user (`mintUserToken` from `@pleatkit/store-server/token`), and the app passes it to `HttpStore({ token })`, `<PleatkitChat token>` and `<PleatkitProvider token>`. Build the app with `PLEATKIT_PUBLIC_KEY` set (or `pleatkit({ publicKey })`): the runtime then runs only bundles signed by the app key.

Next: [verify.md](verify.md).
