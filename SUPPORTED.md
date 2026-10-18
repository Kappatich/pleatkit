# What pleatkit supports

The v1 support matrix (V1 §2.4). "Supported" means the combination is tested in this repository and a bug in it is
ours to fix; anything else may work but is not promised. Report problems with `pleatkit report` attached.

## The app

| | Supported | Tested by |
|---|---|---|
| React | 18.x, 19.x | `apps/demo-crm` (React 19, all e2e under `StrictMode`), `apps/react18-smoke` (React 18, server render) |
| Vite | 6.x, 7.x, 8.x | demo on Vite 6, `examples/t1-vite` on Vite 7; peer range `^6 \|\| ^7 \|\| ^8` |
| TypeScript | 5.x | monorepo on 5.9, `examples/t1-vite` on 5.8 |
| CSS | Tailwind 4 with shadcn/ui (first class); any other stack with `css: 'palette'` | demo (Tailwind 4 + shadcn-style components) |
| Module format | ESM | — |

Not in v1: Next.js (v1.1, via `pleatkit generate`), webpack, Metro / React Native, MUI and Emotion profiles,
Electron and Tauri. See [docs/ROADMAP.md](docs/ROADMAP.md).

## The servers and the CLI

| | Supported |
|---|---|
| Node.js | 22 LTS and newer (`engines: >=22`) |
| Package managers | pnpm 10 (documented), npm 10 |
| store-server database | SQLite (one file per instance; Postgres is planned before the first paying Cloud customer) |
| Model providers | Anthropic (default: `claude-sonnet-5-5`, classifier `claude-haiku-5-5`); OpenAI-compatible APIs (OpenAI, OpenRouter) with `PLEATKIT_PROVIDER=openai-compatible`, untested against live endpoints in CI |
| OS for development | Windows 11 (where the repository is developed and tested); macOS and Linux expected, not yet tested |

## Browsers

| Browser | Status |
|---|---|
| Chrome / Edge (Chromium), current versions | supported; every e2e test runs on Chromium headless (156 at the time of writing) |
| Safari, Firefox, current versions | expected to work (standard ES modules, `import()`, SRI, Web Crypto); **not yet tested** (DEVLOG 4a, "not done") |
| Mobile Safari, Chrome on Android | not yet tested; the drawer is being redesigned for small screens (C12) |

Requirements: a secure context (https or localhost) for Web Crypto (`pleatkit doctor` warns; without it signed edits
cannot be verified). With `compile: 'browser'` the page needs WebAssembly and `blob:` in the CSP; the default
`compile: 'server'` needs neither.

## Versions of pleatkit

Before 1.0 every minor release may break, and every break is marked **Breaking** in [CHANGELOG.md](CHANGELOG.md)
with its migration step. Only the latest minor release gets fixes.
