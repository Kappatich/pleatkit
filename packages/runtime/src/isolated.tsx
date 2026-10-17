import { useEffect, useMemo, useRef, useState } from 'react'
import type { IsolatedHostMessage, IsolatedRenderMessage } from './isolated-host.js'
import { CrashBanner, useMorphkit, useMorphkitState } from './react.js'

/** How long the frame may take to load and start its host script before the panel shows an error. */
export const ISOLATED_START_TIMEOUT_MS = 15_000

/** Text of every same-origin stylesheet on the page, so the iframe looks like the rest of the app. */
function pageCss(): string {
  const out: string[] = []
  for (const sheet of Array.from(document.styleSheets)) {
    if (sheet.ownerNode instanceof Element && sheet.ownerNode.hasAttribute('data-morphkit-css')) continue
    try {
      for (const rule of Array.from(sheet.cssRules)) out.push(rule.cssText)
    } catch {
      // cross-origin stylesheet: not readable, skipped
    }
  }
  return out.join('\n')
}

const escapeStyle = (css: string) => css.replace(/<\/style/gi, '<\\/style')
const escapeAttr = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')

/**
 * The frame's document. No inline script (DECISIONS item 16): the host is a separate file, so a strict CSP
 * (`script-src 'self' blob:`, inherited by the srcdoc frame) works without `'unsafe-inline'` or hashes.
 * The frame has an opaque origin, so the request carries `Origin: null` and the file needs CORS.
 */
export function isolatedSrcdoc(hostUrl: string, css = pageCss()): string {
  const url = new URL(hostUrl, document.baseURI).href
  return `<!doctype html><html><head><meta charset="utf-8"><style>${escapeStyle(css)}</style><style>html,body{margin:0;background:transparent;overflow:hidden}</style></head><body><div id="root"></div><script src="${escapeAttr(url)}" crossorigin="anonymous"></script></body></html>`
}

interface Props {
  id: string
  props: Record<string, unknown>
  headId: string | null
  autoRollbackMs: number
}

/** Parent side of an isolated panel: a sandboxed iframe that receives the bundle, CSS and props by postMessage. */
export function IsolatedFrame({ id, props, headId, autoRollbackMs }: Props) {
  const engine = useMorphkit()
  const state = useMorphkitState()
  const frame = useRef<HTMLIFrameElement>(null)
  const [ready, setReady] = useState(false)
  const [height, setHeight] = useState(0)
  const [error, setError] = useState<{ message: string; version: number } | null>(null)
  const sentVersion = useRef(-1)

  const hostUrl = engine.isolatedHostUrl()
  useEffect(() => {
    if (!hostUrl) setError({ message: 'Isolated mode is not enabled: set `isolated: true` in the morphkit Vite plugin options', version: -1 })
  }, [hostUrl])

  const doc = useMemo(() => (hostUrl ? isolatedSrcdoc(hostUrl) : null), [hostUrl])

  // A host script that never starts (blocked by CSP, or served without CORS) would leave an empty panel.
  useEffect(() => {
    if (!doc || ready) return
    const t = setTimeout(
      () => setError({ message: 'The isolated panel did not start: its host script was blocked or is served without Access-Control-Allow-Origin', version: -1 }),
      ISOLATED_START_TIMEOUT_MS,
    )
    return () => clearTimeout(t)
  }, [doc, ready])

  useEffect(() => {
    const onMessage = (event: MessageEvent<IsolatedHostMessage>) => {
      if (event.source !== frame.current?.contentWindow) return
      const msg = event.data
      if (msg?.type === 'morphkit:ready') {
        setReady(true)
        setError((e) => (e?.version === -1 ? null : e)) // a slow start is not a crash
      }
      else if (msg?.type === 'morphkit:size') setHeight(msg.height)
      else if (msg?.type === 'morphkit:error') setError({ message: msg.message, version: msg.version })
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [])

  // A new version of the modules: send the bundle once; props changes only re-render.
  useEffect(() => {
    const win = frame.current?.contentWindow
    if (!ready || !win) return
    const msg: IsolatedRenderMessage = { type: 'morphkit:render', id, props, version: state.version, namespace: engine.namespace }
    if (sentVersion.current !== state.version) {
      const bundle = engine.currentBundle()
      msg.js = bundle ? bundle.js : null
      // server bundles are loaded by URL inside the frame too (CORS on the bundle URL; SRI as in the page)
      if (bundle?.url) {
        msg.url = new URL(bundle.url, document.baseURI).href
        if (bundle.integrity) msg.integrity = bundle.integrity
      }
      msg.css = bundle?.css ?? ''
      sentVersion.current = state.version
      setError(null)
    }
    try {
      win.postMessage(msg, '*')
    } catch (e) {
      setError({ message: `Props for an isolated panel must be serializable: ${(e as Error).message}`, version: state.version })
    }
  }, [ready, id, props, state.version, engine])

  const crashed = error && (error.version === -1 || error.version === state.version)
  return (
    <>
      {crashed && <CrashBanner id={id} headId={error.version === -1 ? null : headId} autoRollbackMs={autoRollbackMs} engine={engine} error={new Error(error.message)} />}
      {doc && (
        <iframe
          ref={frame}
          title={`${id} (isolated)`}
          data-testid={`morphkit-isolated-${id}`}
          sandbox="allow-scripts"
          srcDoc={doc}
          style={{ display: crashed ? 'none' : 'block', width: '100%', height, border: 0, background: 'transparent' }}
        />
      )}
    </>
  )
}
