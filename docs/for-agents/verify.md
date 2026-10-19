# Verify a pleatkit installation

The installation is accepted when checks 1 to 4 pass. Run them in `<APP>` after [install.md](install.md). Each check: **run**, **expect**, **if not**.

## Check 1. Static setup: `pleatkit doctor`

Run (after `pnpm build`, so the bundle can be scanned):

```bash
pnpm exec pleatkit doctor
```

Expect: no `[FAIL]` line, exit code 0, and the last line is `all checks passed` or `no problems, N warning(s)`. The checks listed: `config`, `react`, `panels`, `release` (the release's own dynamic files pass the agent's check: a panel the check refuses would make every edit fail), `externals`, `context-budget`, `csp`, `secure-context`, `secrets`.

`context-budget` estimates the tokens of one edit (about 2.2 characters per token). With `PLEATKIT_API_KEY` in the environment, doctor counts them with the API's token counter instead (free, no model call): `PLEATKIT_API_KEY=<key> pnpm exec pleatkit doctor` prints `context of one edit: N cached + M per request tokens (counted)`. Over 20,000 cached or 6,000 per request it warns; the edit still works, it only costs more. Under it, doctor prints `Expected cost per edit on this app: $X (cold: $Y) with <model> and the <classifier> classifier`: a typical edit with a warm prompt cache, and the first edit after 5 minutes idle (the prefix written to the cache again). Measured on prompt 5f with Sonnet 5.5: about $0.013 on a small app (the demo), $0.028 on TailAdmin, $0.036 on shadcn-admin; the live medians were within 15 %. Tell the user this number before the first live request; the /admin Plan screen shows it next to the measured cost per applied edit.

A warning that is fine while pleatkit is linked from a checkout: `[warn] react: two copies of React on disk, deduplicated by Vite`.

If not: every `[FAIL]` line is followed by `fix: …`; do it and run doctor again. Details in [troubleshooting.md](troubleshooting.md). `--json` prints the findings for tools.

## Check 2. The running app reaches the agent: `pleatkit ping`

Start the three servers (three terminals, all keep running):

```bash
pnpm store                                          # pleatkit store-server on http://localhost:8790 (...)
PLEATKIT_STORE_URL=http://localhost:8790 pnpm agent # pleatkit agent on http://localhost:8789/agent (...)
pnpm exec vite preview --port 4173 --strictPort
```

Then:

```bash
pnpm exec pleatkit ping --url http://localhost:4173
```

Expect three `[ok]` lines:

```
[ok]   manifest: 1 dynamic, 1 readonly files
[ok]   agent: provider scripted, model scripted
[ok]   agent run over SSE: 4 progress line(s), verdict failed
       summary: The demo runs without a model key (scripted provider) and has no recorded answer for this request. ...
```

Without a key, `verdict failed` with that summary is the expected result: the request went through the proxy to the agent and back. With `PLEATKIT_API_KEY` set on the agent the provider is `anthropic` and the verdict is `ok` (one small model call).

If not: the `[FAIL]` line says which hop failed (the app, the `/agent` proxy, or the agent server); see [troubleshooting.md](troubleshooting.md). The same command works against `vite dev` (`--url http://localhost:5173`).

## Check 3. An edit in the browser

With both servers running, open the app, click **Customize** (bottom right), type a request about one of the dynamic panels and press Enter.

Expect, with a key: progress lines (`Understanding the request`, `Changing the …`, `Everything works`), then the badge `Applied` and the panel changes on the page without a reload. **Undo** in the chat brings back the previous version; reloading the page keeps the current one (it comes back from store-server, also in another browser signed in as the same user).

Without a key, the scripted provider answers only requests it has a recorded answer for. To check the browser part offline, record one: put a JSON file in `fixtures/` of the agent's working directory (format: [`examples/t1-vite/fixtures/agent/01-overdue-red.json`](../../examples/t1-vite/fixtures/agent/01-overdue-red.json)) and start the agent with `PLEATKIT_FIXTURES=fixtures`.

Automated version of checks 2 and 3 for the example app: `pnpm smoke` in [`examples/t1-vite`](../../examples/t1-vite) starts store-server (in memory), the agent and `vite preview`, runs `pleatkit ping`, drives the chat headless, reloads, and stops the three servers. Expect its last lines: `[ok]   chat edit in the browser: applied; overdue row color …` and `[ok]   after a reload the edit comes back from store-server: …`.

If not: the turn badge says why (`Not done`, `Did not compile`, `Sent to admin`); the browser console has the details (`[pleatkit] …`).

## Check 4. The key stays on the server

Run:

```bash
pnpm exec pleatkit doctor
```

Expect: `[ok]   secrets: no API keys in the client bundle (N files scanned)`.

If not: remove the key from client code and `VITE_` variables, rebuild, and rotate the key (it was exposed).

## Done

Report: the doctor summary line, the three ping lines, and which panels are dynamic.
