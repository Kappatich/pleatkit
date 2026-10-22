# @pleatkit/agent

The agent server of [pleatkit](https://github.com/Kappatich/pleatkit): it takes a user's request from the chat,
rewrites the panels in the app's dynamic zone with zone-checked file tools, checks the result with the same rules
as the browser, compiles and signs it, and streams progress over SSE.

- Providers: `anthropic` (default with a key), `openai-compatible`, `scripted` (recorded answers, no key).
- Server compile and ed25519-signed bundles, quotas per edit/user/app, alerts and automatic freezes.
- `check-snapshots` before a release; the expected cost of an edit for the admin.
- Extensions: `createAgentApp({ extensions })` mounts `AgentExtension` routes (provider, store client, admin rule,
  usage events in their context); the binary loads `PLEATKIT_AGENT_EXTENSIONS` (`none`, a module list, or the
  pleatkit cloud's `@pleatkit/agent-cloud` when the deployment depends on it). The wish map, the weekly digest and
  bulk carry-over after a release are pleatkit cloud features in that package.

```bash
pnpm add -D @pleatkit/agent
PLEATKIT_API_KEY=<model key> PLEATKIT_MANIFEST=dist/pleatkit.manifest.json npx pleatkit-agent   # :8789/agent
```

Keys are read from the environment only. With `NODE_ENV=production` the server refuses to start without
`PLEATKIT_APP_KEY`, `PLEATKIT_JWT_SECRET` and `PLEATKIT_MANIFEST`. Every variable is in the repository README.

MIT. Changes: [CHANGELOG.md](https://github.com/Kappatich/pleatkit/blob/main/CHANGELOG.md).
