import type { PleatkitManifest } from '@pleatkit/runtime/compiler'
import type { Context, Hono } from 'hono'
import type { StoreClient } from './store-client.js'
import type { ModelProvider } from './types.js'

/**
 * DECISIONS 89: the agent server is open (MIT); what only the managed cloud needs lives in a separate package and
 * plugs in here, the way `StoreExtension` plugs into the open store. The open server runs without any extension
 * (self-host, the demo, examples/t1-vite); `createAgentApp({ extensions })` and the `pleatkit-agent` binary
 * (`PLEATKIT_AGENT_EXTENSIONS`, see extensions-loader.ts) load them when present. The open server imports nothing
 * private.
 */
export interface AgentExtension {
  name: string
  /**
   * Routes on the agent server, under its base path (`/agent` by default), behind the same CORS and body limit.
   * Authentication is the route's own: `ctx.adminApp` resolves an admin the way the server's admin routes do.
   */
  routes?(app: Hono, ctx: AgentExtensionContext): void
}

/** What an extension's routes may use. */
export interface AgentExtensionContext {
  /** The model provider (null when the server runs another harness). */
  provider: ModelProvider | null
  /** store-server's base URL as configured (null without one), and a client with this server's credentials. */
  storeUrl: string | null
  store: StoreClient | null
  /** The fetch the server was given (tests route it to an in-process store), else the global one. */
  fetch: typeof fetch
  log(line: string): void
  /** The app's manifest as the server knows it (`PLEATKIT_MANIFEST`), or null. */
  manifest(appId: string): Promise<PleatkitManifest | null>
  /**
   * The app of an admin call, or the error response to return: with credentials an admin's token, in development
   * the demo admin header (the same rule as `POST /v1/expected-cost`).
   */
  adminApp(c: Context, body: { appId?: unknown }): Promise<string | Response>
  /** The app key this server holds for `appId` (server-to-server calls to store-server), or null. */
  appKey(appId: string): string | null
  /** Append usage events (`tokens.used`, `cost.usd`, ...) to the app's metering ledger in store-server; how many were stored. */
  reportUsage(appId: string, events: Record<string, unknown>[]): Promise<number>
}
