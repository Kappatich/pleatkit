# @pleatkit/runtime

The browser side of [pleatkit](https://github.com/Kappatich/pleatkit): it lets each user of your Vite + React app
change parts of its interface by asking an agent, with per-user versions, undo and reset.

- `<PleatkitProvider>` and `<Dynamic id="…">`: panels in `src/dynamic/` render from the user's version.
- The snapshot engine: draft, check, commit, undo, redo, reset; edits load as signed bundles from your origin
  (`compile: 'server'`, the default) or compile in the page (`compile: 'browser'`).
- Stores: `HttpStore` (the open [store-server](../store-server)) and `LocalStore` (IndexedDB, for a quick look).
- Safe mode, the kill switch, per-file release carry-over, Tailwind 4 utilities for edits at runtime.
- `@pleatkit/runtime/compiler` (no React, safe in Node): the shared check, bundle keys, signatures, quotas.
- `@pleatkit/runtime/security`: user tokens (`mintUserToken`) and app keys for your backend.

```bash
pnpm add @pleatkit/runtime @pleatkit/ui && pnpm add -D @pleatkit/vite-plugin @pleatkit/agent @pleatkit/cli
```

```tsx
import * as config from 'virtual:pleatkit'
import { HttpStore, PleatkitProvider } from '@pleatkit/runtime'

const store = new HttpStore({ baseUrl: '/pleatkit-store', userId: user.id, appId: 'my-app' })

<PleatkitProvider config={config} store={store} userId={user.id}>
  <App />
</PleatkitProvider>
```

React 18 or 19. The full install (five steps, the CSP, production auth) is in the repository README and in
[docs/for-agents/install.md](https://github.com/Kappatich/pleatkit/blob/main/docs/for-agents/install.md).

MIT. Changes: [CHANGELOG.md](https://github.com/Kappatich/pleatkit/blob/main/CHANGELOG.md).
