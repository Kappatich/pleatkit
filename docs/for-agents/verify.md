# Verify a pleatkit installation

The installation is accepted when checks 1 to 4 pass. Run them in `<APP>` after [install.md](install.md). Each check: **run**, **expect**, **if not**.

## Check 1. Static setup: `pleatkit doctor`

Run (after `pnpm build`, so the bundle can be scanned):

```bash
pnpm exec pleatkit doctor
```

Expect: no `[FAIL]` line, exit code 0, and the last line is `all checks passed` or `no problems, N warning(s)`. The checks listed: `config`, `react`, `panels`, `release` (the release's own dynamic files pass the agent's check: a panel the check refuses would make every edit fail), `externals`, `context-budget`, `zone-size` (a warning over 450 lines of dynamic code: each edit costs more), `csp`, `secure-context`, `secrets`.

`context-budget` estimates the tokens of one edit (about 2.2 characters per token). With `PLEATKIT_API_KEY` in the environment, doctor counts them with the API's token counter instead (free, no model call): `PLEATKIT_API_KEY=<key> pnpm exec pleatkit doctor` prints `context of one edit: N cached + M per request tokens (counted)`. Over 20,000 cached or 6,000 per request it warns; the edit still works, it only costs more. Under it, doctor prints `Expected cost per edit on this app: $X (cold: $Y) with <model> and the <classifier> classifier`: a typical edit with a warm prompt cache, and the first edit after 5 minutes idle (the prefix written to the cache again). Measured on prompt 5f with Sonnet 5.5: about $0.013 on a small app (the demo), $0.028 on TailAdmin, $0.036 on shadcn-admin; the live medians were within 15 %. Tell the user this number before the first live request; the /admin Plan screen shows it next to the measured cost per applied edit.

A warning that is fine while pleatkit is linked from a checkout: `[warn] react: two copies of React on disk, deduplicated by Vite`.

If not: every `[FAIL]` line is followed by `fix: …`; do it and run doctor again. Details in [troubleshooting.md](troubleshooting.md). `--json` prints the findings for tools.

## Check 2. The running app reaches the agent: `pleatkit ping`

Start the three servers (three terminals, all keep running):

```bash
pnpm run store                                          # pleatkit store-server on http://localhost:8790 (...)
PLEATKIT_STORE_URL=http://localhost:8790 pnpm run agent # pleatkit agent on http://localhost:8789/agent (...)
pnpm exec vite preview --port 4173 --strictPort
```

(`pnpm run store`, not `pnpm store`: that is pnpm's own command. Other ports: install.md step 7, "Other ports".)

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

Expect, with a key: progress lines (`Understanding the request`, `Changing the …`, `Everything works`), then the turn ends with a check mark (✓), the summary and a "N steps" toggle, the chat's header counts the change, and the panel changes on the page without a reload. A headless check opens the chat with `getByTestId('mk-chat-open')`, types into `mk-chat-input`, clicks `mk-chat-send`, and waits while the turn `[data-testid="mk-chat-turn"]` has `data-status="running"`; it ends `applied`, or `nothing`, `needs-backend`, `clarify`, `refused`, `rejected` or `failed` (the chat renders in an open shadow root: Playwright's `getByTestId` reaches it, `document.querySelector` does not). Compare text with `textContent`: an app may change case with CSS (`text-transform`), which `innerText` reflects. **Undo** in the chat brings back the previous version; reloading the page keeps the current one (it comes back from store-server, also in another browser signed in as the same user).

Without a key, the scripted provider answers only requests it has a recorded answer for. To check the browser part offline, record one: a JSON file directly in `<APP>/fixtures/` (the agent reads `PLEATKIT_FIXTURES`, default `fixtures`, relative to the folder it runs in; subfolders are not read; it reads them at start, so restart the agent after adding one). The format, for a one-line change:

```json
{
  "name": "01-orders-title",
  "match": ["rename .*orders"],
  "classify": { "label": "ui", "reason": "A change on the page." },
  "turns": [
    { "calls": [
      { "tool": "edit_file", "input": { "path": "src/dynamic/orders-table.tsx", "old_str": "Recent orders", "new_str": "Latest orders" }, "expect": "ok" },
      { "tool": "check", "input": {}, "expect": "ok" }
    ] },
    { "calls": [ { "tool": "finish", "input": { "verdict": "ok", "summary": "The card is now called Latest orders." }, "expect": "ok" } ] }
  ]
}
```

`match` holds regular expressions (case-insensitive) tried on the request; the first fixture whose pattern matches (files in name order) answers. Each turn is one model call; the tools are `list_files`, `read_file` (`path`), `write_file` (`path`, `content`, or `"contentFile": "<file next to the fixture>"` beside `input`), `edit_file` (`path`, `old_str` unique in the file, `new_str`), `check` and `finish` (`verdict` `ok`, `summary`). `expect` says whether the tool must succeed (`ok`) or fail (`error`). A wrong `old_str` fails the run: the chat then says only "Something went wrong on our side"; the tool's message is in the request's steps in store-server's request log (`pleatkit export --store http://localhost:8790 --app <appId>`, or the request on /admin). Then ask exactly a request that matches, e.g. "Rename the orders card". Run the app's formatter or linter on the dynamic files before the test edit, not after: a reformatted file after the edit makes your test user's version stale (below).

If not: the turn says why (`Not done`, `Did not compile`, `Sent to admin`, or "no recorded answer for this request" when no fixture matched); the browser console has the details (`[pleatkit] …`). If the panels are behind the app's sign-in, sign in first (headless: seed the app's session the way its login does); with the auth-hook recipe the chat shows only for a signed-in user.

Changed the dynamic files and rebuilt after a test edit? Your test user's edit was made on the old files. If the files you changed are not the ones the edit changed, the edit is carried over to the new files by itself on the next load (nothing is shown). If both changed the same file, the chat offers **Use new version** / **Carry them over** (a stale version, troubleshooting.md): during the install, click **Use new version** before testing again.

The `fixtures/` folder is read only by the scripted provider (no `PLEATKIT_API_KEY`): keep it in the repository as an offline smoke test, or delete it after the check.

## Check 4. The key stays on the server

Run:

```bash
pnpm exec pleatkit doctor
```

Expect: `[ok]   secrets: no API keys in the client bundle (N files scanned)`.

If not: remove the key from client code and `VITE_` variables, rebuild, and rotate the key (it was exposed).

## Done

Report: the doctor summary line, the three ping lines, and which panels are dynamic.
