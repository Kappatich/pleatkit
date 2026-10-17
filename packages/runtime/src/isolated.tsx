import { useEffect, useMemo, useRef, useState } from 'react'
import type { IsolatedHostMessage, IsolatedRenderMessage } from './isolated-host.js'
import { CrashBanner, useMorphkit, useMorphkitState } from './react.js'

let hostCode: Promise<string> | null = null

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

const escapeScript = (code: string) => code.replace(/<\/script/gi, '<\\/script')
const escapeStyle = (css: string) => css.replace(/<\/style/gi, '<\\/style')

function srcdoc(code: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><style>${escapeStyle(pageCss())}</style><style>html,body{margin:0;background:transparent;overflow:hidden}</style></head><body><div id="root"></div><script>${escapeScript(code)}</script></body></html>`
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
  const [code, setCode] = useState<string | null>(null)
  const [ready, setReady] = useState(false)
  const [height, setHeight] = useState(0)
  const [error, setError] = useState<{ message: string; version: number } | null>(null)
  const sentVersion = useRef(-1)

  useEffect(() => {
    const load = engine.isolatedLoader()
    if (!load) {
      setError({ message: 'Isolated mode is not enabled: set `isolated: true` in the morphkit Vite plugin options', version: -1 })
      return
    }
    let alive = true
    ;(hostCode ??= load()).then(
      (c) => alive && setCode(c),
      (e: Error) => alive && setError({ message: `Could not load the isolated host: ${e.message}`, version: -1 }),
    )
    return () => {
      alive = false
    }
  }, [engine])

  const doc = useMemo(() => (code ? srcdoc(code) : null), [code])

  useEffect(() => {
    const onMessage = (event: MessageEvent<IsolatedHostMessage>) => {
      if (event.source !== frame.current?.contentWindow) return
      const msg = event.data
      if (msg?.type === 'morphkit:ready') setReady(true)
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
    const msg: IsolatedRenderMessage = { type: 'morphkit:render', id, props, version: state.version }
    if (sentVersion.current !== state.version) {
      const bundle = engine.currentBundle()
      msg.js = bundle ? bundle.js : null
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
