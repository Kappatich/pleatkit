import { useInsertionEffect } from 'react'

// Self-contained styles: the host app may not use Tailwind, so the UI ships plain CSS with an `mk-` prefix.
// Visual language v4 "warm" (docs/DESIGN.md §7, DECISIONS 91): the v3 grid and timetable stay; ink and paper get a
// warm cast, no pure black or white, small radii, soft shadows, pills for chips. Everything is drawn from the
// `--mk-*` tokens below; `data-mk-theme="dark"` swaps them. The drawer takes the host app's font (no font-family
// on .mk-root, longhands below) and never loads web fonts into someone else's app; mono is a stack only.
// Motion is short and explanatory only (the usability review, DESIGN §4); reduced motion turns it off.
const CSS = `
.mk-root, .mk-root * { box-sizing: border-box; }
.mk-root {
  --mk-paper: #fbfaf7; --mk-paper-2: #f3f1ec; --mk-canvas: #ebe8e1; --mk-ink: #1c1a17; --mk-ink-2: #514c45; --mk-ink-3: #6f6a62;
  --mk-rule: #ddd8cf; --mk-rule-2: #c3bdb2; --mk-red: #e2361f; --mk-red-ink: #b7260f; --mk-red-wash: #fbe9e4;
  --mk-ok: #1f7a3c; --mk-ok-wash: #e6f3e9; --mk-bad: #b7260f;
  --mk-on-red: #fbfaf7; --mk-user-from: #2a2622;
  --mk-shadow: 0 1px 2px rgba(28, 26, 23, .05);
  --mk-shadow-lift: 0 1px 2px rgba(28, 26, 23, .06), 0 10px 24px -18px rgba(28, 26, 23, .4);
  --mk-shadow-edge: -18px 0 40px -30px rgba(28, 26, 23, .45);
  --mk-sans: "Inter", "Helvetica Neue", Arial, sans-serif;
  --mk-mono: "JetBrains Mono", ui-monospace, Menlo, Consolas, monospace;
  --mk-ease: cubic-bezier(.2, .7, .2, 1);
  font-size: 14px; line-height: 1.45; color: var(--mk-ink);
}
[data-mk-theme="dark"] .mk-root, .mk-root[data-mk-theme="dark"] {
  --mk-paper: #171512; --mk-paper-2: #1f1c18; --mk-canvas: #110f0d; --mk-ink: #f1ece4; --mk-ink-2: #c7c0b5; --mk-ink-3: #9d968a;
  --mk-rule: #36322c; --mk-rule-2: #4c463e; --mk-red: #ff5a3c; --mk-red-ink: #ff7a60; --mk-red-wash: #3a1c15;
  --mk-ok: #6fd48c; --mk-ok-wash: #183222; --mk-bad: #ff7a60;
  --mk-on-red: #fbfaf7; --mk-user-from: #ffe9e2;
  --mk-shadow: 0 1px 2px rgba(8, 7, 6, .4);
  --mk-shadow-lift: 0 1px 2px rgba(8, 7, 6, .4), 0 10px 24px -18px rgba(8, 7, 6, .8);
  --mk-shadow-edge: -18px 0 40px -30px rgba(8, 7, 6, .9);
}
@media (prefers-reduced-motion: reduce) { .mk-root *, .mk-root *::before, .mk-root *::after { animation: none !important; transition: none !important; } }
.mk-root button, .mk-root textarea, .mk-root input { font-family: inherit; }
.mk-root svg { width: 18px; height: 18px; stroke: currentColor; fill: none; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; display: block; }

/* launcher: a pill with the red mark */
.mk-launch { position: fixed; right: 20px; bottom: 20px; z-index: 2147482000; display: inline-flex; align-items: center; gap: 10px;
  padding: 10px 16px 10px 14px; border-radius: 999px; border: 1px solid var(--mk-rule-2); background: var(--mk-paper); color: var(--mk-ink);
  font-weight: 500; font-size: 13px; line-height: 1; cursor: pointer; box-shadow: var(--mk-shadow-lift);
  transition: background .12s, border-color .12s, transform .12s; animation: mk-rise .22s var(--mk-ease); }
.mk-launch:hover { background: var(--mk-paper-2); border-color: var(--mk-ink-3); transform: translateY(-1px); }
.mk-dot { width: 10px; height: 10px; background: var(--mk-red); border-radius: 2px; }
@keyframes mk-rise { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }

/* drawer */
.mk-drawer { position: fixed; top: 0; right: 0; bottom: 0; width: 420px; max-width: 100vw; z-index: 2147482001; display: flex; flex-direction: column;
  background: linear-gradient(180deg, var(--mk-paper) 0%, var(--mk-paper-2) 100%); color: var(--mk-ink); border-left: 1px solid var(--mk-rule-2);
  box-shadow: var(--mk-shadow-edge); animation: mk-slide .22s var(--mk-ease); }
@keyframes mk-slide { from { transform: translateX(24px); opacity: 0; } to { transform: none; opacity: 1; } }
.mk-drawer.mk-dragging { outline: 2px dashed var(--mk-red); outline-offset: -8px; }
.mk-dropzone { position: absolute; inset: 0; z-index: 2; display: grid; place-items: center; background: var(--mk-red-wash); color: var(--mk-red-ink); font-weight: 600; font-size: 13px; pointer-events: none; }

.mk-head { display: grid; grid-template-columns: 1fr auto auto auto; grid-template-rows: auto auto; column-gap: 4px; padding: 14px 12px 12px 16px; border-bottom: 1px solid var(--mk-rule); align-items: start; }
.mk-title { grid-column: 1; grid-row: 1; display: flex; align-items: center; gap: 8px; font-weight: 700; font-size: 20px; line-height: 1.1; letter-spacing: -.02em; }
.mk-title::before { content: ""; flex: none; width: 10px; height: 10px; background: var(--mk-red); border-radius: 2px; }
.mk-ver { grid-column: 1; grid-row: 2; margin-top: 8px; }
.mk-ver button { font-weight: 500; font-size: 12.5px; line-height: 1.3; color: var(--mk-ink-2); background: var(--mk-paper-2); border: 1px solid var(--mk-rule); border-radius: 999px; padding: 4px 10px; cursor: pointer; display: inline-flex; gap: 6px; align-items: center; transition: background .12s, border-color .12s, color .12s; }
.mk-ver button:hover { color: var(--mk-ink); border-color: var(--mk-rule-2); }
.mk-ver button:has(.mk-n) { background: var(--mk-red-wash); border-color: transparent; color: var(--mk-red-ink); }
.mk-ver button:has(.mk-n):hover { border-color: var(--mk-red); }
.mk-ver button .mk-n { width: 7px; height: 7px; background: var(--mk-red); border-radius: 50%; display: inline-block; }
.mk-ver button[disabled] { cursor: default; color: var(--mk-ink-2); }
.mk-ver .mk-caret { transition: transform .16s var(--mk-ease); display: inline-block; }
.mk-ver button[aria-expanded="true"] .mk-caret { transform: rotate(180deg); }
.mk-ico { grid-row: 1; width: 32px; height: 32px; border: 1px solid transparent; background: transparent; color: var(--mk-ink-2); cursor: pointer; display: grid; place-items: center; padding: 0; position: relative; border-radius: 6px; transition: background .12s, border-color .12s, color .12s; }
.mk-ico:hover, .mk-ico:focus-visible { background: var(--mk-paper-2); border-color: var(--mk-rule-2); color: var(--mk-ink); outline: none; }
.mk-ico[disabled] { color: var(--mk-ink-3); cursor: default; border-color: transparent; background: transparent; opacity: .6; }
.mk-ico[data-tip]::after { content: attr(data-tip); position: absolute; top: 100%; right: 0; margin-top: 6px; white-space: nowrap; background: var(--mk-ink); color: var(--mk-paper); font-weight: 500; font-size: 11.5px; line-height: 1.3; padding: 4px 8px; border-radius: 4px; box-shadow: var(--mk-shadow-lift); opacity: 0; pointer-events: none; transition: opacity .15s .3s; z-index: 3; }
.mk-ico:hover[data-tip]::after, .mk-ico:focus-visible[data-tip]::after { opacity: 1; }
.mk-ico.mk-redo { grid-column: 2; animation: mk-rise .16s var(--mk-ease); }
.mk-ico.mk-undo { grid-column: 3; }
.mk-ico.mk-close { grid-column: 4; }

/* version history as a timetable */
.mk-history { margin: 0; padding: 0 16px 10px; list-style: none; border-bottom: 1px solid var(--mk-rule); display: grid; }
.mk-history li { display: grid; grid-template-columns: 36px 1fr auto auto; gap: 10px; align-items: baseline; padding: 7px 0; border-bottom: 1px solid var(--mk-rule); font-weight: 500; font-size: 13px; color: var(--mk-ink-2); font-variant-numeric: tabular-nums; animation: mk-fade .18s var(--mk-ease) both; }
.mk-history li:nth-child(2) { animation-delay: .03s; } .mk-history li:nth-child(3) { animation-delay: .06s; } .mk-history li:nth-child(4) { animation-delay: .09s; } .mk-history li:nth-child(n+5) { animation-delay: .12s; }
.mk-history li:first-child { padding-top: 9px; }
.mk-history .mk-v { font: 700 12px var(--mk-mono); color: var(--mk-ink); }
.mk-history .mk-t { font: 500 11.5px var(--mk-mono); color: var(--mk-ink-3); }
.mk-history .mk-id { font: 500 10.5px var(--mk-mono); color: var(--mk-ink-3); margin-left: 8px; letter-spacing: .02em; }
.mk-history li.mk-cur { color: var(--mk-ink); border-bottom: 2px solid var(--mk-red); }
.mk-history li.mk-cur .mk-t { color: var(--mk-red-ink); font-weight: 700; letter-spacing: .08em; text-transform: uppercase; }
.mk-history li.mk-rej { opacity: .5; text-decoration: line-through; }
.mk-history .mk-go { font-weight: 500; font-size: 12px; border: 0; background: transparent; color: var(--mk-ink-3); cursor: pointer; padding: 0; text-decoration: underline; text-underline-offset: 3px; text-decoration-color: var(--mk-rule-2); }
.mk-history .mk-go:hover { color: var(--mk-red-ink); text-decoration-color: currentColor; }
@keyframes mk-fade { from { opacity: 0; transform: translateY(-3px); } to { opacity: 1; transform: none; } }

/* feed */
.mk-body { flex: 1; overflow-y: auto; padding: 16px; display: flex; flex-direction: column; gap: 14px; }
.mk-empty { color: var(--mk-ink-2); font-size: 13.5px; max-width: 38ch; display: grid; gap: 12px; }
.mk-empty p { margin: 0; }
.mk-chips { display: flex; flex-wrap: wrap; gap: 6px; }
.mk-chip { font-weight: 500; font-size: 12.5px; line-height: 1.35; border: 1px solid var(--mk-rule); background: var(--mk-paper); color: var(--mk-ink-2); padding: 6px 12px; cursor: pointer; border-radius: 999px; text-align: left; transition: background .15s, border-color .15s, color .15s; }
.mk-chip:hover, .mk-chip:focus-visible { background: var(--mk-red-wash); border-color: var(--mk-red); color: var(--mk-red-ink); outline: none; }
.mk-turn { display: grid; gap: 8px; animation: mk-fade .18s var(--mk-ease); }
.mk-req { justify-self: end; max-width: 92%; background: linear-gradient(180deg, var(--mk-user-from) 0%, var(--mk-ink) 100%); color: var(--mk-paper); padding: 8px 12px; font-size: 13.5px; white-space: pre-wrap;
  border-radius: 12px 12px 3px 12px; box-shadow: 0 2px 6px -2px rgba(28, 26, 23, .35); }
.mk-req .mk-pchip { display: inline-block; font: 600 10.5px/1 var(--mk-mono); letter-spacing: .06em; text-transform: uppercase; border: 1px solid currentColor; border-radius: 999px; padding: 3px 7px; margin-right: 6px; vertical-align: 1px; opacity: .85; }
.mk-req-thumbs { display: flex; gap: 4px; margin-top: 6px; }
.mk-req-thumbs img { height: 40px; max-width: 72px; object-fit: cover; border: 1px solid var(--mk-rule-2); border-radius: 6px; }

/* live progress: one line that swaps its text, a pill with a pulsing red dot */
.mk-live { display: inline-grid; justify-self: start; max-width: 100%; grid-template-columns: 8px minmax(0, 1fr) auto; gap: 8px; align-items: center; font-size: 13.5px; color: var(--mk-ink-2);
  background: var(--mk-paper); border: 1px solid var(--mk-rule); border-radius: 999px; padding: 5px 12px 5px 10px; box-shadow: var(--mk-shadow); }
.mk-live .mk-pulse { width: 8px; height: 8px; background: var(--mk-red); border-radius: 50%; align-self: center; animation: mk-pulse 1.2s ease-in-out infinite; }
@keyframes mk-pulse { 0%, 100% { opacity: 1; transform: scale(1); } 50% { opacity: .35; transform: scale(.7); } }
.mk-live .mk-step { animation: mk-swap .18s var(--mk-ease); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
@keyframes mk-swap { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: none; } }
.mk-live .mk-time { font: 500 12px var(--mk-mono); color: var(--mk-ink-3); font-variant-numeric: tabular-nums; }

/* result: a card with a round check mark */
.mk-res { display: grid; grid-template-columns: 18px minmax(0, 1fr); gap: 10px; font-size: 14px; background: var(--mk-paper); border: 1px solid var(--mk-rule); border-radius: 12px 12px 12px 3px; padding: 10px 12px; box-shadow: var(--mk-shadow); }
.mk-mark { width: 18px; height: 18px; margin-top: 1px; border-radius: 50%; background: var(--mk-ok-wash); color: var(--mk-ok); display: grid; place-items: center; font-weight: 700; font-size: 11px; line-height: 1; animation: mk-pop .18s var(--mk-ease); transform-origin: center; }
.mk-mark.mk-warn { color: var(--mk-bad); background: var(--mk-red-wash); } .mk-mark.mk-info { color: var(--mk-ink-2); background: var(--mk-paper-2); }
@keyframes mk-pop { from { opacity: 0; transform: scale(.6); } to { opacity: 1; transform: none; } }
.mk-note { margin: 6px 0 0; font-size: 13px; line-height: 1.45; color: var(--mk-ink-2); border-left: 2px solid var(--mk-red); padding-left: 10px; }
.mk-note q { quotes: 'C' 'D'; font-weight: 500; color: var(--mk-ink); display: block; }
.mk-note small { display: block; margin-top: 3px; font-size: 12.5px; color: var(--mk-ink-3); }
.mk-note span { font: 500 11px var(--mk-mono); letter-spacing: .06em; text-transform: uppercase; color: var(--mk-ink-3); display: block; margin-bottom: 2px; }
.mk-summary { margin: 0; animation: mk-fade .2s var(--mk-ease); }
.mk-summary.mk-undone { color: var(--mk-ink-3); text-decoration: line-through; }
.mk-steps { margin-top: 4px; }
.mk-steps summary { cursor: pointer; font-weight: 500; font-size: 12px; color: var(--mk-ink-3); list-style: none; }
.mk-steps summary:hover { color: var(--mk-ink-2); }
.mk-steps summary::-webkit-details-marker { display: none; }
.mk-steps summary::after { content: " ›"; }
.mk-steps[open] summary::after { content: " ⌄"; }
.mk-steps ul { margin: 6px 0 0; padding: 0; list-style: none; font: 12.5px var(--mk-mono); color: var(--mk-ink-2); display: grid; gap: 3px; animation: mk-fade .16s var(--mk-ease); }
.mk-steps li::before { content: "· "; color: var(--mk-ink-3); }
.mk-steps li.mk-good::before { content: "✓ "; color: var(--mk-ok); }
.mk-steps li.mk-bad::before { content: "× "; color: var(--mk-bad); }
.mk-count { margin-left: 4px; color: var(--mk-ink-3); }
.mk-meta { font-weight: 500; font-size: 12px; color: var(--mk-ink-3); margin-top: 6px; }
.mk-opts { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
/* secondary buttons: paper with a rule-2 border, 4px radius */
.mk-opts button, .mk-retry { font-weight: 500; font-size: 13px; line-height: 1.3; border: 1px solid var(--mk-rule-2); background: var(--mk-paper); color: var(--mk-ink); padding: 7px 12px; cursor: pointer; border-radius: 4px; box-shadow: var(--mk-shadow); transition: background .12s, border-color .12s, color .12s; }
.mk-opts button:hover, .mk-retry:hover { background: var(--mk-paper-2); border-color: var(--mk-ink-2); }
.mk-opts button[disabled] { opacity: .4; cursor: default; }
.mk-retry { margin-top: 8px; width: max-content; }

/* composer */
.mk-foot { border-top: 1px solid var(--mk-rule); padding: 12px 16px 14px; display: grid; gap: 8px; background: transparent; }
.mk-thumbs { display: flex; gap: 6px; flex-wrap: wrap; }
.mk-thumb { position: relative; display: inline-block; }
.mk-thumb img { height: 56px; max-width: 96px; object-fit: cover; border: 1px solid var(--mk-rule-2); border-radius: 6px; display: block; }
.mk-thumb button { position: absolute; top: -6px; right: -6px; width: 18px; height: 18px; border: 1px solid var(--mk-rule-2); background: var(--mk-paper); color: var(--mk-ink); font: 11px/16px var(--mk-mono); padding: 0; cursor: pointer; border-radius: 50%; box-shadow: var(--mk-shadow); }
.mk-box { border: 1px solid var(--mk-rule-2); border-radius: 12px; display: grid; grid-template-columns: 1fr auto; grid-template-rows: auto auto; background: var(--mk-paper); box-shadow: var(--mk-shadow-lift); transition: border-color .2s, box-shadow .2s; }
.mk-box:focus-within { border-color: var(--mk-red); box-shadow: 0 0 0 3px var(--mk-red-wash); outline: none; }
.mk-input { grid-column: 1 / -1; width: 100%; min-height: 44px; max-height: 160px; resize: none; border: 0; background: transparent; color: var(--mk-ink); padding: 11px 12px 6px; font-size: 14px; line-height: 1.45; border-radius: 12px 12px 0 0; }
.mk-input::placeholder { color: var(--mk-ink-3); }
.mk-input:focus { outline: none; }
.mk-input[disabled] { color: var(--mk-ink-3); }
.mk-tools { grid-column: 1; display: flex; gap: 4px; align-items: center; padding: 0 6px 6px; flex-wrap: wrap; }
.mk-tool { font-weight: 500; font-size: 12.5px; border: 1px solid transparent; background: transparent; color: var(--mk-ink-2); padding: 6px 8px; cursor: pointer; display: inline-flex; gap: 6px; align-items: center; border-radius: 4px; transition: background .12s, border-color .12s, color .12s; }
.mk-tool svg { width: 16px; height: 16px; }
.mk-tool:hover, .mk-tool:focus-visible { background: var(--mk-paper-2); border-color: var(--mk-rule); color: var(--mk-ink); outline: none; }
.mk-tool.mk-sel { border-radius: 999px; padding: 5px 10px; background: var(--mk-red-wash); border-color: transparent; color: var(--mk-red-ink); }
.mk-tool.mk-sel:hover, .mk-tool.mk-sel:focus-visible { border-color: var(--mk-red); background: var(--mk-red-wash); color: var(--mk-red-ink); }
.mk-tool[disabled] { opacity: .4; cursor: default; }
.mk-send { grid-column: 2; align-self: end; margin: 0 6px 6px 0; width: 32px; height: 32px; border: 0; background: var(--mk-paper-2); color: var(--mk-ink-3); cursor: default; display: grid; place-items: center; padding: 0; border-radius: 8px; transition: background .12s, color .12s, transform .08s; }
.mk-send svg { width: 16px; height: 16px; stroke-width: 2.2; }
/* primary: the red gradient */
.mk-send.mk-active { background: linear-gradient(180deg, var(--mk-red) 0%, var(--mk-red-ink) 100%); color: var(--mk-on-red); cursor: pointer; box-shadow: 0 1px 2px rgba(28, 26, 23, .18), inset 0 1px 0 rgba(255, 250, 245, .18); }
.mk-send.mk-active:hover { background: linear-gradient(180deg, var(--mk-red-ink) 0%, var(--mk-red-ink) 100%); }
.mk-send.mk-active:active { transform: scale(.94); }
.mk-send.mk-stop { background: var(--mk-ink); color: var(--mk-paper); cursor: pointer; }
.mk-send.mk-stop svg { fill: currentColor; stroke: none; }
.mk-paused { font-size: 13px; color: var(--mk-ink-2); padding: 10px 12px; border: 1px dashed var(--mk-rule-2); border-radius: 8px; background: var(--mk-paper); }
.mk-kbd { font: 500 11px var(--mk-mono); color: var(--mk-ink-3); display: flex; justify-content: space-between; gap: 12px; }

/* toasts and banners */
.mk-toasts { position: fixed; left: 50%; bottom: 24px; transform: translateX(-50%); z-index: 2147483001; display: flex; flex-direction: column; gap: 8px; align-items: center; }
.mk-toast { background: var(--mk-ink); color: var(--mk-paper); padding: 8px 14px; font-weight: 500; font-size: 13px; border-left: 3px solid var(--mk-red); border-radius: 8px; box-shadow: var(--mk-shadow-lift); display: inline-flex; gap: 12px; align-items: center; animation: mk-rise .18s var(--mk-ease); }
.mk-toast button { border: 0; background: transparent; color: var(--mk-paper); font-weight: 600; font-size: 13px; cursor: pointer; text-decoration: underline; text-underline-offset: 3px; padding: 0; }
.mk-toast.mk-t-bad { border-left-color: var(--mk-bad); } .mk-toast.mk-t-admin { border-left-color: var(--mk-ink-3); }
.mk-stale { position: fixed; top: 0; left: 0; right: 0; z-index: 2147482002; display: flex; gap: 12px; align-items: center; justify-content: center; flex-wrap: wrap;
  padding: 8px 16px; background: var(--mk-paper); border-top: 3px solid var(--mk-red); border-bottom: 1px solid var(--mk-rule-2); color: var(--mk-ink); font-size: 13px; box-shadow: var(--mk-shadow-lift); }
.mk-btn { border: 1px solid var(--mk-rule-2); background: var(--mk-paper); color: var(--mk-ink); padding: 6px 10px; font-weight: 500; font-size: 12.5px; cursor: pointer; border-radius: 4px; box-shadow: var(--mk-shadow); transition: background .12s, border-color .12s, color .12s; }
.mk-btn:hover:not(:disabled) { background: var(--mk-paper-2); border-color: var(--mk-ink-2); }
.mk-btn:disabled { opacity: .4; cursor: default; }

/* element picker */
.mk-pick-layer { position: fixed; inset: 0; z-index: 2147482500; cursor: crosshair; }
.mk-pick-box { position: fixed; z-index: 2147482501; pointer-events: none; border: 1.5px solid var(--mk-red); border-radius: 4px; background: color-mix(in srgb, var(--mk-red-wash) 70%, transparent); transition: all 60ms ease-out; }
.mk-pick-label { position: absolute; top: -22px; left: -1.5px; background: var(--mk-red); color: var(--mk-on-red); font: 600 10.5px var(--mk-mono); letter-spacing: .08em; text-transform: uppercase; padding: 3px 8px; border-radius: 3px; white-space: nowrap; }
.mk-pick-hint { position: fixed; top: 12px; left: 50%; transform: translateX(-50%); z-index: 2147482502; background: var(--mk-ink); color: var(--mk-paper); padding: 6px 12px; font-weight: 500; font-size: 12.5px; pointer-events: none; border-left: 3px solid var(--mk-red); border-radius: 6px; box-shadow: var(--mk-shadow-lift); }

@media (max-width: 640px) {
  /* phones: a bottom sheet instead of a side drawer; the page stays reachable above it */
  .mk-drawer { top: auto; left: 0; right: 0; bottom: 0; width: 100vw; max-width: none; height: min(88dvh, 100%); border-left: 0; border-top: 1px solid var(--mk-rule-2);
    border-radius: 12px 12px 0 0; animation: mk-sheet .26s var(--mk-ease); box-shadow: 0 -10px 30px -18px rgba(28, 26, 23, .45); }
  .mk-drawer::before { content: ""; position: absolute; top: 6px; left: 50%; width: 36px; height: 4px; margin-left: -18px; background: var(--mk-rule-2); border-radius: 999px; }
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
