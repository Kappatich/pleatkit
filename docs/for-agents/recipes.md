# Recipes: panels that use context, a store or the router

A dynamic panel imports only other dynamic files and the `externals` (install.md step 3). Panels in real apps read data through hooks: TanStack Query, Redux, the router, an auth context. The rule is the same for all of them: **the hook lives in the readonly zone, is listed in `externals`, and the panel imports it from there.** The panel's code is compiled separately, but it runs in the same React tree, so contexts and providers of the app reach it as usual.

## Context (auth, theme, feature flags)

```ts
// src/readonly/session.ts (readonly)
export { useSession } from '@/core/session' // the app's own hook
export type { Session } from '@/core/session'
```

```ts
morphkit({ zones: { dynamic: ['src/dynamic/**'], readonly: ['src/readonly/**'] }, externals: ['react', 'react/jsx-runtime', '@/readonly/*'] })
```

```tsx
// src/dynamic/account-card.tsx (dynamic)
import { useSession } from '@/readonly/session'
export default function AccountCard() {
  const { user } = useSession()
  return <div>{user.name}</div>
}
```

The panel never imports `@/core/*` directly; the agent sees `@/core/session` only as `.d.ts`.

## TanStack Query

Wrap each query the panels may use in a readonly hook, so the agent sees one typed function per data need and the query keys stay in one place:

```ts
// src/readonly/queries.ts
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api, type Deal } from './api'
export const useDeals = (customerId: string) => useQuery({ queryKey: ['deals', customerId], queryFn: () => api.listDeals(customerId) })
export function useRenameDeal() {
  const qc = useQueryClient()
  return useMutation({ mutationFn: (d: Pick<Deal, 'id' | 'name'>) => api.renameDeal(d.id, d.name), onSuccess: () => qc.invalidateQueries({ queryKey: ['deals'] }) })
}
```

`externals: [..., '@/readonly/*']` is enough; do not add `@tanstack/react-query` itself unless you want panels to write new queries (then the agent can call arbitrary endpoints of the typed client only, the static rules still refuse raw URLs).

## Redux / Zustand

Expose selectors and action hooks, not the store:

```ts
// src/readonly/store.ts
import { useAppDispatch, useAppSelector } from '@/core/store'
import { selectFilters, setFilter } from '@/core/filters-slice'
export const useFilters = () => useAppSelector(selectFilters)
export const useSetFilter = () => { const d = useAppDispatch(); return (k: string, v: string) => d(setFilter({ k, v })) }
```

Panels then read and write UI state through these two functions. Writes to server data still go only through the typed client, and only on a user action (never in render or `useEffect`).

## Router (TanStack Router, React Router)

```ts
// src/readonly/nav.ts
export { Link, useNavigate, useParams } from '@tanstack/react-router' // or react-router
```

Links inside panels use relative paths (`<Link to="/customers/$id" params={{ id }}>`). `location.href = …`, `window.open` and absolute URLs are refused by the static rules.

## The design-system profile (`designSystem`)

Tell the agent which components exist and how to use them; the plugin turns their declarations into one line per component for the prompt's cached prefix:

```ts
morphkit({
  zones: { dynamic: ['src/dynamic/**'], readonly: ['src/readonly/**', 'src/components/ui/**'] },
  externals: ['react', 'react/jsx-runtime', '@/components/ui/*', '@/readonly/*'],
  designSystem: {
    components: ['@/components/ui/*'], // modules whose exported components go into the digest
    docs: 'docs/design-system.md',      // optional: usage rules, tokens, do and don't (first 8 KB)
  },
})
```

The manifest then carries `designSystem.digest`, e.g.

```
src/components/ui/button: Button(variant?: "default" | "destructive" | "outline" | "ghost", size?: "sm" | "default" | "lg", asChild?: boolean)
src/components/ui/card: Card; CardHeader; CardTitle; CardContent
```

and `dataContracts.digest`, the exported types and client methods of readonly files named `api`, `types`, `models` or `client` (signatures only). Check what the agent gets: `cat dist/morphkit.manifest.json | jq '.designSystem, .dataContracts'`.

Listing a whole UI kit in `externals` (`@/components/ui/*`) only adds the files that exist; lazy externals (the default) load a component only when an edit uses it.
