import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig, type Connect, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import pleatkit from '@pleatkit/vite-plugin'

const root = path.dirname(fileURLToPath(import.meta.url))

/**
 * The Content Security Policies from the README. `?csp=strict`: browser compile mode (edits from blob: URLs,
 * WebAssembly for esbuild). `?csp=strict-no-blob`: server compile mode (V1 B1): scripts only from the app's
 * own origin, no blob:, no WebAssembly, no workers.
 */
const STRICT_CSP = [
  "default-src 'self'",
  "script-src 'self' blob: 'wasm-unsafe-eval'",
  'worker-src blob:',
  "style-src 'self' 'unsafe-inline'",
  "connect-src 'self'",
  "img-src 'self' data:",
].join('; ')
const STRICT_NO_BLOB_CSP = ["default-src 'self'", "script-src 'self'", "worker-src 'none'", "style-src 'self' 'unsafe-inline'", "connect-src 'self'", "img-src 'self' data:"].join('; ')

const strictCsp: Connect.NextHandleFunction = (req, res, next) => {
  if (req.url && /[?&]csp=strict(&|$)/.test(req.url)) res.setHeader('Content-Security-Policy', STRICT_CSP)
  if (req.url && /[?&]csp=strict-no-blob(&|$)/.test(req.url)) res.setHeader('Content-Security-Policy', STRICT_NO_BLOB_CSP)
  next()
}

function strictCspDemo(): Plugin {
  return {
    name: 'demo-strict-csp',
    configureServer: (s) => void s.middlewares.use(strictCsp),
    configurePreviewServer: (s) => void s.middlewares.use(strictCsp),
  }
}
const dataPort = process.env.DATA_PORT ?? '8787'
const agentPort = process.env.AGENT_PORT ?? '8789'
const storePort = process.env.STORE_PORT ?? '8790'

// One origin for the browser: the app, its data API, the agent server and store-server.
const proxy = {
  '/api': `http://localhost:${dataPort}`,
  '/agent': `http://localhost:${agentPort}`,
  '/pleatkit-store': { target: `http://localhost:${storePort}`, rewrite: (p: string) => p.replace(/^\/pleatkit-store/, '') },
  // signed bundles of server-compiled edits, from the app's own origin (V1 B1)
  '/pleatkit/b': { target: `http://localhost:${storePort}`, rewrite: (p: string) => p.replace(/^\/pleatkit\/b/, '/v1/b') },
}

export default defineConfig({
  plugins: [
    strictCspDemo(),
    react(),
    tailwindcss(),
    pleatkit({
      zones: {
        dynamic: ['src/dynamic/**'],
        readonly: ['src/readonly/**', 'src/components/ui/**'],
      },
      externals: ['react', 'react-dom', 'react/jsx-runtime', '@/components/ui/*', '@/lib/utils', '@/readonly/*'],
      // Edits get exactly the Tailwind utilities they use, compiled in the browser at commit.
      css: 'tailwind',
      tailwindEntry: 'src/index.css',
      // `<Dynamic isolated>` renders a panel in a sandboxed iframe (?isolated=1 in the demo).
      isolated: true,
      // edits compile on the agent server and load signed from /pleatkit/b (the default; ?compile=browser in the demo)
      compile: 'server',
      // the components and the panel conventions (data fields keep data-testid = field name) for the agent's prompt
      designSystem: { components: ['@/components/ui/*'], docs: 'docs/design-system.md' },
    }),
  ],
  resolve: { alias: { '@': path.join(root, 'src') } },
  server: { port: 5173, proxy },
  preview: { port: 4173, proxy },
})
