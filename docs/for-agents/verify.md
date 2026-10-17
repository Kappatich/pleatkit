# Verify a morphkit installation

The installation is accepted when checks 1 to 4 pass. Run them in `<APP>` after [install.md](install.md). Each check: **run**, **expect**, **if not**.

## Check 1. Static setup: `morphkit doctor`

Run (after `pnpm build`, so the bundle can be scanned):

```bash
pnpm exec morphkit doctor
```

Expect: no `[FAIL]` line, exit code 0, and the last line is `all checks passed` or `no problems, N warning(s)`. Six checks are listed: `config`, `react`, `panels`, `externals`, `csp`, `secrets`.

A warning that is fine while morphkit is linked from a checkout: `[warn] react: two copies of React on disk, deduplicated by Vite`.

If not: every `[FAIL]` line is followed by `fix: …`; do it and run doctor again. Details in [troubleshooting.md](troubleshooting.md). `--json` prints the findings for tools.

## Check 2. The running app reaches the agent: `morphkit ping`

Start both servers (two terminals, both keep running):

```bash
pnpm agent                     # morphkit agent on http://localhost:8789/agent (...)
pnpm exec vite preview --port 4173 --strictPort
```

Then:

```bash
pnpm exec morphkit ping --url http://localhost:4173
```

Expect three `[ok]` lines:

```
[ok]   manifest: 1 dynamic, 1 readonly files
[ok]   agent: provider scripted, model scripted
[ok]   agent run over SSE: 4 progress line(s), verdict failed
       summary: The demo runs without a model key (scripted provider) and has no recorded answer for this request. ...
```

Without a key, `verdict failed` with that summary is the expected result: the request went through the proxy to the agent and back. With `MORPHKIT_API_KEY` set on the agent the provider is `anthropic` and the verdict is `ok` (one small model call).

If not: the `[FAIL]` line says which hop failed (the app, the `/agent` proxy, or the agent server); see [troubleshooting.md](troubleshooting.md). The same command works against `vite dev` (`--url http://localhost:5173`).

## Check 3. An edit in the browser

With both servers running, open the app, click **Customize** (bottom right), type a request about one of the dynamic panels and press Enter.

Expect, with a key: progress lines (`Understanding the request`, `Changing the …`, `Everything works`), then the badge `Applied` and the panel changes on the page without a reload. **Undo** in the chat brings back the previous version; reloading the page keeps the current one.

Without a key, the scripted provider answers only requests it has a recorded answer for. To check the browser part offline, record one: put a JSON file in `fixtures/` of the agent's working directory (format: [`examples/t1-vite/fixtures/agent/01-overdue-red.json`](../../examples/t1-vite/fixtures/agent/01-overdue-red.json)) and start the agent with `MORPHKIT_FIXTURES=fixtures`.

Automated version of checks 2 and 3 for the example app: `pnpm smoke` in [`examples/t1-vite`](../../examples/t1-vite) starts the agent and `vite preview`, runs `morphkit ping`, drives the chat headless, and stops both servers. Expect its last line: `[ok]   chat edit in the browser: applied; overdue row color …`.

If not: the turn badge says why (`Not done`, `Did not compile`, `Sent to admin`); the browser console has the details (`[morphkit] …`).

## Check 4. The key stays on the server

Run:

```bash
pnpm exec morphkit doctor
```

Expect: `[ok]   secrets: no API keys in the client bundle (N files scanned)`.

If not: remove the key from client code and `VITE_` variables, rebuild, and rotate the key (it was exposed).

## Done

Report: the doctor summary line, the three ping lines, and which panels are dynamic.
