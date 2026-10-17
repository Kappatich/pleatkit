import { useInsertionEffect } from 'react'

// Self-contained styles: the host app may not use Tailwind, so the UI ships plain CSS with an `mk-` prefix.
// Visual language: "cyanotype" (docs/DESIGN.md). Light sheet by default so the drawer sits quietly inside a
// customer's app; `data-mk-theme="dark"` on <html> or the root switches to the blueprint sheet. Fonts fall back
// to the host's system stacks: the drawer never loads web fonts into someone else's app.
const CSS = `
.mk-root, .mk-root * { box-sizing: border-box; }
.mk-root {
  --mk-paper: #f4f7fc; --mk-paper-2: #e9eef8; --mk-paper-3: #ffffff;
  --mk-ink: #0d2b5c; --mk-ink-2: #3a5486; --mk-ink-3: #6b82ad;
  --mk-rule: #c6d3ea; --mk-rule-2: #9fb4d9;
  --mk-signal: #ffcf1f; --mk-signal-ink: #8a6a00; --mk-signal-wash: rgba(255,207,31,.22);
  --mk-blue: #1b6fb8; --mk-ok: #1f7a4d; --mk-bad: #b42318; --mk-bad-wash: rgba(180,35,24,.08);
  --mk-font: "Archivo", "Helvetica Neue", Arial, system-ui, sans-serif;
  --mk-mono: "Azeret Mono", ui-monospace, "SFMono-Regular", Menlo, Consolas, monospace;
  font: 14px/1.45 var(--mk-font); color: var(--mk-ink);
}
[data-mk-theme="dark"] .mk-root, .mk-root[data-mk-theme="dark"] {
  --mk-paper: #0d2b5c; --mk-paper-2: #0a2349; --mk-paper-3: #113570;
  --mk-ink: #eaf2ff; --mk-ink-2: #b7c9ea; --mk-ink-3: #7f98c6;
  --mk-rule: #2a4f8f; --mk-rule-2: #3b63a6;
  --mk-signal: #ffd23f; --mk-signal-ink: #ffd23f; --mk-signal-wash: rgba(255,210,63,.14);
  --mk-blue: #8fd6ff; --mk-ok: #7ef0b0; --mk-bad: #ff8a80; --mk-bad-wash: rgba(255,138,128,.12);
}
.mk-label { font-family: var(--mk-mono); font-size: 10.5px; letter-spacing: .12em; text-transform: uppercase; color: var(--mk-ink-3); }

/* launcher */
.mk-launch { position: fixed; right: 20px; bottom: 20px; z-index: 2147482000; display: inline-flex; align-items: center; gap: 10px;
  padding: 10px 14px 10px 12px; border-radius: 0; border: 1.5px solid var(--mk-ink); background: var(--mk-paper-3); color: var(--mk-ink);
  font: 600 12.5px/1 var(--mk-mono); letter-spacing: .04em; text-transform: uppercase; cursor: pointer; }
.mk-launch::after { content: ""; position: absolute; right: -5px; bottom: -5px; width: 10px; height: 10px; border-right: 1.5px solid var(--mk-ink); border-bottom: 1.5px solid var(--mk-ink); }
.mk-launch:hover { background: var(--mk-ink); color: var(--mk-paper); }
.mk-dot { width: 12px; height: 12px; border: 1.5px solid currentColor; background: repeating-linear-gradient(-45deg, var(--mk-signal) 0 2px, transparent 2px 5px); }

/* drawer as a sheet */
.mk-drawer { position: fixed; top: 0; right: 0; bottom: 0; width: 420px; max-width: 100vw; z-index: 2147482001; display: flex; flex-direction: column;
  background: var(--mk-paper); color: var(--mk-ink); border-left: 1.5px solid var(--mk-ink);
  background-image: linear-gradient(var(--mk-rule) 1px, transparent 1px), linear-gradient(90deg, var(--mk-rule) 1px, transparent 1px);
  background-size: 48px 48px; background-position: -1px -1px; }
.mk-head { display: flex; align-items: center; justify-content: space-between; padding: 12px 16px; border-bottom: 1px solid var(--mk-rule-2); background: var(--mk-paper-3); }
.mk-title { font-weight: 700; font-size: 15px; letter-spacing: -.01em; }
.mk-sub { font-family: var(--mk-mono); font-size: 10.5px; letter-spacing: .08em; text-transform: uppercase; color: var(--mk-ink-3); margin-top: 2px; }
.mk-icon { border: 1px solid transparent; background: transparent; font-size: 18px; line-height: 1; cursor: pointer; color: var(--mk-ink-2); padding: 4px 8px; border-radius: 0; font-family: var(--mk-mono); }
.mk-icon:hover { border-color: var(--mk-ink); color: var(--mk-ink); }
.mk-body { flex: 1; overflow-y: auto; padding: 14px 16px; display: flex; flex-direction: column; gap: 14px; }
.mk-empty { color: var(--mk-ink-2); font-size: 13px; }
.mk-empty ul { margin: 8px 0 0; padding: 0; list-style: none; display: flex; flex-direction: column; gap: 6px; }

/* turns */
.mk-turn { display: flex; flex-direction: column; gap: 8px; }
.mk-req { align-self: flex-end; max-width: 92%; background: var(--mk-ink); color: var(--mk-paper); padding: 8px 12px; border-radius: 0; white-space: pre-wrap; font-family: var(--mk-mono); font-size: 12.5px; line-height: 1.5; }
.mk-req::before { content: "> "; color: var(--mk-signal); font-weight: 600; }
.mk-resp { position: relative; align-self: flex-start; width: 100%; background: var(--mk-paper-3); border: 1px solid var(--mk-rule-2); padding: 10px 12px; border-radius: 0; }
.mk-resp::before, .mk-resp::after { content: ""; position: absolute; width: 8px; height: 8px; pointer-events: none; border-color: var(--mk-ink); border-style: solid; border-width: 0; }
.mk-resp::before { left: -1px; top: -1px; border-left-width: 1.5px; border-top-width: 1.5px; }
.mk-resp::after { right: -1px; bottom: -1px; border-right-width: 1.5px; border-bottom-width: 1.5px; }
.mk-steps { list-style: none; margin: 6px 0 0; padding: 0; font-family: var(--mk-mono); font-size: 11.5px; color: var(--mk-ink-2); display: flex; flex-direction: column; gap: 2px; }
.mk-steps li { display: flex; gap: 6px; align-items: baseline; }
.mk-steps li::before { content: "·"; color: var(--mk-ink-3); }
.mk-steps li.mk-bad::before { content: "×"; color: var(--mk-bad); }
.mk-steps li.mk-good::before { content: "✓"; color: var(--mk-ok); }
.mk-steps li.mk-transient::before { content: "▸"; color: var(--mk-signal-ink); }
.mk-steps li.mk-transient { color: var(--mk-ink); }
.mk-count { margin-left: 4px; color: var(--mk-ink-3); }
.mk-details { display: block; border: 0; background: transparent; padding: 0; margin: 4px 0 0; font: 11px var(--mk-mono); letter-spacing: .04em; text-transform: uppercase; color: var(--mk-ink-3); cursor: pointer; text-decoration: none; }
.mk-details:hover { color: var(--mk-signal-ink); }
.mk-example { border: 1px dashed var(--mk-ink-3) !important; padding: 6px 10px !important; text-align: left; color: var(--mk-ink-2) !important; background: transparent !important; font-family: var(--mk-mono) !important; font-size: 12px !important; }
.mk-example:hover { border-style: solid !important; border-color: var(--mk-signal) !important; color: var(--mk-signal-ink) !important; }
.mk-summary { margin-top: 8px; font-size: 13.5px; line-height: 1.5; }
.mk-disclaimer { font-family: var(--mk-mono); font-size: 10.5px; color: var(--mk-ink-3); text-align: center; letter-spacing: .02em; }
.mk-clarify { margin-top: 8px; display: flex; flex-direction: column; gap: 6px; }
.mk-thumbs { display: flex; gap: 6px; flex-wrap: wrap; }
.mk-thumb { position: relative; display: inline-block; }
.mk-thumb img { height: 56px; max-width: 96px; object-fit: cover; border-radius: 0; border: 1px solid var(--mk-rule-2); display: block; }
.mk-thumb button { position: absolute; top: -6px; right: -6px; width: 18px; height: 18px; border-radius: 0; border: 1px solid var(--mk-ink); background: var(--mk-paper-3); color: var(--mk-ink); font: 11px/16px var(--mk-mono); padding: 0; cursor: pointer; }
.mk-req-thumbs { display: flex; gap: 4px; margin-top: 6px; }
.mk-req-thumbs img { height: 40px; max-width: 72px; object-fit: cover; border-radius: 0; border: 1px solid rgba(255,255,255,.4); }
.mk-drawer.mk-dragging { outline: 2px dashed var(--mk-signal); outline-offset: -8px; }
.mk-dropzone { position: absolute; inset: 0; z-index: 2; display: grid; place-items: center; background: var(--mk-signal-wash); color: var(--mk-ink); font: 600 12px var(--mk-mono); letter-spacing: .08em; text-transform: uppercase; pointer-events: none; }

/* badges */
.mk-badge { display: inline-block; font: 600 10.5px var(--mk-mono); letter-spacing: .1em; text-transform: uppercase; padding: 2px 8px; border-radius: 0; margin-right: 6px; border: 1px solid currentColor; }
.mk-b-ok { color: var(--mk-ok); background: transparent; }
.mk-b-admin { color: var(--mk-signal-ink); background: var(--mk-signal-wash); border-color: var(--mk-signal); }
.mk-b-bad { color: var(--mk-bad); background: var(--mk-bad-wash); }
.mk-b-run { color: var(--mk-blue); background: transparent; }
.mk-meta { font-family: var(--mk-mono); font-size: 10.5px; color: var(--mk-ink-3); margin-top: 6px; letter-spacing: .02em; }
.mk-errors { margin: 4px 0 0; padding-left: 16px; font: 11px var(--mk-mono); color: var(--mk-bad); }

/* footer: prompt bar */
.mk-foot { border-top: 1px solid var(--mk-rule-2); padding: 12px 16px 12px; display: flex; flex-direction: column; gap: 8px; background: var(--mk-paper-3); }
.mk-input { width: 100%; min-height: 64px; resize: vertical; border: 1.5px solid var(--mk-ink); border-radius: 0; padding: 8px 10px; font: 13px/1.5 var(--mk-mono); color: var(--mk-ink); background: var(--mk-paper); }
.mk-input::placeholder { color: var(--mk-ink-3); }
.mk-input:focus { outline: 2px solid var(--mk-signal); outline-offset: 0; }
.mk-row { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
.mk-btn { position: relative; border: 1.5px solid var(--mk-ink); background: var(--mk-paper-3); color: var(--mk-ink); padding: 6px 10px; border-radius: 0; font: 600 12px var(--mk-mono); letter-spacing: .02em; cursor: pointer; }
.mk-btn:hover:not(:disabled) { background: var(--mk-ink); color: var(--mk-paper); }
.mk-btn:disabled { opacity: .4; cursor: default; }
.mk-primary { background: var(--mk-signal); color: #0d2b5c; border-color: var(--mk-signal); margin-left: auto; }
.mk-primary:hover:not(:disabled) { background: #ffe178; border-color: #ffe178; color: #0d2b5c; }
.mk-on { background: var(--mk-signal-wash); border-color: var(--mk-signal); }

/* history as a version ruler */
.mk-history { max-height: 180px; overflow-y: auto; margin: 0; padding: 0; list-style: none; font: 11.5px var(--mk-mono); border: 1px solid var(--mk-rule-2); background: var(--mk-paper); }
.mk-history li { position: relative; padding: 6px 10px 6px 18px; border-bottom: 1px solid var(--mk-rule); display: flex; gap: 8px; color: var(--mk-ink-2); }
.mk-history li::before { content: ""; position: absolute; left: 8px; top: 0; bottom: 0; border-left: 1px solid var(--mk-rule-2); }
.mk-history li:last-child { border-bottom: 0; }
.mk-history .mk-cur { color: var(--mk-ink); background: var(--mk-signal-wash); }
.mk-history .mk-cur::after { content: ""; position: absolute; left: 4px; top: 8px; border: 4px solid transparent; border-left: 6px solid var(--mk-signal); }
.mk-history .mk-rej { opacity: .5; text-decoration: line-through; }

/* toasts and banners */
.mk-toasts { position: fixed; left: 50%; bottom: 24px; transform: translateX(-50%); z-index: 2147483001; display: flex; flex-direction: column; gap: 8px; align-items: center; }
.mk-toast { background: var(--mk-ink); color: var(--mk-paper); padding: 8px 14px; border-radius: 0; font: 600 12px var(--mk-mono); letter-spacing: .04em; border-left: 4px solid var(--mk-signal); }
.mk-toast.mk-t-bad { border-left-color: var(--mk-bad); } .mk-toast.mk-t-admin { border-left-color: var(--mk-blue); }
.mk-stale { position: fixed; top: 0; left: 0; right: 0; z-index: 2147482002; display: flex; gap: 12px; align-items: center; justify-content: center; flex-wrap: wrap;
  padding: 8px 16px; background: var(--mk-paper-3); border-top: 4px solid var(--mk-signal); border-bottom: 1px solid var(--mk-rule-2); color: var(--mk-ink); font-size: 13px; }

/* element picker */
.mk-pick-layer { position: fixed; inset: 0; z-index: 2147482500; cursor: crosshair; }
.mk-pick-box { position: fixed; z-index: 2147482501; pointer-events: none; border: 1.5px solid var(--mk-ink); outline: 1px dashed var(--mk-signal); outline-offset: 4px; background: var(--mk-signal-wash); border-radius: 0; transition: all 60ms ease-out; }
.mk-pick-label { position: absolute; top: -22px; left: -1.5px; background: var(--mk-ink); color: var(--mk-paper); font: 600 10.5px var(--mk-mono); letter-spacing: .1em; text-transform: uppercase; padding: 3px 8px; border-radius: 0; white-space: nowrap; }
.mk-pick-hint { position: fixed; top: 12px; left: 50%; transform: translateX(-50%); z-index: 2147482502; background: var(--mk-ink); color: var(--mk-paper); padding: 6px 12px; border-radius: 0; font: 600 11.5px var(--mk-mono); letter-spacing: .06em; text-transform: uppercase; pointer-events: none; border-left: 4px solid var(--mk-signal); }
`

let installed = false

export function useMorphkitUiStyles(): void {
  useInsertionEffect(() => {
    if (installed || typeof document === 'undefined') return
    installed = true
    const el = document.createElement('style')
    el.setAttribute('data-morphkit-ui', '')
    el.textContent = CSS
    document.head.appendChild(el)
  }, [])
}
