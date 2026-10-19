// DECISIONS 74.3: a URL taken from data (`<img src={row.image}>`, `<a href={row.url}>`) is allowed when it is a relative
// path or resolves to the app's own origin. Data is only known at render time, so the static rules let a computed URL
// through on a plain element and this guard decides when the element is created: every element an edit creates goes
// through the `react/jsx-runtime` (and `react`) the loader hands to compiled bundles, and the guard drops a URL prop
// that would leave the app's origin.
//
// DECISIONS 63.1: the app may list other hosts in `allowedHosts` (the vite-plugin option, carried in the manifest).
// Only `<img src>`, `<img srcSet>` and `<a href>` may then point to them, only with `https:`, the default port and no
// user info; every other prop, `http:`, and react-dom's resource hints stay on the app's origin.
//
// The guard resolves the value with the WHATWG URL parser against the page, exactly as the browser will: tabs,
// newlines and leading control characters are stripped, `\` reads as `/`, `//host` and `/\host` are other hosts,
// `user@host` is another host, `javascript:` and `data:` have no origin of their own. A value is kept only when its
// scheme is http(s) and its origin is the page's (an opaque page origin keeps nothing), or when it is an allowed
// external URL as above (kept in its canonical form, so the browser loads exactly the URL that was checked).
// `mailto:` and `tel:` links are kept on `href`.

/** Props that make the browser load or navigate to a URL (the same list as the static rules' URL_ATTRS). */
const SINGLE_URL_PROPS = new Set(['src', 'href', 'action', 'formAction', 'formaction', 'poster', 'data', 'background', 'cite', 'codebase', 'manifest', 'xlinkHref', 'xlink:href'])
/** Props that hold several URLs: `srcSet` candidates (`url 2x, url 640w`), `ping` (space separated). */
const LIST_URL_PROPS = new Set(['srcSet', 'srcset', 'imageSrcSet', 'imagesrcset', 'ping'])
/** Props an edit never sets (the static rules refuse them as written); dropped when they arrive through data. */
const DROPPED_PROPS = new Set(['dangerouslySetInnerHTML', 'srcDoc', 'srcdoc'])
/** DECISIONS 63.1: the only element props that may point to a host of `allowedHosts`. */
const EXTERNAL_PROPS: Record<string, ReadonlySet<string>> = { img: new Set(['src', 'srcSet', 'srcset']), a: new Set(['href']) }
const MAIL = /^(mailto|tel):/i

export interface PageOrigin {
  /** `location.origin` of the page ("null" for an opaque origin: then no URL from data is kept). */
  origin: string
  /** `document.baseURI`: what relative URLs resolve against. */
  base: string
}

export interface GuardOptions {
  /** DECISIONS 63.1: hosts `<img src>`/`srcSet` and `<a href>` may point to over https (from the manifest). */
  allowedHosts?: readonly string[]
}

/** The page's origin, or a placeholder origin outside a browser (relative paths still pass, absolute ones do not). */
export function pageOrigin(): PageOrigin {
  const loc = (globalThis as { location?: { origin?: string; href?: string } }).location
  const doc = (globalThis as { document?: { baseURI?: string } }).document
  if (loc?.origin && loc.href) return { origin: loc.origin, base: doc?.baseURI ?? loc.href }
  return { origin: 'http://pleatkit.invalid', base: 'http://pleatkit.invalid/' }
}

/**
 * DECISIONS 63.1: one entry of `allowedHosts`, normalized: an exact host name in lower case, an IDN in its punycode
 * form (`bücher.example` → `xn--bcher-kva.example`). Throws on anything else: a scheme, a path, a port, user info, a
 * wildcard (each subdomain is listed by itself), percent-encoding, an IP address, a trailing dot, a single label.
 */
export function normalizeAllowedHost(entry: unknown): string {
  const raw = typeof entry === 'string' ? entry.trim() : ''
  const fail = (why: string): never => {
    throw new Error(`allowedHosts: "${String(entry)}" ${why}; list exact host names such as "images.example-cdn.com"`)
  }
  if (!raw) return fail('is empty')
  if (raw.includes('*')) return fail('is a wildcard (only exact host names: list each subdomain)')
  if (/[/\\:@?#%\s[\]]/.test(raw)) return fail('is not a bare host name (no scheme, path, port, user info or percent-encoding)')
  if (raw.endsWith('.')) return fail('ends with a dot')
  let host = ''
  try {
    host = new URL(`https://${raw}/`).hostname
  } catch {
    return fail('is not a valid host name')
  }
  if (/^[\d.]+$/.test(host)) return fail('is an IP address')
  if (!host.includes('.')) return fail('is a single label (a public host name has a dot)')
  if (!/^[a-z0-9.-]+$/.test(host) || host.split('.').some((l) => !l || l.length > 63 || l.startsWith('-') || l.endsWith('-'))) return fail('is not a valid host name')
  return host
}

/** `allowedHosts` normalized and without duplicates (throws on an invalid entry, see `normalizeAllowedHost`). */
export function normalizeAllowedHosts(list: readonly unknown[] | undefined | null): string[] {
  if (list === undefined || list === null) return []
  if (!Array.isArray(list)) throw new Error('allowedHosts must be an array of host names')
  return [...new Set(list.map(normalizeAllowedHost))]
}

const hostSet = (hosts: readonly string[] | undefined): ReadonlySet<string> => new Set((hosts ?? []).filter((h) => typeof h === 'string').map((h) => h.toLowerCase()))

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

/**
 * DECISIONS 63.1: the canonical URL (`url.href`) when the value resolves to `https:` on a host of `hosts`, with the
 * default port and no user info; else undefined. Upper case, IDN, `\`, tabs and percent-encoding in the host are
 * read the way the browser reads them, and the canonical form is what the element gets.
 */
export function allowedHostUrl(value: unknown, hosts: ReadonlySet<string> | readonly string[], page: PageOrigin = pageOrigin()): string | undefined {
  const set = hosts instanceof Set ? hosts : hostSet(hosts as readonly string[])
  if (set.size === 0) return undefined
  if (typeof value !== 'string' && !(value instanceof URL)) return undefined
  let url: URL
  try {
    url = new URL(String(value), page.base)
  } catch {
    return undefined
  }
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '' || url.port !== '') return undefined
  return set.has(url.hostname) ? url.href : undefined
}

const SRCSET_SPACE = /[ \t\n\f\r]/

/** URL candidates of a `srcset` as the HTML parser reads them (a URL may hold commas; descriptors may hold parens). */
function srcsetCandidates(value: string): string[] {
  const out: string[] = []
  let i = 0
  while (i < value.length) {
    while (i < value.length && (SRCSET_SPACE.test(value[i]!) || value[i] === ',')) i++
    if (i >= value.length) break
    const start = i
    while (i < value.length && !SRCSET_SPACE.test(value[i]!)) i++
    let url = value.slice(start, i)
    if (url.endsWith(',')) url = url.replace(/,+$/, '')
    else {
      let parens = false
      while (i < value.length) {
        const c = value[i++]
        if (c === '(') parens = true
        else if (c === ')') parens = false
        else if (c === ',' && !parens) break
      }
    }
    if (url) out.push(url)
  }
  return out
}

/**
 * `srcSet` / `ping`: kept only when every URL in it stays on the page's origin (or, where `hosts` is given, is an
 * allowed external URL). `srcSet` is split both naively (on commas) and as the HTML parser does, and every piece of
 * both readings must pass.
 */
function guardedList(prop: string, value: unknown, page: PageOrigin, hosts: ReadonlySet<string> | null): string | undefined {
  if (typeof value !== 'string') return undefined
  const urls = prop === 'ping' ? value.split(/\s+/) : [...value.split(',').map((c) => c.trim().split(/\s+/)[0] ?? ''), ...srcsetCandidates(value)]
  const ok = (u: string) => sameOriginUrl(u, page) !== undefined || (hosts !== null && allowedHostUrl(u, hosts, page) !== undefined)
  return urls.filter(Boolean).every(ok) ? value : undefined
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
 * Props of an element an edit creates, with every URL that would leave the page's origin removed (except an
 * allowed external URL on `<img src>`/`srcSet` and `<a href>`, DECISIONS 63.1). Components (a function or class
 * `type`) are not touched: what they render goes through the host's own React, and their URL props stay under the
 * static rules. Returns the same object when nothing changes.
 */
export function guardProps(type: unknown, props: Record<string, unknown> | null | undefined, page?: PageOrigin, opts: GuardOptions | ReadonlySet<string> = {}): Record<string, unknown> | null | undefined {
  if (typeof type !== 'string' || !props || typeof props !== 'object') return props
  const hosts = opts instanceof Set ? opts : hostSet((opts as GuardOptions).allowedHosts)
  const external = hosts.size > 0 ? (EXTERNAL_PROPS[type] ?? null) : null
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
      let kept = sameOriginUrl(v, origin, { mail: k === 'href' || k === 'xlinkHref' || k === 'xlink:href' })
      if (kept === undefined && external?.has(k)) kept = allowedHostUrl(v, hosts, origin)
      if (kept !== v) set(k, kept)
    } else if (LIST_URL_PROPS.has(k)) {
      if (v === undefined || v === null) continue
      origin ??= pageOrigin()
      const kept = guardedList(k, v, origin, external?.has(k) ? hosts : null)
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
 * (`preinit`, `preload`, … keep same-origin URLs only, whatever `allowedHosts` says). Any other module is returned
 * unchanged.
 */
export function guardModule(name: string, ns: Record<string, unknown>, opts: GuardOptions = {}): Record<string, unknown> {
  const hosts = hostSet(opts.allowedHosts)
  /** `create`: (type, props, …) as jsx() and createElement(); `clone`: (element, props, …) as cloneElement(). */
  const wrapAt = (fn: unknown, kind: 'create' | 'clone' = 'create'): unknown => {
    if (typeof fn !== 'function') return fn
    const original = fn as Fn
    return function guarded(this: unknown, ...args: unknown[]) {
      const type = kind === 'create' ? args[0] : (args[0] as { type?: unknown } | null)?.type
      args[1] = guardProps(type, args[1] as Record<string, unknown> | null | undefined, undefined, hosts)
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
