# @pleatkit/ui

The chat drawer of [pleatkit](https://github.com/Kappatich/pleatkit): the user asks for a change in words, points at
a panel or pastes a screenshot, follows one live status line, and undoes, restores or resets their version.

- `<PleatkitChat agentUrl="/agent" />` inside `<PleatkitProvider>` (from `@pleatkit/runtime`).
- The element picker, the version history with restore, toasts with undo, the "the app was updated" banner, the
  AI disclaimer; English and Russian (`locale="ru"`); a bottom sheet on phones; `prefers-reduced-motion` respected.

```bash
pnpm add @pleatkit/ui @pleatkit/runtime
```

```tsx
import { PleatkitChat } from '@pleatkit/ui'

<PleatkitProvider config={config} store={store} userId={user.id}>
  <App />
  <PleatkitChat agentUrl="/agent" />
</PleatkitProvider>
```

React 18 or 19. MIT. Changes: [CHANGELOG.md](https://github.com/Kappatich/pleatkit/blob/main/CHANGELOG.md).
