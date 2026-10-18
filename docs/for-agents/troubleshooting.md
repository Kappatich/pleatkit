# Troubleshooting

Symptom → cause → what to run. Ordered roughly by when it shows up.

## Installing

**`pnpm add` installs another project, or fails with a workspace error.**
Cause: the app folder is inside another pnpm workspace (a `pnpm-workspace.yaml` in a parent folder).
Run: the same command with `--ignore-workspace`, and `pnpm install --ignore-workspace` afterwards.

**`Ignored build scripts: esbuild` after `pnpm add` (pnpm 10).**
Cause: pnpm 10 does not run install scripts by default. esbuild ships its binary as an optional dependency, so nothing is missing.
Run: nothing. `pnpm approve-builds` only if a build later fails with an esbuild binary error.

**package.json has `link:..\\..\\pleatkit\\packages\\runtime` with backslashes (Windows).**
Cause: pnpm writes the path as typed by the OS. It works locally, but not on other machines.
Run: edit the specs to forward slashes (`link:../../pleatkit/packages/runtime`).

## Type checking and building

**`vite.config.ts`: `Type 'Plugin<any>' is not assignable to type 'PluginOption'`.**
Cause: an old `@pleatkit/vite-plugin` whose types named its own Vite version (6) while the app uses Vite 7. Fixed in 0.1.0 of this repository.
Run: `git pull && pnpm build:packages` in `<PLEATKIT>`.

**`Cannot find module 'virtual:pleatkit'` (TypeScript).**
Cause: the client types are not loaded.
Run: add `"@pleatkit/vite-plugin/client"` to `compilerOptions.types` of the tsconfig that covers `src` ([install.md](install.md) step 4).

**`Cannot find module '@/readonly/...'` (TypeScript or Vite).**
Cause: the `@` alias is set in only one of the two places.
Run: add `resolve.alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) }` to vite.config and `"paths": { "@/*": ["./src/*"] }` to tsconfig. If your alias is different, pass the same to the plugin: `pleatkit({ alias: { '~': 'src' }, ... })`.

**`Cannot find module 'node:url'` in vite.config.ts.**
Cause: `@types/node` is not installed (a fresh `create vite` app has none).
Run: `pnpm add -D @types/node@^22`.

**Build warns `[pleatkit] esbuild-wasm not found; runtime compilation will be unavailable`.**
Cause: `@pleatkit/runtime` (which brings `esbuild-wasm`) is not installed in the app.
Run: `pnpm add link:<PLEATKIT>/packages/runtime` (or `pnpm add @pleatkit/runtime`).

## doctor

**`pnpm doctor` prints nothing or pnpm's own checks.**
Cause: `pnpm doctor` is a built-in pnpm command, so a package.json script named `doctor` never runs.
Run: `pnpm exec pleatkit doctor`, or name the script differently (`"pleatkit-doctor": "pleatkit doctor"`).

**`[FAIL] react: React problem … resolve different copies`.**
Cause: the app and `@pleatkit/runtime` load two Reacts (always the case with `link:`); hooks break with "Invalid hook call".
Run: add `resolve: { dedupe: ['react', 'react-dom'] }` to vite.config. doctor then reports `[warn]`, which is fine.

**`[FAIL] panels: <Dynamic id="x"> … no file src/dynamic/x.tsx`** or **`… has no default export`.**
Cause: the id and the file name differ, the file is outside the `dynamic` glob, or the component is a named export.
Run: rename the file or the id; add `export default`.

**`[FAIL] externals: … (no such file)` or `(package not installed)`.**
Cause: a typo in `externals`, or a path that does not exist under `src/`.
Run: fix the entry in the plugin options; a `*` entry (`@/readonly/*`) needs the folder to exist.

**`[FAIL] csp: … needs 'wasm-unsafe-eval'` or `… needs blob:`.**
Cause: the plugin runs with `compile: 'browser'` and the app's Content-Security-Policy blocks the compiler (WebAssembly) or compiled edits (`blob:` modules).
Run: drop `compile: 'browser'` (the default `server` mode needs only `script-src 'self'`), or use at least `script-src 'self' blob: 'wasm-unsafe-eval'; worker-src blob:` where the policy is defined (index.html meta or the hosting config).

**Chat says `Applied` nowhere, the console has `could not load the bundle signature (404)` or `failed to load`.**
Cause: no `/pleatkit/b` proxy (compile: 'server' loads signed bundles from it), or it points at the wrong server.
Run: add the `/pleatkit/b` proxy from install.md step 3 (to the agent's `/agent/v1/b`, or to store-server's `/v1/b`).

**Console: `refusing an unsigned or tampered bundle`.**
Cause: the app was built with a public key (`PLEATKIT_PUBLIC_KEY` / `pleatkit({ publicKey })`) but the agent server runs without the matching `PLEATKIT_APP_KEY`, or with another app's key.
Run: `PLEATKIT_APP_KEY=<key> pnpm exec pleatkit keys public` must print the key the app was built with.

**The page shows "Your customized version did not load last time".**
Cause: safe mode (the user's last load did not mount within 5 s, or the URL has `?pleatkit=safe`). The original version is shown on purpose.
Run: the banner's "Try my version again" or "Reset to the original"; if it comes back, roll the edit back in `/admin`.

**`[FAIL] secrets: … VITE_…KEY is a VITE_ variable` or `… Anthropic API key sk-ant-…`.**
Cause: a key is in the browser bundle.
Run: remove it from client code and `.env` `VITE_` variables, set `PLEATKIT_API_KEY` only for the agent server, rebuild, and rotate the key.

## Running

**`pleatkit ping`: `[FAIL] …/pleatkit.manifest.json` answered 404 or HTML.**
Cause: the app is not running, runs on another port, or the pleatkit plugin is not in its config.
Run: start `pnpm dev` or `pnpm exec vite preview` (after `pnpm build`) and pass its URL with `--url`.

**`pleatkit ping`: `[FAIL] …/agent/health` answers HTML, 404, 502 or 500.**
Cause: no `/agent` proxy in `server.proxy` / `preview.proxy`, or the agent server is not running.
Run: add `'/agent': 'http://localhost:8789'` to both proxies; start `pnpm agent`.

**Agent: `EADDRINUSE: address already in use :::8789`.**
Cause: another process uses port 8789.
Run: `PLEATKIT_AGENT_PORT=8790 pnpm agent` and change both proxy targets to `http://localhost:8790`.

**Chat: `Not done` with "has no recorded answer for this request".**
Cause: the agent runs without a key (scripted provider) and has no recorded answer for this text.
Run: start the agent with `PLEATKIT_API_KEY=<key>`, or add a recorded answer to `fixtures/` ([verify.md](verify.md) check 3).

**Chat: `Did not compile`.**
Cause: the edit compiled on the agent server but not in the browser (rare: a difference between native esbuild and esbuild-wasm, or a missing external in the browser).
Run: open the browser console (`[pleatkit]` lines) and check that every external in the plugin options is also importable by the app.

**A panel shows "The last edit broke the “…” panel" and rolls back after 10 s.**
Cause: the edit compiled but throws while rendering (for example reading a field of `undefined`).
Run: nothing; the previous version comes back. The admin log has the edit.

**Edits do not survive a reload.**
Cause: a new `LocalStore` name or a different `userId` on each load.
Run: keep the store name constant and pass the signed-in user's stable id.

**Under a strict CSP the isolated panel shows "did not start".**
Cause: the host script `assets/pleatkit-isolated-host-*.js` is served without `Access-Control-Allow-Origin` (the sandboxed frame has origin `null`).
Run: add `Access-Control-Allow-Origin: *` for that file in the hosting config (Vite dev and preview already do).
