import { useEffect, useState, type CSSProperties } from 'react'
import { CommitRejectedError } from './engine.js'
import { usePleatkit, usePleatkitState } from './react.js'
import type { Snapshot } from './types.js'

const panel: CSSProperties = {
  position: 'fixed',
  right: 12,
  bottom: 12,
  width: 560,
  maxWidth: 'calc(100vw - 24px)',
  maxHeight: 'calc(100vh - 24px)',
  overflow: 'auto',
  zIndex: 2147483000,
  background: '#0f172a',
  color: '#e2e8f0',
  borderRadius: 10,
  boxShadow: '0 10px 30px rgba(0,0,0,.35)',
  font: '12px ui-sans-serif, system-ui, sans-serif',
  padding: 10,
}
const btn: CSSProperties = {
  padding: '4px 10px',
  marginRight: 6,
  borderRadius: 6,
  border: '1px solid #334155',
  background: '#1e293b',
  color: '#e2e8f0',
  cursor: 'pointer',
}
const mono: CSSProperties = { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 12 }

/**
 * Temporary developer panel (Stage 1): edit a dynamic file by hand and run check / commit / undo
 * without the agent. Mount it behind a flag such as `?dev=1`.
 */
export function DevPanel() {
  const engine = usePleatkit()
  const state = usePleatkitState()
  const files = state.draft?.files ?? engine.files()
  const paths = Object.keys(files).sort()
  const [open, setOpen] = useState(true)
  const [path, setPath] = useState(paths[0] ?? '')
  const [text, setText] = useState<string | null>(null)
  const [status, setStatus] = useState('')
  const [busy, setBusy] = useState(false)
  const [history, setHistory] = useState<Snapshot[]>([])
  const source = text ?? files[path] ?? ''

  useEffect(() => {
    let alive = true
    void engine.history(20).then((h) => alive && setHistory(h))
    return () => {
      alive = false
    }
  }, [engine, state.head?.id, state.lastCheck])

  const flush = () => {
    if (!engine.getState().draft) engine.draft.start('Dev panel edit')
    if (text !== null) engine.draft.write(path, text)
  }

  const run = async (label: string, op: () => Promise<string>) => {
    setBusy(true)
    setStatus(`${label}…`)
    try {
      setStatus(await op())
    } catch (e) {
      setStatus(e instanceof CommitRejectedError ? 'Commit rejected: the draft does not compile.' : `Error: ${(e as Error).message}`)
    } finally {
      setBusy(false)
    }
  }

  const check = () =>
    run('Checking', async () => {
      flush()
      const r = await engine.draft.check()
      return r.ok ? `Check passed in ${r.timeMs.toFixed(0)} ms` : `Check failed: ${r.errors.length} error(s)`
    })

  const commit = () =>
    run('Committing', async () => {
      flush()
      const s = await engine.draft.commit('user')
      setText(null)
      return `Committed ${s.id.slice(-6)}`
    })

  const nav = (label: string, op: () => Promise<Snapshot | null>) =>
    run(label, async () => {
      setText(null)
      engine.draft.discard()
      const s = await op()
      return s ? `${label}: head is ${s.id.slice(-6)} (${s.author})` : `${label}: nothing to do`
    })

  const selectFile = (next: string) => {
    if (text !== null) flush()
    setText(null)
    setPath(next)
  }

  const check_ = state.lastCheck
  if (!open) {
    return (
      <button type="button" style={{ ...btn, position: 'fixed', right: 12, bottom: 12, zIndex: 2147483000 }} onClick={() => setOpen(true)}>
        pleatkit dev
      </button>
    )
  }

  return (
    <section style={panel} data-testid="mk-dev-panel" aria-label="pleatkit developer panel">
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
        <strong>pleatkit dev · {engine.userId}</strong>
        <span data-testid="mk-head" style={mono}>
          head: {state.head ? `${state.head.id.slice(-6)} (${state.head.author})` : 'base'}
          {state.draft ? ' · draft' : ''}
        </span>
        <button type="button" style={{ ...btn, marginRight: 0 }} onClick={() => setOpen(false)}>
          ×
        </button>
      </div>

      <select data-testid="mk-file" value={path} onChange={(e) => selectFile(e.target.value)} style={{ ...mono, width: '100%', marginBottom: 6 }}>
        {paths.map((p) => (
          <option key={p} value={p}>
            {p}
          </option>
        ))}
      </select>
      <textarea
        data-testid="mk-source"
        value={source}
        onChange={(e) => setText(e.target.value)}
        spellCheck={false}
        style={{ ...mono, width: '100%', height: 260, boxSizing: 'border-box', background: '#020617', color: '#e2e8f0', border: '1px solid #334155', borderRadius: 6 }}
      />

      <div style={{ margin: '6px 0' }}>
        <button type="button" style={btn} disabled={busy} onClick={check} data-testid="mk-check">
          Check
        </button>
        <button type="button" style={btn} disabled={busy} onClick={commit} data-testid="mk-commit">
          Commit
        </button>
        <button type="button" style={btn} disabled={busy || !state.canUndo} onClick={() => nav('Undo', () => engine.undo())} data-testid="mk-undo">
          Undo
        </button>
        <button type="button" style={btn} disabled={busy || !state.canRedo} onClick={() => nav('Redo', () => engine.redo())} data-testid="mk-redo">
          Redo
        </button>
        <button type="button" style={btn} disabled={busy || !state.canUndo} onClick={() => nav('Reset', () => engine.reset())} data-testid="mk-reset">
          Reset
        </button>
        <button
          type="button"
          style={btn}
          disabled={busy || (!state.draft && text === null)}
          onClick={() => {
            engine.draft.discard()
            setText(null)
            setStatus('Draft discarded')
          }}
          data-testid="mk-discard"
        >
          Discard
        </button>
      </div>

      <div data-testid="mk-status" style={{ marginBottom: 4 }}>
        {status}
      </div>
      {state.error && <div style={{ color: '#fca5a5' }}>{state.error}</div>}
      {check_ && (
        <div data-testid="mk-result" data-ok={String(check_.ok)} style={{ marginBottom: 6 }}>
          {check_.ok ? (
            <span style={{ color: '#86efac' }}>✓ compiles · {check_.timeMs.toFixed(0)} ms · {check_.hash.slice(0, 8)}</span>
          ) : (
            <ul style={{ margin: 0, paddingLeft: 16, color: '#fca5a5' }}>
              {check_.errors.map((e, i) => (
                <li key={i} data-testid="mk-error" data-file={e.file} data-line={e.line} data-column={e.column} style={mono}>
                  {e.file}:{e.line}:{e.column} {e.text}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <details>
        <summary>History ({history.length})</summary>
        <ol data-testid="mk-history" style={{ ...mono, margin: 0, paddingLeft: 18 }}>
          {history.map((s) => (
            <li key={s.id} style={{ opacity: s.status === 'rejected' ? 0.5 : 1 }}>
              {s.id.slice(-6)} {s.author} {s.status} {s.id === state.head?.id ? '← head' : ''} {s.message}
            </li>
          ))}
        </ol>
      </details>
      <details>
        <summary>Metrics</summary>
        <pre data-testid="mk-metrics" style={{ ...mono, margin: 0, whiteSpace: 'pre-wrap' }}>
          {JSON.stringify(engine.metrics, null, 1)}
        </pre>
      </details>
    </section>
  )
}
