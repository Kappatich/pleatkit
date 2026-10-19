# pleatkit for coding agents

Version: pleatkit 0.3.0, docs dated 2026-10-19. Tested by following them into a fresh `create vite@7 --template react-ts` app and into four existing open-source apps: shadcn-admin (Vite 8, pnpm, TanStack Router and Table, recharts), TailAdmin (Vite 8, npm, react-i18next, ApexCharts), an Ant Design dashboard (Vite 5 → 6, pnpm 9, React Router, TanStack Query, no Tailwind) and a CSS-modules dashboard (Vite 8, npm, React Router, TanStack Query, no Tailwind); the last two by a coding agent that saw only this folder. Everything you need is in `docs/for-agents/`.

## What it is

pleatkit lets the users of a React + Vite app change its interface by asking an in-app agent. The agent rewrites only the files of the **dynamic** zone; the change is compiled on the agent server (native esbuild; `compile: 'browser'` compiles in the page with esbuild-wasm instead), signed, loaded from the app's own origin (`/pleatkit/b/…`), swapped in without a reload and saved as that user's own version, with undo and history. The agent server (Node) holds the model key; the browser never sees it.

Zones, set by globs in the Vite plugin:

| Zone | The agent | Typical files |
|---|---|---|
| `dynamic` | rewrites (per user) | `src/dynamic/<id>.tsx`, one panel per file, default export, mounted as `<Dynamic id="<id>">` |
| `readonly` | reads, imports through `@/readonly/*` | typed API client, types, formatters, UI kit |
| core (everything else) | sees only `.d.ts` | routing, auth, data, app shell |

## Your task, in order

1. [`install.md`](install.md): steps 1 to 7. Each step is a command, the expected output, and what to do if the output differs. Do them in order; do not skip the checks.
2. [`verify.md`](verify.md): the acceptance checks. The task is done only when `pleatkit doctor` reports no `[FAIL]` (including `release`: the existing panels pass the agent's check) and `pleatkit ping` reports `[ok]` for all three lines.
3. If something fails: [`troubleshooting.md`](troubleshooting.md) (symptom, cause, command).
4. Panels that use context, TanStack Query, Redux or the router, and the design-system profile: [`recipes.md`](recipes.md).
5. Real users: [`production.md`](production.md) (keys, user tokens, deploying the agent and the store, CSP, privacy settings, checks before each release).

## Invariants (do not break them)

- The model key is only in the environment of the agent server (`PLEATKIT_API_KEY`). Never in client code, never in a `VITE_` variable, never committed. `pleatkit doctor` checks the built bundle and `.env*` files.
- Every `<Dynamic id="x">` has `src/dynamic/x.tsx` (inside the dynamic glob) with a default-exported component. Panels are rendered through `<Dynamic>`, never imported directly.
- Dynamic code imports only: other dynamic files (relative paths) and the `externals` list. Anything a panel needs from the app goes into `readonly` and is listed in `externals` (for example `@/readonly/*`).
- The app resolves `@` to `src` in both Vite (`resolve.alias`) and TypeScript (`paths`). The plugin assumes `{ '@': 'src' }` unless you pass `alias`.
- One React (18 or 19) for the app and `@pleatkit/runtime`. When pleatkit is linked from a local checkout, `resolve.dedupe: ['react', 'react-dom']` is required.
- Content-Security-Policy: with the default `compile: 'server'` it needs only `script-src 'self'` (and `connect-src 'self'`, `style-src 'self' 'unsafe-inline'`). With `compile: 'browser'` it must also allow `blob:` and `'wasm-unsafe-eval'` in `script-src` and `worker-src blob:`. With the plugin option `allowedHosts`, `img-src` lists each of those hosts (`img-src 'self' https://images.example-cdn.com`) and nothing else is widened.
- In production the servers need `PLEATKIT_APP_KEY` and `PLEATKIT_JWT_SECRET` (`pleatkit keys new`), and the browser sends a user token minted by the app's backend; the demo headers work only in development.

## Decide the zones (before step 4 of install.md)

Good dynamic panels: views users have opinions about (cards, tables, dashboards, detail panes), that get their data as props or from the readonly client, and render without side effects on the server. Keep out of `dynamic`: auth, routing, payments, anything that writes data without the user's action, shared layout. Start with one or two panels; more can be moved later. Every dynamic file is in every edit's prompt: three or four ordinary panels (a table with its columns and its CSS module each) reach doctor's 6,000-token tail target and its 450-line `zone-size` target. Those two `[warn]`s only mean a higher cost per edit (about $0.026 per 1,000 lines with Sonnet 5.5); they do not block the install.

## Facts you may need

- Packages: `@pleatkit/vite-plugin` (dev), `@pleatkit/runtime`, `@pleatkit/ui`, `@pleatkit/agent` (server, bin `pleatkit-agent`), `@pleatkit/store-server` (bin `pleatkit-store`), `@pleatkit/cli` (bin `pleatkit`: `doctor`, `ping`, `init --suggest`, `keys`, `export`, `check-snapshots`, `labels export`).
- Not on npm yet: install from a local checkout with `link:` (install.md step 1 shows both forms).
- Agent server: port 8789 by default (`PLEATKIT_AGENT_PORT`); routes `POST /agent/v1/run` (SSE), `POST /agent/v1/compile`, `GET /agent/v1/b/<app>/<key>.js|css|json`, `GET /agent/health` (unversioned `/agent/run` still works). Without `PLEATKIT_API_KEY` it runs the `scripted` provider, which replays recorded answers from `PLEATKIT_FIXTURES` (default `./fixtures`) and politely refuses anything else.
- Supported: Vite 6 to 8 (Vite 5: upgrade to 6 first, install.md step 0), React 18 or 19, TypeScript 5 or 6, Tailwind 4 through `@tailwindcss/vite` or PostCSS (optional, `css: 'tailwind'`), apps without Tailwind (CSS modules, a component library: `css: 'palette'`), pnpm 9 or 10, or npm. Not supported: Next.js, webpack.
- Telemetry: the CLI and the Vite plugin can send one anonymous event per command; `PLEATKIT_TELEMETRY=0` (or `DO_NOT_TRACK=1`, or CI) turns it off, and in this version nothing is sent unless `PLEATKIT_TELEMETRY_URL` is set.
- Background (not needed for an install): the repository's `README.md`.
