# t1-vite: pleatkit in a fresh Vite app

A `pnpm create vite@7 t1-vite --template react-ts` app with pleatkit installed by following
[`docs/for-agents/install.md`](../../docs/for-agents/install.md) step by step. It is the test of those docs:
where following them failed, the docs (or pleatkit) were fixed. See the DEVLOG, stage 3b.

- `src/dynamic/orders-table.tsx`: the one dynamic panel, mounted as `<Dynamic id="orders-table">` in `src/App.tsx`
- `src/readonly/api.ts`: data and helpers the panel imports as `@/readonly/api`
- `fixtures/agent/`: a recorded agent answer, so the chat works without a model key

It lives inside the pleatkit repository but is not part of its pnpm workspace, and links the packages from
`../../packages`. Build pleatkit first (`pnpm build:packages` in the repository root), then here:

```bash
pnpm install --ignore-workspace
pnpm build
pnpm pleatkit-doctor # no [FAIL] (not `pnpm doctor`: that is pnpm's own command)
pnpm smoke           # agent + vite preview + pleatkit ping + one chat edit, headless; stops both servers
```

By hand: `PLEATKIT_FIXTURES=fixtures/agent pnpm agent` in one terminal, `pnpm dev` in another, open
http://localhost:5173, click Customize and ask "Show the status and make overdue orders red". With
`PLEATKIT_API_KEY` set the agent uses Claude and any request works.
