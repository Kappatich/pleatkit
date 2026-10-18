// DECISIONS 74.3: a URL taken from data (`<img src={row.image}>`, `<a href={row.url}>`) is allowed when it is a relative
// path or resolves to the app's own origin. Data is only known at render time, so the static rules let a computed URL
// through on a plain element and this guard decides when the element is created: every element an edit creates goes
// through the `react/jsx-runtime` (and `react`) the loader hands to compiled bundles, and the guard drops a URL prop
// that would leave the app's origin. External hosts stay refused (an allowlist, DECISIONS 63.1, is not built yet).
//
// The guard resolves the value with the WHATWG URL parser against the page, exactly as the browser will: tabs,
// newlines and leading control characters are stripped, `\` reads as `/`, `//host` and `/\host` are other hosts,
// `user@host` is another host, `javascript:` and `data:` have no origin of their own. A value is kept only when its
// scheme is http(s) and its origin is the page's (an opaque page origin keeps nothing). `mailto:` and `tel:` links
// are kept on `href`.

/** Props that make the browser load or navigate to a URL (the same list as the static rules' URL_ATTRS). */
const SINGLE_URL_PROPS = new Set(['src', 'href', 'action', 'formAction', 'formaction', 'poster', 'data', 'background', 'cite', 'codebase', 'manifest', 'xlinkHref', 'xlink:href'])
/** Props that hold several URLs: `srcSet` candidates (`url 2x, url 640w`), `ping` (space separated). */
const LIST_URL_PROPS = new Set(['srcSet', 'srcset', 'imageSrcSet', 'imagesrcset', 'ping'])
/** Props an edit never sets (the static rules refuse them as written); dropped when they arrive through data. */
const DROPPED_PROPS = new Set(['dangerouslySetInnerHTML', 'srcDoc', 'srcdoc'])
const MAIL = /^(mailto|tel):/i

export interface PageOrigin {
  /** `location.origin` of the page ("null" for an opaque origin: then no URL from data is kept). */
  origin: string
  /** `document.baseURI`: what relative URLs resolve against. */
  base: string
}

/** The page's origin, or a placeholder origin outside a browser (relative paths still pass, absolute ones do not). */
export function pageOrigin(): PageOrigin {
  const loc = (globalThis as { location?: { origin?: string; href?: string } }).location
  const doc = (globalThis as { document?: { baseURI?: string } }).document
  if (loc?.origin && loc.href) return { origin: loc.origin, base: doc?.baseURI ?? loc.href }
  return { origin: 'http://pleatkit.invalid', base: 'http://pleatkit.invalid/' }
}

/**
 * The URL if it stays on the page's origin (or is a `mailto:`/`tel:` link when `mail` is set), else undefined.
 * The value is returned as written: the browser resolves it to the same URL this function checked.
 */
export function sameOriginUrl(value: unknown, page: PageOrigin = pageOrigin(), opts: { mail?: boolean } = {}): string | undefined {
  if (value === undefined || value === null || value === '') return value === '' ? '' : undefined
  if (typeof value !== 'string' && !(value instanceof URL)) return undefined
  const text = String(value)
  if (page.origin === 'null' || !page.origin) return undefined
  let url: URL
  try {
    url = new URL(text, page.base)
  } catch {
    return undefined
  }
  if (opts.mail && MAIL.test(url.protocol)) return text
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined
  return url.origin === page.origin ? text : undefined
}

/** `srcSet` / `ping`: kept only when every URL in it stays on the page's origin. */
function sameOriginList(prop: string, value: unknown, page: PageOrigin): string | undefined {
  if (typeof value !== 'string') return undefined
  const urls = prop === 'ping' ? value.split(/\s+/) : value.split(',').map((c) => c.trim().split(/\s+/)[0] ?? '')
  return urls.filter(Boolean).every((u) => sameOriginUrl(u, page) !== undefined) ? value : undefined
}

/** A style value with `url(...)`: kept only when every url() in it stays on the page's origin. */
function sameOriginCss(value: string, page: PageOrigin): boolean {
  for (const m of value.matchAll(/url\(\s*(['"]?)([^)'"]*)\1\s*\)/gi)) {
    const u = (m[2] ?? '').trim()
    if (/^data:image\//i.test(u)) continue
    if (sameOriginUrl(u, page) === undefined) return false
  }
  // a url( the pattern could not read (escapes, nesting) is not kept
  return !/url\(/i.test(value.replace(/url\(\s*(['"]?)([^)'"]*)\1\s*\)/gi, ''))
}

/**
 * Props of an element an edit creates, with every URL that would leave the page's origin removed. Components (a
 * function or class `type`) are not touched: what they render goes through the host's own React, and their URL props
 * stay under the static rules. Returns the same object when nothing changes.
 */
export function guardProps(type: unknown, props: Record<string, unknown> | null | undefined, page?: PageOrigin): Record<string, unknown> | null | undefined {
  if (typeof type !== 'string' || !props || typeof props !== 'object') return props
  let out: Record<string, unknown> | null = null
  let origin: PageOrigin | undefined = page
  const set = (k: string, v: unknown) => {
    out ??= { ...props }
    if (v === undefined) delete out[k]
    else out[k] = v
  }
  for (const k of Object.keys(props)) {
    const v = props[k]
    if (DROPPED_PROPS.has(k)) {
      set(k, undefined)
      continue
    }
    if (SINGLE_URL_PROPS.has(k)) {
      if (v === undefined || v === null) continue
      origin ??= pageOrigin()
      const kept = sameOriginUrl(v, origin, { mail: k === 'href' || k === 'xlinkHref' || k === 'xlink:href' })
      if (kept !== v) set(k, kept)
    } else if (LIST_URL_PROPS.has(k)) {
      if (v === undefined || v === null) continue
      origin ??= pageOrigin()
      const kept = sameOriginList(k, v, origin)
      if (kept !== v) set(k, kept)
    } else if (k === 'style' && v && typeof v === 'object') {
      origin ??= pageOrigin()
      let style: Record<string, unknown> | null = null
      for (const [sk, sv] of Object.entries(v as Record<string, unknown>)) {
        if (typeof sv === 'string' && /url\(/i.test(sv) && !sameOriginCss(sv, origin)) {
          style ??= { ...(v as Record<string, unknown>) }
          delete style[sk]
        }
      }
      if (style) set(k, style)
    }
  }
  return out ?? props
}

type Fn = (...args: unknown[]) => unknown

/**
 * The host module as compiled edits see it: `react/jsx-runtime` and `react/jsx-dev-runtime` with `jsx`, `jsxs` and
 * `jsxDEV` guarded, `react` with `createElement` and `cloneElement` guarded (the static rules refuse both by name, the
 * guard also covers an aliased or destructured one), `react-dom` without its resource hints that fetch other hosts
 * (`preinit`, `preload`, … keep same-origin URLs only). Any other module is returned unchanged.
 */
export function guardModule(name: string, ns: Record<string, unknown>): Record<string, unknown> {
  /** `create`: (type, props, …) as jsx() and createElement(); `clone`: (element, props, …) as cloneElement(). */
  const wrapAt = (fn: unknown, kind: 'create' | 'clone' = 'create'): unknown => {
    if (typeof fn !== 'function') return fn
    const original = fn as Fn
    return function guarded(this: unknown, ...args: unknown[]) {
      const type = kind === 'create' ? args[0] : (args[0] as { type?: unknown } | null)?.type
      args[1] = guardProps(type, args[1] as Record<string, unknown> | null | undefined)
      return original.apply(this, args)
    }
  }
  if (name === 'react/jsx-runtime' || name === 'react/jsx-dev-runtime') {
    return { ...ns, jsx: wrapAt(ns.jsx), jsxs: wrapAt(ns.jsxs), ...(ns.jsxDEV ? { jsxDEV: wrapAt(ns.jsxDEV) } : {}) }
  }
  if (name === 'react') {
    const createElement = wrapAt(ns.createElement)
    const cloneElement = wrapAt(ns.cloneElement, 'clone')
    const out: Record<string, unknown> = { ...ns, createElement, cloneElement }
    // `import React from 'react'` reads the default export: the same guarded functions there
    if (ns.default && typeof ns.default === 'object') out.default = { ...(ns.default as Record<string, unknown>), createElement, cloneElement }
    return out
  }
  if (name === 'react-dom') {
    const hint = (fn: unknown): unknown =>
      typeof fn !== 'function'
        ? fn
        : function guardedHint(this: unknown, href: unknown, ...rest: unknown[]) {
            if (sameOriginUrl(href) === undefined) return undefined
            return (fn as Fn).apply(this, [href, ...rest])
          }
    const out: Record<string, unknown> = { ...ns }
    for (const k of ['preinit', 'preinitModule', 'preload', 'preloadModule', 'prefetchDNS', 'preconnect']) if (k in ns) out[k] = hint(ns[k])
    if (ns.default && typeof ns.default === 'object') {
      const d: Record<string, unknown> = { ...(ns.default as Record<string, unknown>) }
      for (const k of ['preinit', 'preinitModule', 'preload', 'preloadModule', 'prefetchDNS', 'preconnect']) if (k in d) d[k] = hint(d[k])
      out.default = d
    }
    return out
  }
  return ns
}
