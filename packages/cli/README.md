# @pleatkit/cli

The `pleatkit` command for [pleatkit](https://github.com/Kappatich/pleatkit) apps and their operators.

| Command | What it does |
|---|---|
| `pleatkit doctor` | checks the plugin, zones, React, panels, externals, CSP and secrets of an app, with a fix for each problem |
| `pleatkit ping` | the running app end to end: manifest, agent, one agent run over SSE |
| `pleatkit keys new` / `public` | a fresh app key, user-JWT secret and the bundle public key |
| `pleatkit export` | everything the store keeps for an app or one user, as JSON |
| `pleatkit erase --user <id>` / `--app <id>` | deletes a user's or the app's data in the store (two steps, with a confirm token) |
| `pleatkit check-snapshots` | carries every user's version over to a new build and compiles it, before the release |
| `pleatkit report` | a bug report with keys, tokens and secrets redacted |

```bash
pnpm add -D @pleatkit/cli @pleatkit/agent    # the agent package is needed only for check-snapshots
pnpm exec pleatkit doctor
```

`pleatkit --help` lists every option. The bulk carry-over after a release and the weekly digest are pleatkit cloud
commands (`pleatkit-ops`), not part of this package. Anonymous usage events are opt-out (`PLEATKIT_TELEMETRY=0`).

MIT. Changes: [CHANGELOG.md](https://github.com/Kappatich/pleatkit/blob/main/CHANGELOG.md).
