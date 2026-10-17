import { useInsertionEffect } from 'react'

// Self-contained styles: the host app may not use Tailwind, so the UI ships plain CSS with an `mk-` prefix.
const CSS = `
.mk-root, .mk-root * { box-sizing: border-box; }
.mk-root { font: 14px/1.45 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; color: #0f172a; }
.mk-launch { position: fixed; right: 20px; bottom: 20px; z-index: 2147482000; display: inline-flex; align-items: center; gap: 8px;
  padding: 10px 16px; border-radius: 999px; border: 0; background: #0f172a; color: #fff; font-weight: 600; cursor: pointer;
  box-shadow: 0 8px 24px rgba(15,23,42,.25); }
.mk-launch:hover { background: #1e293b; }
.mk-dot { width: 8px; height: 8px; border-radius: 50%; background: #a78bfa; }
.mk-drawer { position: fixed; top: 0; right: 0; bottom: 0; width: 400px; max-width: 100vw; z-index: 2147482001; display: flex; flex-direction: column;
  background: #fff; border-left: 1px solid #e2e8f0; box-shadow: -12px 0 32px rgba(15,23,42,.12); }
.mk-head { display: flex; align-items: center; justify-content: space-between; padding: 14px 16px; border-bottom: 1px solid #e2e8f0; }
.mk-title { font-weight: 650; font-size: 15px; }
.mk-sub { font-size: 12px; color: #64748b; }
.mk-icon { border: 0; background: transparent; font-size: 20px; line-height: 1; cursor: pointer; color: #64748b; padding: 4px 8px; border-radius: 6px; }
.mk-icon:hover { background: #f1f5f9; }
.mk-body { flex: 1; overflow-y: auto; padding: 12px 16px; display: flex; flex-direction: column; gap: 12px; }
.mk-empty { color: #64748b; font-size: 13px; }
.mk-empty ul { margin: 6px 0 0; padding-left: 18px; }
.mk-turn { display: flex; flex-direction: column; gap: 6px; }
.mk-req { align-self: flex-end; max-width: 90%; background: #0f172a; color: #fff; padding: 8px 12px; border-radius: 12px 12px 2px 12px; white-space: pre-wrap; }
.mk-resp { align-self: flex-start; max-width: 95%; background: #f8fafc; border: 1px solid #e2e8f0; padding: 8px 12px; border-radius: 12px 12px 12px 2px; }
.mk-steps { list-style: none; margin: 0; padding: 0; font-size: 12px; color: #475569; }
.mk-steps li { display: flex; gap: 6px; align-items: baseline; }
.mk-steps li::before { content: "•"; color: #94a3b8; }
.mk-steps li.mk-bad::before { content: "×"; color: #dc2626; }
.mk-steps li.mk-good::before { content: "✓"; color: #16a34a; }
.mk-summary { margin-top: 4px; }
.mk-badge { display: inline-block; font-size: 11px; font-weight: 600; padding: 1px 8px; border-radius: 999px; margin-right: 6px; }
.mk-b-ok { background: #dcfce7; color: #166534; } .mk-b-admin { background: #fef3c7; color: #92400e; }
.mk-b-bad { background: #fee2e2; color: #991b1b; } .mk-b-run { background: #ede9fe; color: #5b21b6; }
.mk-meta { font-size: 11px; color: #94a3b8; margin-top: 4px; }
.mk-errors { margin: 4px 0 0; padding-left: 16px; font: 11px ui-monospace, Menlo, monospace; color: #991b1b; }
.mk-foot { border-top: 1px solid #e2e8f0; padding: 10px 16px 14px; display: flex; flex-direction: column; gap: 8px; }
.mk-input { width: 100%; min-height: 64px; resize: vertical; border: 1px solid #cbd5e1; border-radius: 10px; padding: 8px 10px; font: inherit; }
.mk-input:focus { outline: 2px solid #a78bfa; outline-offset: 0; border-color: transparent; }
.mk-row { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; }
.mk-btn { border: 1px solid #cbd5e1; background: #fff; color: #0f172a; padding: 6px 10px; border-radius: 8px; font: inherit; font-size: 13px; cursor: pointer; }
.mk-btn:hover:not(:disabled) { background: #f1f5f9; }
.mk-btn:disabled { opacity: .45; cursor: default; }
.mk-primary { background: #0f172a; color: #fff; border-color: #0f172a; margin-left: auto; }
.mk-primary:hover:not(:disabled) { background: #1e293b; }
.mk-on { background: #ede9fe; border-color: #a78bfa; }
.mk-history { max-height: 180px; overflow-y: auto; margin: 0; padding: 0; list-style: none; font-size: 12px; border: 1px solid #e2e8f0; border-radius: 8px; }
.mk-history li { padding: 6px 10px; border-bottom: 1px solid #f1f5f9; display: flex; gap: 8px; }
.mk-history li:last-child { border-bottom: 0; }
.mk-history .mk-cur { background: #f5f3ff; }
.mk-history .mk-rej { opacity: .5; }
.mk-toasts { position: fixed; left: 50%; bottom: 24px; transform: translateX(-50%); z-index: 2147483001; display: flex; flex-direction: column; gap: 8px; align-items: center; }
.mk-toast { background: #0f172a; color: #fff; padding: 8px 14px; border-radius: 10px; font-size: 13px; box-shadow: 0 8px 24px rgba(15,23,42,.25); }
.mk-toast.mk-t-bad { background: #991b1b; } .mk-toast.mk-t-admin { background: #92400e; }
.mk-stale { position: fixed; top: 0; left: 0; right: 0; z-index: 2147482002; display: flex; gap: 12px; align-items: center; justify-content: center; flex-wrap: wrap;
  padding: 8px 16px; background: #fffbeb; border-bottom: 1px solid #fcd34d; color: #78350f; font-size: 13px; }
.mk-pick-layer { position: fixed; inset: 0; z-index: 2147482500; cursor: crosshair; }
.mk-pick-box { position: fixed; z-index: 2147482501; pointer-events: none; border: 2px solid #8b5cf6; background: rgba(139,92,246,.08); border-radius: 8px; transition: all 60ms ease-out; }
.mk-pick-label { position: absolute; top: -24px; left: -2px; background: #8b5cf6; color: #fff; font-size: 12px; font-weight: 600; padding: 2px 8px; border-radius: 6px 6px 6px 0; white-space: nowrap; }
.mk-pick-hint { position: fixed; top: 12px; left: 50%; transform: translateX(-50%); z-index: 2147482502; background: #0f172a; color: #fff; padding: 6px 12px; border-radius: 8px; font-size: 13px; pointer-events: none; }
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
