// Runs inside the sandboxed iframe of an `isolated` <Dynamic> panel (sandbox="allow-scripts", opaque origin).
// The Vite plugin bundles this file together with React and the app's externals into one classic script that
// the frame loads from the app's origin with CORS (no inline script, DECISIONS item 16); edits arrive by postMessage.

import { Component, type ComponentType, type ErrorInfo, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { applyCss, importBundle, importUrl, installExternals, registryFor } from './loader.js'
import type { ExternalEntry, ModuleNamespace } from './types.js'

export interface IsolatedHostOptions {
  externals: Record<string, ExternalEntry>
  /** Base modules by path (the original version of the dynamic zone). */
  fallback: Record<string, ModuleNamespace>
  dynamicRoots: string[]
}

/** Parent → iframe. `js: null` means "use the original version"; `undefined` keeps the current modules. */
export interface IsolatedRenderMessage {
  type: 'morphkit:render'
  id: string
  props: Record<string, unknown>
  version: number
  /** App instance namespace the bundle was compiled for (V1 B6). */
  namespace?: string
  js?: string | null
  /** Server bundle: loaded by URL with this SRI digest instead of `js`. */
  url?: string
  integrity?: string
  css?: string
}

/** Iframe → parent. */
export type IsolatedHostMessage =
  | { type: 'morphkit:ready' }
  | { type: 'morphkit:size'; height: number }
  | { type: 'morphkit:error'; message: string; version: number }
  | { type: 'morphkit:rendered'; version: number }

function byId(modules: Record<string, ModuleNamespace>, roots: string[]): Record<string, ModuleNamespace> {
  const out: Record<string, ModuleNamespace> = {}
  for (const [path, ns] of Object.entries(modules)) {
    const root = roots.find((r) => path.startsWith(r)) ?? ''
    out[path.slice(root.length).replace(/\.(tsx|ts|jsx|js|mts|mjs)$/, '')] = ns
  }
  return out
}

const post = (msg: IsolatedHostMessage) => window.parent.postMessage(msg, '*')

class Boundary extends Component<{ version: number; children: ReactNode }, { error: Error | null }> {
  override state = { error: null as Error | null }
  static getDerivedStateFromError(error: Error) {
    return { error }
  }
  override componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[morphkit isolated] panel crashed', error, info.componentStack)
    post({ type: 'morphkit:error', message: error.message, version: this.props.version })
  }
  override render() {
    return this.state.error ? null : this.props.children
  }
}

export function startIsolatedHost(options: IsolatedHostOptions): void {
  installExternals(options.externals)
  const container = document.getElementById('root') ?? document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  let modules = byId(options.fallback, options.dynamicRoots)

  window.addEventListener('message', async (event: MessageEvent<IsolatedRenderMessage>) => {
    // Only the embedding page may drive this frame.
    if (event.source !== window.parent || event.data?.type !== 'morphkit:render') return
    const msg = event.data
    try {
      const ns = msg.namespace ?? 'default'
      if (!registryFor(ns)) installExternals(options.externals, ns)
      if (msg.js === null) modules = byId(options.fallback, options.dynamicRoots)
      else if (msg.url) {
        await registryFor(ns)!.ensure()
        modules = byId(await importUrl(msg.url, msg.integrity), options.dynamicRoots)
      } else if (typeof msg.js === 'string') {
        await registryFor(ns)!.ensure()
        modules = byId(await importBundle(msg.js), options.dynamicRoots)
      }
      if (msg.css !== undefined) applyCss(msg.css)
    } catch (e) {
      post({ type: 'morphkit:error', message: `Module failed to load: ${(e as Error).message}`, version: msg.version })
      return
    }
    const C = modules[msg.id]?.default as ComponentType<Record<string, unknown>> | undefined
    if (!C) {
      post({ type: 'morphkit:error', message: `Dynamic component "${msg.id}" has no default export`, version: msg.version })
      return
    }
    root.render(
      <Boundary key={msg.version} version={msg.version}>
        <C {...msg.props} />
      </Boundary>,
    )
    post({ type: 'morphkit:rendered', version: msg.version })
  })

  let last = -1
  const report = () => {
    const height = Math.ceil(document.documentElement.getBoundingClientRect().height)
    if (height !== last) post({ type: 'morphkit:size', height: (last = height) })
  }
  new ResizeObserver(report).observe(document.documentElement)
  post({ type: 'morphkit:ready' })
}
