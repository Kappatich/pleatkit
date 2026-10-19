import { useInsertionEffect } from 'react'

// Self-contained styles: the host app may not use Tailwind, so the UI ships plain CSS with an `mk-` prefix.
// Visual language v3 (docs/DESIGN.md): Swiss grid poster + SBB timetable. One neutral face from the system,
// one red, hairlines instead of cards, zero radius. The drawer never loads web fonts into someone else's app.
// Motion is short and explanatory only (docs/brainstorm/14-usability.md, DESIGN §4); reduced motion turns it off.
const CSS = `
.mk-root, .mk-root * { box-sizing: border-box; }
.mk-root {
  --mk-paper: #ffffff; --mk-paper-2: #f4f4f2; --mk-ink: #111111; --mk-ink-2: #4a4a4a; --mk-ink-3: #8a8a8a;
  --mk-rule: #d9d9d9; --mk-rule-2: #bdbdbd; --mk-red: #e30613; --mk-red-ink: #b8000f; --mk-red-wash: #fdeaec;
  --mk-ok: #1a7f37; --mk-bad: #b8000f;
  --mk-sans: "Helvetica Neue", Helvetica, Arial, system-ui, sans-serif;
  --mk-mono: ui-monospace, "SFMono-Regular", Menlo, Consolas, monospace;
  --mk-ease: cubic-bezier(.2, .7, .2, 1);
  font: 14px/1.45 var(--mk-sans); color: var(--mk-ink);
}
[data-mk-theme="dark"] .mk-root, .mk-root[data-mk-theme="dark"] {
  --mk-paper: #161616; --mk-paper-2: #1f1f1f; --mk-ink: #f2f2f2; --mk-ink-2: #c4c4c4; --mk-ink-3: #8a8a8a;
  --mk-rule: #333333; --mk-rule-2: #4a4a4a; --mk-red: #ff3b30; --mk-red-ink: #ff5b52; --mk-red-wash: #3a1513;
  --mk-ok: #5bd37d; --mk-bad: #ff8a80;
}
@media (prefers-reduced-motion: reduce) { .mk-root *, .mk-root *::before, .mk-root *::after { animation: none !important; transition: none !important; } }
.mk-root button { font-family: inherit; }
.mk-root svg { width: 18px; height: 18px; stroke: currentColor; fill: none; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; display: block; }

/* launcher */
.mk-launch { position: fixed; right: 20px; bottom: 20px; z-index: 2147482000; display: inline-flex; align-items: center; gap: 10px;
  padding: 10px 14px; border-radius: 0; border: 1px solid var(--mk-ink); background: var(--mk-paper); color: var(--mk-ink);
  font: 500 13px/1 var(--mk-sans); cursor: pointer; transition: background .12s, color .12s; animation: mk-rise .22s var(--mk-ease); }
.mk-launch:hover { background: var(--mk-ink); color: var(--mk-paper); }
.mk-dot { width: 10px; height: 10px; background: var(--mk-red); }
@keyframes mk-rise { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }

/* drawer */
.mk-drawer { position: fixed; top: 0; right: 0; bottom: 0; width: 420px; max-width: 100vw; z-index: 2147482001; display: flex; flex-direction: column;
  background: var(--mk-paper); color: var(--mk-ink); border-left: 1px solid var(--mk-ink); animation: mk-slide .22s var(--mk-ease); }
@keyframes mk-slide { from { transform: translateX(24px); opacity: 0; } to { transform: none; opacity: 1; } }
.mk-drawer.mk-dragging { outline: 2px dashed var(--mk-red); outline-offset: -8px; }
.mk-dropzone { position: absolute; inset: 0; z-index: 2; display: grid; place-items: center; background: var(--mk-red-wash); color: var(--mk-red-ink); font: 600 13px var(--mk-sans); pointer-events: none; }

.mk-head { display: grid; grid-template-columns: 1fr auto auto auto; grid-template-rows: auto auto; column-gap: 4px; padding: 14px 12px 12px 16px; border-bottom: 1px solid var(--mk-ink); align-items: start; }
.mk-title { grid-column: 1; grid-row: 1; font: 700 20px/1.1 var(--mk-sans); letter-spacing: -.02em; }
.mk-ver { grid-column: 1; grid-row: 2; margin-top: 6px; }
.mk-ver button { font: 500 12.5px var(--mk-sans); color: var(--mk-ink-2); background: transparent; border: 0; padding: 0; cursor: pointer; display: inline-flex; gap: 6px; align-items: center; }
.mk-ver button:hover { color: var(--mk-ink); }
.mk-ver button .mk-n { font: 700 12.5px var(--mk-mono); color: var(--mk-red-ink); }
.mk-ver button[disabled] { cursor: default; color: var(--mk-ink-2); }
.mk-ver .mk-caret { transition: transform .16s var(--mk-ease); display: inline-block; }
.mk-ver button[aria-expanded="true"] .mk-caret { transform: rotate(180deg); }
.mk-ico { grid-row: 1; width: 32px; height: 32px; border: 1px solid transparent; background: transparent; color: var(--mk-ink); cursor: pointer; display: grid; place-items: center; padding: 0; position: relative; border-radius: 0; transition: border-color .12s; }
.mk-ico:hover, .mk-ico:focus-visible { border-color: var(--mk-ink); outline: none; }
.mk-ico[disabled] { color: var(--mk-ink-3); cursor: default; border-color: transparent; }
.mk-ico[data-tip]::after { content: attr(data-tip); position: absolute; top: 100%; right: 0; margin-top: 6px; white-space: nowrap; background: var(--mk-ink); color: var(--mk-paper); font: 500 11.5px var(--mk-sans); padding: 4px 8px; opacity: 0; pointer-events: none; transition: opacity .15s .3s; z-index: 3; }
.mk-ico:hover[data-tip]::after, .mk-ico:focus-visible[data-tip]::after { opacity: 1; }
.mk-ico.mk-redo { grid-column: 2; animation: mk-rise .16s var(--mk-ease); }
.mk-ico.mk-undo { grid-column: 3; }
.mk-ico.mk-close { grid-column: 4; }

/* version history as a timetable */
.mk-history { margin: 0; padding: 0 16px 10px; list-style: none; border-bottom: 1px solid var(--mk-rule); display: grid; }
.mk-history li { display: grid; grid-template-columns: 36px 1fr auto auto; gap: 10px; align-items: baseline; padding: 7px 0; border-bottom: 1px solid var(--mk-rule); font: 500 13px var(--mk-sans); color: var(--mk-ink-2); font-variant-numeric: tabular-nums; animation: mk-fade .18s var(--mk-ease) both; }
.mk-history li:nth-child(2) { animation-delay: .03s; } .mk-history li:nth-child(3) { animation-delay: .06s; } .mk-history li:nth-child(4) { animation-delay: .09s; } .mk-history li:nth-child(n+5) { animation-delay: .12s; }
.mk-history li:first-child { border-top: 1px solid var(--mk-ink); padding-top: 9px; }
.mk-history .mk-v { font: 700 12px var(--mk-mono); color: var(--mk-ink); }
.mk-history .mk-t { font: 500 11.5px var(--mk-mono); color: var(--mk-ink-3); }
.mk-history .mk-id { font: 500 10.5px var(--mk-mono); color: var(--mk-ink-3); margin-left: 8px; letter-spacing: .02em; }
.mk-history li.mk-cur { color: var(--mk-ink); border-bottom: 2px solid var(--mk-red); }
.mk-history li.mk-cur .mk-t { color: var(--mk-red-ink); font-weight: 700; letter-spacing: .08em; text-transform: uppercase; }
.mk-history li.mk-rej { opacity: .5; text-decoration: line-through; }
.mk-history .mk-go { font: 500 12px var(--mk-sans); border: 0; background: transparent; color: var(--mk-ink-3); cursor: pointer; padding: 0; text-decoration: underline; text-underline-offset: 3px; }
.mk-history .mk-go:hover { color: var(--mk-ink); }
@keyframes mk-fade { from { opacity: 0; transform: translateY(-3px); } to { opacity: 1; transform: none; } }

/* feed */
.mk-body { flex: 1; overflow-y: auto; padding: 16px; display: flex; flex-direction: column; gap: 14px; }
.mk-empty { color: var(--mk-ink-2); font-size: 13.5px; max-width: 38ch; display: grid; gap: 10px; }
.mk-empty p { margin: 0; }
.mk-chips { display: flex; flex-wrap: wrap; gap: 6px; }
.mk-chip { font: 500 12.5px var(--mk-sans); border: 1px solid var(--mk-rule-2); background: transparent; color: var(--mk-ink); padding: 6px 10px; cursor: pointer; border-radius: 0; text-align: left; transition: border-color .12s; }
.mk-chip:hover, .mk-chip:focus-visible { border-color: var(--mk-ink); outline: none; }
.mk-turn { display: grid; gap: 8px; animation: mk-fade .18s var(--mk-ease); }
.mk-req { justify-self: end; max-width: 92%; background: var(--mk-ink); color: var(--mk-paper); padding: 8px 12px; font-size: 13.5px; white-space: pre-wrap; }
.mk-req .mk-pchip { display: inline-block; font: 600 10.5px/1 var(--mk-mono); letter-spacing: .06em; text-transform: uppercase; border: 1px solid var(--mk-paper); padding: 3px 6px; margin-right: 6px; vertical-align: 1px; }
.mk-req-thumbs { display: flex; gap: 4px; margin-top: 6px; }
.mk-req-thumbs img { height: 40px; max-width: 72px; object-fit: cover; border: 1px solid rgba(255,255,255,.4); }

/* live progress: one line that swaps its text */
.mk-live { display: grid; grid-template-columns: 8px 1fr auto; gap: 8px; align-items: baseline; font-size: 13.5px; color: var(--mk-ink-2); }
.mk-live .mk-pulse { width: 8px; height: 8px; background: var(--mk-red); align-self: center; animation: mk-pulse 1s steps(2) infinite; }
@keyframes mk-pulse { 50% { opacity: .2; } }
.mk-live .mk-step { animation: mk-swap .18s var(--mk-ease); }
@keyframes mk-swap { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: none; } }
.mk-live .mk-time { font: 500 12px var(--mk-mono); color: var(--mk-ink-3); font-variant-numeric: tabular-nums; }

/* result */
.mk-res { display: grid; grid-template-columns: 18px 1fr; gap: 8px; font-size: 14px; }
.mk-mark { font: 700 16px/1.2 var(--mk-sans); color: var(--mk-ok); animation: mk-pop .18s var(--mk-ease); transform-origin: center; }
.mk-mark.mk-warn { color: var(--mk-bad); } .mk-mark.mk-info { color: var(--mk-ink-3); }
@keyframes mk-pop { from { opacity: 0; transform: scale(.6); } to { opacity: 1; transform: none; } }
.mk-note { margin: 6px 0 0; font: 13px/1.45 var(--mk-sans); color: var(--mk-ink-2); border-left: 2px solid var(--mk-red); padding-left: 10px; }
.mk-note span { font: 500 11px var(--mk-mono); letter-spacing: .06em; text-transform: uppercase; color: var(--mk-ink-3); display: block; margin-bottom: 2px; }
.mk-summary { margin: 0; animation: mk-fade .2s var(--mk-ease); }
.mk-summary.mk-undone { color: var(--mk-ink-3); text-decoration: line-through; }
.mk-steps { margin-top: 4px; }
.mk-steps summary { cursor: pointer; font: 500 12px var(--mk-sans); color: var(--mk-ink-3); list-style: none; }
.mk-steps summary::-webkit-details-marker { display: none; }
.mk-steps summary::after { content: " ›"; }
.mk-steps[open] summary::after { content: " ⌄"; }
.mk-steps ul { margin: 6px 0 0; padding: 0; list-style: none; font: 12.5px var(--mk-mono); color: var(--mk-ink-2); display: grid; gap: 3px; animation: mk-fade .16s var(--mk-ease); }
.mk-steps li::before { content: "· "; color: var(--mk-ink-3); }
.mk-steps li.mk-good::before { content: "✓ "; color: var(--mk-ok); }
.mk-steps li.mk-bad::before { content: "× "; color: var(--mk-bad); }
.mk-count { margin-left: 4px; color: var(--mk-ink-3); }
.mk-meta { font: 500 12px var(--mk-sans); color: var(--mk-ink-3); margin-top: 6px; }
.mk-opts { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
.mk-opts button, .mk-retry { font: 500 13px var(--mk-sans); border: 1px solid var(--mk-ink); background: transparent; color: var(--mk-ink); padding: 7px 12px; cursor: pointer; border-radius: 0; transition: background .12s, color .12s; }
.mk-opts button:hover, .mk-retry:hover { background: var(--mk-ink); color: var(--mk-paper); }
.mk-opts button[disabled] { opacity: .4; cursor: default; }
.mk-retry { margin-top: 8px; width: max-content; }

/* composer */
.mk-foot { border-top: 1px solid var(--mk-ink); padding: 12px 16px 14px; display: grid; gap: 8px; background: var(--mk-paper); }
.mk-thumbs { display: flex; gap: 6px; flex-wrap: wrap; }
.mk-thumb { position: relative; display: inline-block; }
.mk-thumb img { height: 56px; max-width: 96px; object-fit: cover; border: 1px solid var(--mk-rule-2); display: block; }
.mk-thumb button { position: absolute; top: -6px; right: -6px; width: 18px; height: 18px; border: 1px solid var(--mk-ink); background: var(--mk-paper); color: var(--mk-ink); font: 11px/16px var(--mk-mono); padding: 0; cursor: pointer; border-radius: 0; }
.mk-box { border: 1px solid var(--mk-ink); display: grid; grid-template-columns: 1fr auto; grid-template-rows: auto auto; background: var(--mk-paper); }
.mk-box:focus-within { outline: 2px solid var(--mk-ink); outline-offset: -1px; }
.mk-input { grid-column: 1 / -1; width: 100%; min-height: 44px; max-height: 160px; resize: none; border: 0; background: transparent; color: var(--mk-ink); padding: 11px 12px 6px; font: 14px/1.45 var(--mk-sans); }
.mk-input::placeholder { color: var(--mk-ink-3); }
.mk-input:focus { outline: none; }
.mk-input[disabled] { color: var(--mk-ink-3); }
.mk-tools { grid-column: 1; display: flex; gap: 4px; align-items: center; padding: 0 6px 6px; flex-wrap: wrap; }
.mk-tool { font: 500 12.5px var(--mk-sans); border: 1px solid transparent; background: transparent; color: var(--mk-ink-2); padding: 6px 8px; cursor: pointer; display: inline-flex; gap: 6px; align-items: center; border-radius: 0; transition: border-color .12s, color .12s; }
.mk-tool svg { width: 16px; height: 16px; }
.mk-tool:hover, .mk-tool:focus-visible { border-color: var(--mk-rule-2); color: var(--mk-ink); outline: none; }
.mk-tool.mk-sel { border-color: var(--mk-ink); color: var(--mk-ink); }
.mk-tool[disabled] { opacity: .4; cursor: default; }
.mk-send { grid-column: 2; align-self: end; margin: 0 6px 6px 0; width: 32px; height: 32px; border: 0; background: var(--mk-rule); color: var(--mk-ink-3); cursor: default; display: grid; place-items: center; padding: 0; border-radius: 0; transition: background .12s, color .12s, transform .08s; }
.mk-send svg { width: 16px; height: 16px; stroke-width: 2.2; }
.mk-send.mk-active { background: var(--mk-red); color: #fff; cursor: pointer; }
.mk-send.mk-active:hover { background: var(--mk-red-ink); }
.mk-send.mk-active:active { transform: scale(.94); }
.mk-send.mk-stop { background: var(--mk-ink); color: var(--mk-paper); cursor: pointer; }
.mk-send.mk-stop svg { fill: currentColor; stroke: none; }
.mk-paused { font-size: 13px; color: var(--mk-ink-2); padding: 10px 12px; border: 1px dashed var(--mk-rule-2); }
.mk-kbd { font: 500 11px var(--mk-mono); color: var(--mk-ink-3); display: flex; justify-content: space-between; gap: 12px; }

/* toasts and banners */
.mk-toasts { position: fixed; left: 50%; bottom: 24px; transform: translateX(-50%); z-index: 2147483001; display: flex; flex-direction: column; gap: 8px; align-items: center; }
.mk-toast { background: var(--mk-ink); color: var(--mk-paper); padding: 8px 14px; font: 500 13px var(--mk-sans); border-left: 3px solid var(--mk-red); display: inline-flex; gap: 12px; align-items: center; animation: mk-rise .18s var(--mk-ease); }
.mk-toast button { border: 0; background: transparent; color: var(--mk-paper); font: 600 13px var(--mk-sans); cursor: pointer; text-decoration: underline; text-underline-offset: 3px; padding: 0; }
.mk-toast.mk-t-bad { border-left-color: var(--mk-bad); } .mk-toast.mk-t-admin { border-left-color: var(--mk-ink-3); }
.mk-stale { position: fixed; top: 0; left: 0; right: 0; z-index: 2147482002; display: flex; gap: 12px; align-items: center; justify-content: center; flex-wrap: wrap;
  padding: 8px 16px; background: var(--mk-paper); border-top: 3px solid var(--mk-red); border-bottom: 1px solid var(--mk-rule-2); color: var(--mk-ink); font-size: 13px; }
.mk-btn { border: 1px solid var(--mk-ink); background: transparent; color: var(--mk-ink); padding: 6px 10px; font: 500 12.5px var(--mk-sans); cursor: pointer; border-radius: 0; transition: background .12s, color .12s; }
.mk-btn:hover:not(:disabled) { background: var(--mk-ink); color: var(--mk-paper); }
.mk-btn:disabled { opacity: .4; cursor: default; }

/* element picker */
.mk-pick-layer { position: fixed; inset: 0; z-index: 2147482500; cursor: crosshair; }
.mk-pick-box { position: fixed; z-index: 2147482501; pointer-events: none; border: 1.5px solid var(--mk-red); background: var(--mk-red-wash); transition: all 60ms ease-out; }
.mk-pick-label { position: absolute; top: -22px; left: -1.5px; background: var(--mk-red); color: #fff; font: 600 10.5px var(--mk-mono); letter-spacing: .08em; text-transform: uppercase; padding: 3px 8px; white-space: nowrap; }
.mk-pick-hint { position: fixed; top: 12px; left: 50%; transform: translateX(-50%); z-index: 2147482502; background: var(--mk-ink); color: var(--mk-paper); padding: 6px 12px; font: 500 12.5px var(--mk-sans); pointer-events: none; border-left: 3px solid var(--mk-red); }

@media (max-width: 640px) {
  /* phones: a bottom sheet instead of a side drawer; the page stays reachable above it */
  .mk-drawer { top: auto; left: 0; right: 0; bottom: 0; width: 100vw; max-width: none; height: min(88dvh, 100%); border-left: 0; border-top: 1px solid var(--mk-ink);
    animation: mk-sheet .26s var(--mk-ease); box-shadow: 0 -1px 0 var(--mk-rule); }
  .mk-drawer::before { content: ""; position: absolute; top: 6px; left: 50%; width: 36px; height: 3px; margin-left: -18px; background: var(--mk-rule-2); }
  .mk-head { padding: 16px 8px 10px 16px; }
  .mk-title { font-size: 18px; }
  .mk-ico { width: 44px; height: 44px; }
  .mk-send { width: 40px; height: 40px; }
  .mk-input { font-size: 16px; }
  .mk-kbd { display: none; }
  .mk-chips { flex-wrap: nowrap; overflow-x: auto; -webkit-overflow-scrolling: touch; padding-bottom: 4px; scrollbar-width: none; }
  .mk-chips::-webkit-scrollbar { display: none; }
  .mk-chips > * { flex: none; }
  .mk-foot { padding-bottom: max(14px, env(safe-area-inset-bottom, 0px)); }
  .mk-pick-hint { top: auto; bottom: calc(min(88dvh, 100%) + 8px); }
}
@keyframes mk-sheet { from { transform: translateY(24px); opacity: 0; } to { transform: none; opacity: 1; } }
`

let installed = false

export function usePleatkitUiStyles(): void {
  useInsertionEffect(() => {
    if (installed || typeof document === 'undefined') return
    installed = true
    const el = document.createElement('style')
    el.setAttribute('data-pleatkit-ui', '')
    el.textContent = CSS
    document.head.appendChild(el)
  }, [])
}

/** The same CSS, for a shadow root (PleatkitUiRoot) where document-level styles do not reach. */
export const PLEATKIT_UI_CSS = CSS
