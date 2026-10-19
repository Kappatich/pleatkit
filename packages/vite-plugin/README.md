# @pleatkit/vite-plugin

The build side of [pleatkit](https://github.com/Kappatich/pleatkit): it declares which files users may change
(`dynamic`) and which the agent may read (`readonly`), and builds what the runtime and the agent server need.

- Zones, the externals registry (what edited code may import from your app) and the fallback bundle.
- `dist/pleatkit.manifest.json`: dynamic and readonly sources, core `.d.ts`, digests; the agent server trusts this
  file, never the browser.
- The runtime Tailwind module, the isolated-panel host (`<Dynamic isolated>`), the bundle's public key.

```ts
// vite.config.ts
import pleatkit from '@pleatkit/vite-plugin'

export default defineConfig({
  plugins: [
    react(),
    pleatkit({
      zones: { dynamic: ['src/dynamic/**'], readonly: ['src/readonly/**', 'src/components/ui/**'] },
      externals: ['react', 'react-dom', 'react/jsx-runtime', '@/components/ui/*', '@/lib/utils', '@/readonly/*'],
      css: 'tailwind',
      tailwindEntry: 'src/index.css',
    }),
  ],
  server: { proxy: { '/agent': 'http://localhost:8789', '/pleatkit-store': { target: 'http://localhost:8790', rewrite: (p) => p.replace(/^\/pleatkit-store/, '') }, '/pleatkit/b': { target: 'http://localhost:8790', rewrite: (p) => p.replace(/^\/pleatkit\/b/, '/v1/b') } } },
})
```

`allowedHosts: ['images.example-cdn.com']` lets `<img src>`/`srcSet` and `<a href>` of edits point to those hosts
over `https:` (default port only); every other URL stays on the app's origin. Exact host names, lower-cased (IDN as
punycode): a scheme, path, port, user info or wildcard is an error at startup, so list each subdomain. The list goes
into both copies of the manifest (the runtime guard reads the browser's, the agent's `check` only the server's). Add
each host to the CSP: `img-src 'self' https://images.example-cdn.com`.

Add `"types": ["@pleatkit/vite-plugin/client"]` to `tsconfig.json` for the `virtual:pleatkit` modules. Vite 6, 7
or 8. Anonymous install telemetry is opt-out (`PLEATKIT_TELEMETRY=0`) and sends nothing until a collector is
configured; see the repository README.

MIT. Changes: [CHANGELOG.md](https://github.com/Kappatich/pleatkit/blob/main/CHANGELOG.md).
