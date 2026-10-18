// What the agent may see of the panel the user points at (brainstorm 05 #3, PII). By default only the structure
// leaves the page: tags, classes, test ids, roles, and for each text its length, never its value. With
// `sendDomText: true` the visible text goes too, with e-mail addresses and long numbers masked. A subtree marked
// `data-pleatkit-private` is never sent, in either mode. Form values are never sent.

import { MAX_TARGET_DOM_CHARS } from './protocol.js'

/** The part of the DOM node interface the serializer reads (a real Element, or a stand-in in tests). */
export interface DomLike {
  nodeType: number
  tagName?: string
  textContent: string | null
  attributes?: ArrayLike<{ name: string; value: string }>
  childNodes: ArrayLike<DomLike>
  hasAttribute?(name: string): boolean
}

export interface DomContextOptions {
  /** Send visible text (masked e-mails and numbers). Default false: structure only. */
  includeText?: boolean
  /** Longest result, characters. */
  max?: number
}

export const PRIVATE_ATTR = 'data-pleatkit-private'
const STRUCTURE_ATTRS = /^(class|data-testid|data-pleatkit-id|role|type|colspan|rowspan|disabled|checked|hidden)$/
const TEXT_ATTRS = /^(aria-label|aria-[\w-]+|title|alt|placeholder)$/
const DROP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'LINK', 'META'])
const MAX_TEXT = 160

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/** E-mail addresses, phone-like and card-like digit runs, IBAN-like strings: replaced even when text is sent. */
export function maskPii(text: string): string {
  return text
    .replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, '[email]')
    .replace(/\b[A-Z]{2}\d{2}[A-Z0-9]{10,30}\b/g, '[iban]')
    .replace(/(\+?\d[\d\s().-]{6,}\d)/g, (m) => (m.replace(/\D/g, '').length >= 7 ? '[number]' : m))
}

/** Serialize the children of `host` as sanitized markup for the agent. */
export function serializeDom(host: DomLike, options: DomContextOptions = {}): string {
  const max = options.max ?? MAX_TARGET_DOM_CHARS
  const includeText = options.includeText === true
  const out: string[] = []
  let size = 0
  const push = (s: string) => {
    out.push(s)
    size += s.length
  }
  const walk = (node: DomLike, depth: number) => {
    if (size > max) return
    if (node.nodeType === 3) {
      const text = (node.textContent ?? '').replace(/\s+/g, ' ').trim()
      if (!text) return
      if (!includeText) return push(`[text:${text.length}]`)
      const shown = maskPii(text)
      push(esc(shown.length > MAX_TEXT ? shown.slice(0, MAX_TEXT) + '…' : shown))
      return
    }
    if (node.nodeType !== 1 || !node.tagName) return
    if (DROP_TAGS.has(node.tagName.toUpperCase())) return
    const tag = node.tagName.toLowerCase()
    const indent = depth ? '\n' + '  '.repeat(Math.min(depth, 12)) : ''
    if (node.hasAttribute?.(PRIVATE_ATTR)) return push(`${indent}<${tag} ${PRIVATE_ATTR}>[private]</${tag}>`)
    if (tag === 'iframe') return push(`${indent}<iframe></iframe>`)
    if (tag === 'svg') return push(`${indent}<svg/>`)
    const attrs = Array.from(node.attributes ?? [])
      .map((a) => {
        if (STRUCTURE_ATTRS.test(a.name)) return ` ${a.name}="${esc(a.value.slice(0, 200))}"`
        if (TEXT_ATTRS.test(a.name)) return includeText ? ` ${a.name}="${esc(maskPii(a.value).slice(0, 200))}"` : ` ${a.name}="[text:${a.value.length}]"`
        if (a.name === 'href') return includeText && /^(\/|#|\?)/.test(a.value) ? ` href="${esc(a.value.replace(/\d{3,}/g, '[n]').slice(0, 200))}"` : ' href="[url]"'
        return ''
      })
      .join('')
    push(`${indent}<${tag}${attrs}>`)
    // form values never leave the page; inputs show only their type
    if (tag !== 'input' && tag !== 'textarea' && tag !== 'select') for (const child of Array.from(node.childNodes)) walk(child, depth + 1)
    push(`</${tag}>`)
  }
  for (const child of Array.from(host.childNodes)) walk(child, 0)
  const html = out.join('').trim()
  return html.length > max ? html.slice(0, max) + '\n<!-- truncated -->' : html
}

/**
 * Sanitized markup of the panel the user pointed at, as data for the agent (never instructions). Structure only
 * unless `includeText` (the app's `sendDomText`); `data-pleatkit-private` subtrees and form values never.
 */
export function panelDomSnapshot(id: string, options: DomContextOptions & { root?: ParentNode } = {}): string | null {
  const root = options.root ?? (typeof document !== 'undefined' ? document : null)
  if (!root) return null
  const host = root.querySelector(`[data-pleatkit-id="${CSS.escape(id)}"]`)
  return host ? serializeDom(host as unknown as DomLike, options) : null
}
