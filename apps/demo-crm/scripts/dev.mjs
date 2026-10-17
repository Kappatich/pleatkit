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
const storeDb = process.env.MORPHKIT_STORE_DB ?? path.join(root, '.morphkit', 'store.db')

const { result, commands } = concurrently(
  [
    { name: 'data', command: 'tsx server/index.ts', env: shared, prefixColor: 'blue' },
    {
      name: 'agent',
      command: `node "${bin('@morphkit/agent')}"`,
      env: {
        ...shared,
        MORPHKIT_AGENT_PORT: ports.agent,
        MORPHKIT_STORE_URL: `http://localhost:${ports.store}`,
        MORPHKIT_FIXTURES: process.env.MORPHKIT_FIXTURES ?? path.join(root, 'e2e', 'fixtures', 'agent'),
        // the dev server serves the manifest; the agent re-reads it (code review 06 item 8)
        MORPHKIT_MANIFEST: process.env.MORPHKIT_MANIFEST ?? `http://localhost:${ports.web}/morphkit.manifest.json`,
      },
      prefixColor: 'magenta',
    },
    {
      name: 'store',
      command: `node "${bin('@morphkit/store-server')}"`,
      env: { ...shared, MORPHKIT_STORE_PORT: ports.store, MORPHKIT_STORE_DB: storeDb },
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
