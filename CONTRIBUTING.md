# Contributing to pleatkit

Thanks for helping. Bugs and feature requests go to the issue templates; security problems never go to a public
issue (see [`SECURITY.md`](SECURITY.md)). What is supported is in [`SUPPORTED.md`](SUPPORTED.md), what comes next in
[`docs/ROADMAP.md`](docs/ROADMAP.md). Coding agents (and people) working in the repository also read
[`AGENTS.md`](AGENTS.md).

## Run it

Node 22 and pnpm 10 (`corepack enable`). No model key is needed: the demo and every test use the `scripted` provider.

```bash
pnpm install
pnpm build
pnpm dev                                  # the demo CRM, the agent server and the store, one command
pnpm test                                 # unit tests of every package
pnpm e2e                                  # Playwright, headless, against the demo
cd examples/t1-vite && pnpm build && pnpm smoke   # the install docs still work
```

`pnpm agent:live`, `pnpm e2e:live` and `pnpm eval:record -- --live` call a real model, need `PLEATKIT_API_KEY` and
spend money: only run them on purpose. Keys never go in the repository, a `VITE_` variable or a log.

## Definition of done

A change is ready for review when all of these pass:

```bash
pnpm install && pnpm build && pnpm test && pnpm e2e && pnpm lint && pnpm typecheck
pnpm eval:sanity && pnpm eval:replay      # the eval harness on the demo set, offline
```

and, for a change that touches packaging, `node scripts/release-check.mjs`. Every behaviour change has a test; a
security rule gets a bypass case in `packages/runtime/test/check.test.ts`. User-visible changes get a
[`CHANGELOG.md`](CHANGELOG.md) entry, and a break is marked **Breaking** with its migration step. If the design
changes, `docs/ARCHITECTURE.md` changes in the same pull request. Commit only the files you meant to change
(screenshots and metrics that a test run rewrites stay out unless the change is about them).

## Paths a maintainer reviews

[`.github/CODEOWNERS`](.github/CODEOWNERS) lists them; a code owner reads every pull request that touches one
before it is merged. Keep those diffs small and say why in the description:

- the static rules, the shared check, signatures, auth and roles (`packages/runtime/src/check.ts`, `security.ts`,
  `paths.ts`, `packages/agent/src/static-check.ts`, `auth.ts`, `manifest.ts`, `packages/store-server/src/auth.ts`);
- money: quotas, plans, prices, alerts and freezes (`packages/runtime/src/quota.ts`, `packages/agent/src/quota.ts`,
  `pricing.ts`, `alerts.ts`);
- the public API and the wire protocol (`packages/*/src/index.ts`, `packages/runtime/src/protocol.ts`,
  `compiler-entry.ts`);
- the store schema, erasure, the extension hook and telemetry (`packages/store-server/src/schema.ts`, `erase.ts`,
  `extension.ts`, `packages/vite-plugin/src/telemetry.ts`);
- the system prompt (`packages/agent/src/prompt.ts`), CI (`.github/`), `package.json` and `pnpm-lock.yaml`.

`packages/ui` (the chat drawer) and `site/` have an owner for their look: open an issue before a visual change.

## Prompt and model changes: the eval rule

No change to the system prompt, the classifier, the tools the model sees or the default model without an eval
report. Bump `PROMPT_VERSION` in `packages/agent/src/prompt.ts`, run `pnpm eval:replay` and `pnpm eval:report`, and
put the numbers (pass rate, cost, latency, model, prompt version) in the pull request. The maintainers re-run the
change on the private suites and the live sets before merging. How the harness works, and which sets are public:
[`docs/evals.md`](docs/evals.md).

## License

pleatkit is MIT ([`LICENSE`](LICENSE)). By contributing you agree that your contribution is licensed the same way.
