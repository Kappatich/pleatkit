// `pnpm dev`: demo-crm (Vite) + data server + agent server + store-server, one command.
// concurrently kills the whole process tree of every child (tree-kill on Windows) on Ctrl+C or when one exits,
// so no node process is left behind on the ports (DECISIONS item 8).
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import concurrently from 'concurrently'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(path.join(root, 'package.json'))
const bin = (pkg) => path.join(path.dirname(require.resolve(`${pkg}/package.json`)), 'dist', 'cli.js')

const ports = {
  web: process.env.WEB_PORT ?? '5173',
  data: process.env.DATA_PORT ?? '8787',
  agent: process.env.AGENT_PORT ?? '8789',
  store: process.env.STORE_PORT ?? '8790',
}
const shared = { DATA_PORT: ports.data, AGENT_PORT: ports.agent, STORE_PORT: ports.store }
const storeDb = process.env.PLEATKIT_STORE_DB ?? path.join(root, '.pleatkit', 'store.db')

const { result, commands } = concurrently(
  [
    { name: 'data', command: 'tsx server/index.ts', env: shared, prefixColor: 'blue' },
    {
      name: 'agent',
      command: `node "${bin('@pleatkit/agent')}"`,
      env: {
        ...shared,
        PLEATKIT_AGENT_PORT: ports.agent,
        PLEATKIT_STORE_URL: `http://localhost:${ports.store}`,
        PLEATKIT_FIXTURES: process.env.PLEATKIT_FIXTURES ?? path.join(root, 'e2e', 'fixtures', 'agent'),
        // the dev server serves the manifest; the agent re-reads it (code review 06 item 8)
        PLEATKIT_MANIFEST: process.env.PLEATKIT_MANIFEST ?? `http://localhost:${ports.web}/pleatkit.manifest.json`,
      },
      prefixColor: 'magenta',
    },
    {
      name: 'store',
      command: `node "${bin('@pleatkit/store-server')}"`,
      env: { ...shared, PLEATKIT_STORE_PORT: ports.store, PLEATKIT_STORE_DB: storeDb },
      prefixColor: 'yellow',
    },
    { name: 'web', command: `vite --port ${ports.web} --strictPort`, env: shared, prefixColor: 'green' },
  ],
  { cwd: root, killOthers: ['failure', 'success'], killSignal: 'SIGTERM', prefix: 'name' },
)

const stopAll = () => commands.forEach((c) => c.kill())
process.on('SIGINT', stopAll)
process.on('SIGTERM', stopAll)
process.on('SIGBREAK', stopAll)
// Windows cannot deliver SIGINT to another process, so scripts/dev-smoke.mjs asks over IPC (same path as Ctrl+C).
process.on('message', (m) => m === 'shutdown' && stopAll())

result.then(
  () => process.exit(0),
  () => process.exit(0),
)
