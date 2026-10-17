# morphkit for coding agents

Version: morphkit 0.1.0, docs dated 2026-10-18. Tested by following them into a fresh `create vite@7 --template react-ts` app: [`examples/t1-vite`](../../examples/t1-vite).

## What it is

morphkit lets the users of a React + Vite app change its interface by asking an in-app agent. The agent rewrites only the files of the **dynamic** zone; the change is compiled in the user's browser (esbuild-wasm), swapped in without a reload and saved as that user's own version, with undo and history. The agent server (Node) holds the model key; the browser never sees it.

Zones, set by globs in the Vite plugin:

| Zone | The agent | Typical files |
|---|---|---|
| `dynamic` | rewrites (per user) | `src/dynamic/<id>.tsx`, one panel per file, default export, mounted as `<Dynamic id="<id>">` |
| `readonly` | reads, imports through `@/readonly/*` | typed API client, types, formatters, UI kit |
| core (everything else) | sees only `.d.ts` | routing, auth, data, app shell |

## Your task, in order

1. [`install.md`](install.md): steps 1 to 7. Each step is a command, the expected output, and what to do if the output differs. Do them in order; do not skip the checks.
2. [`verify.md`](verify.md): the acceptance checks. The task is done only when `morphkit doctor` reports no `[FAIL]` and `morphkit ping` reports `[ok]` for all three lines.
3. If something fails: [`troubleshooting.md`](troubleshooting.md) (symptom, cause, command).

## Invariants (do not break them)

- The model key is only in the environment of the agent server (`MORPHKIT_API_KEY`). Never in client code, never in a `VITE_` variable, never committed. `morphkit doctor` checks the built bundle and `.env*` files.
- Every `<Dynamic id="x">` has `src/dynamic/x.tsx` (inside the dynamic glob) with a default-exported component. Panels are rendered through `<Dynamic>`, never imported directly.
- Dynamic code imports only: other dynamic files (relative paths) and the `externals` list. Anything a panel needs from the app goes into `readonly` and is listed in `externals` (for example `@/readonly/*`).
- The app resolves `@` to `src` in both Vite (`resolve.alias`) and TypeScript (`paths`). The plugin assumes `{ '@': 'src' }` unless you pass `alias`.
- One React: React 19 for the app and `@morphkit/runtime`. When morphkit is linked from a local checkout, `resolve.dedupe: ['react', 'react-dom']` is required.
- If the app has a Content-Security-Policy, it must allow `script-src 'self' blob: 'wasm-unsafe-eval'` and `worker-src blob:`.

## Decide the zones (before step 4 of install.md)

Good dynamic panels: views users have opinions about (cards, tables, dashboards, detail panes), that get their data as props or from the readonly client, and render without side effects on the server. Keep out of `dynamic`: auth, routing, payments, anything that writes data without the user's action, shared layout. Start with one or two panels; more can be moved later.

## Facts you may need

- Packages: `@morphkit/vite-plugin` (dev), `@morphkit/runtime`, `@morphkit/ui`, `@morphkit/agent` (server, bin `morphkit-agent`), `@morphkit/cli` (bin `morphkit`: `doctor`, `ping`).
- Not on npm yet: install from a local checkout with `link:` (install.md step 1 shows both forms).
- Agent server: port 8789 by default (`MORPHKIT_AGENT_PORT`); route `POST /agent/run` (SSE), `GET /agent/health`. Without `MORPHKIT_API_KEY` it runs the `scripted` provider, which replays recorded answers from `MORPHKIT_FIXTURES` (default `./fixtures`) and politely refuses anything else.
- Supported: Vite 6 or 7, React 19, TypeScript, Tailwind 4 (optional, `css: 'tailwind'`). Not supported: Next.js, webpack.
- Full reference: the repository [`README.md`](../../README.md).
