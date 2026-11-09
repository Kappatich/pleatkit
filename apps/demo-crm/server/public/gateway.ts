import fs from 'node:fs'
import path from 'node:path'
import { Hono, type Context } from 'hono'
import { getCookie, setCookie } from 'hono/cookie'
import { bodyLimit } from 'hono/body-limit'
import { DEMO_REQUESTS, demoRequestOf } from '../../src/core/demo-requests.js'
import type { AgentResult } from './agent-api.js'
import type { Budget } from './budget.js'
import type { DemoConfig } from './config.js'
import { derivedEvents, wordsOf, type DataLog, type Outcome } from './datalog.js'
import { RateLimiter, type LimitClass } from './rate-limit.js'
import { runContext, type Route } from './runner.js'
import { APP_COOKIE, COOKIE, type Visitor, type Visitors } from './visitors.js'

/**
 * The Content Security Policy of the demo: the product's server-compile policy (docs/for-agents/production.md §6)
 * plus the usual hardening of pleatkit.com. Edits load only from this origin; nothing on the page can talk to
 * another host (connect-src 'self').
 */
export const DEMO_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self'",
  "connect-src 'self'",
  "worker-src 'none'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ')

const SECURITY_HEADERS: Record<string, string> = {
  'content-security-policy': DEMO_CSP,
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
  'cross-origin-opener-policy': 'same-origin',
}

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.wasm': 'application/wasm',
  '.txt': 'text/plain; charset=utf-8',
}

/** What a crawler may fetch: the demo page. The per-visitor views and the APIs are not for indexing. */
const ROBOTS = ['User-agent: *', 'Disallow: /admin', 'Disallow: /api/', 'Disallow: /demo/api/', 'Disallow: /pleatkit-store/', 'Disallow: /pleatkit/', 'Disallow: /agent/', ''].join('\n')

/**
 * User agents that call themselves a crawler or a link previewer. They keep no cookie, so every page they fetch
 * would be a new visitor: one more sandbox, one more line in the research log, and (the admin links carry the
 * sandbox id) one more set of URLs to follow. They get the page and nothing else.
 */
const CRAWLER = /bot[/;)-]|crawl|spider|slurp|externalhit|externalagent|chatgpt-user/i

const USERS = ['alice', 'bob']
/** Identity headers the browser may not set: the gateway decides the app, the agent flag and the org. */
const STRIPPED = ['authorization', 'cookie', 'x-pleatkit-app', 'x-pleatkit-agent', 'x-pleatkit-act-as', 'x-pleatkit-org', 'x-pleatkit-role', 'x-pleatkit-env', 'x-demo-client-ip', 'x-forwarded-for', 'x-real-ip', 'host', 'content-length']
const FEEDBACK_REASONS = ['wrong_panel', 'looks_wrong', 'not_what_i_meant']
const EMAIL = /^[^\s@<>"']{1,64}@[^\s@<>"']{1,190}\.[A-Za-z]{2,24}$/

export interface GatewayDeps {
  config: DemoConfig
  visitors: Visitors
  budget: Budget
  datalog: DataLog
  limiter: RateLimiter
  agent: { fetch: (req: Request) => Response | Promise<Response> }
  log: (line: string) => void
}

type Ctx = Context<{ Variables: { client: string; visitor: Visitor } }>

const json = (c: Ctx, body: unknown, status: 200 | 400 | 403 | 404 | 413 | 429 = 200) => c.json(body as object, status)

export function createGateway(deps: GatewayDeps) {
  const { config, visitors, budget, datalog, limiter, log } = deps
  const app = new Hono<{ Variables: { client: string; visitor: Visitor } }>()
  const startedAt = Date.now()

  app.onError((e, c) => {
    log(`[demo] ${c.req.method} ${new URL(c.req.url).pathname}: ${e.message}`)
    return c.json({ error: 'internal error' }, 500)
  })

  // security headers on every answer (nginx adds HSTS)
  app.use('*', async (c, next) => {
    await next()
    try {
      for (const [k, v] of Object.entries(SECURITY_HEADERS)) c.res.headers.set(k, v)
    } catch {
      const res = new Response(c.res.body, c.res)
      for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.headers.set(k, v)
      c.res = res
    }
  })

  // the client key: a salted hash of the address, for the rate limiter and the per-visitor live cap only
  app.use('*', async (c, next) => {
    const incoming = (c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined)?.incoming
    const forwarded = config.trustProxy ? c.req.header('x-demo-client-ip')?.split(',')[0]?.trim() : undefined
    c.set('client', limiter.clientKey(forwarded || incoming?.socket?.remoteAddress || 'unknown'))
    await next()
  })

  const limit = (c: Ctx, cls: LimitClass): Response | null => {
    const r = limiter.take(c.get('client'), cls)
    if (r.ok) return null
    c.header('retry-after', String(r.retryAfterS))
    return json(c, { error: 'too many requests, slow down a little' }, 429)
  }

  const isCrawler = (c: Ctx): boolean => CRAWLER.test(c.req.header('user-agent') ?? '')

  /** The visitor of this request, created (with its cookie) on first contact. Crawlers get none. */
  const visitor = (c: Ctx): Visitor | Response => {
    const cookie = getCookie(c, COOKIE)
    const known = visitors.get(cookie)
    if (known) return known
    if (isCrawler(c)) return json(c, { error: 'the demo keeps no sandbox for crawlers' }, 403)
    const tooMany = limit(c, 'newVisitor')
    if (tooMany) return tooMany
    const { visitor: v } = visitors.ensure(cookie)
    if (v.id !== cookie) {
      setCookie(c, COOKIE, v.id, { path: '/', httpOnly: true, sameSite: 'Lax', secure: config.secureCookie, maxAge: Math.floor(config.visitorTtlMs / 1000) })
    }
    return v
  }

  const withVisitor = (cls: LimitClass, handler: (c: Ctx, v: Visitor) => Response | Promise<Response>) => async (c: Ctx) => {
    const tooMany = limit(c, cls)
    if (tooMany) return tooMany
    const v = visitor(c)
    if (v instanceof Response) return v
    return handler(c, v)
  }

  const small = bodyLimit({ maxSize: 64 * 1024, onError: (c) => c.json({ error: 'request body is too large' }, 413) })
  app.use('/demo/api/*', small)
  app.use('/api/*', small)
  app.use('/pleatkit-store/*', bodyLimit({ maxSize: 1024 * 1024, onError: (c) => c.json({ error: 'request body is too large' }, 413) }))
  app.use('/agent/*', bodyLimit({ maxSize: 2 * 1024 * 1024, onError: (c) => c.json({ error: 'request body is too large' }, 413) }))

  // --- the demo's own API ---

  app.get('/demo/api/health', (c) => c.json({ ok: true, mode: config.mode, visitors: visitors.size, uptimeS: Math.round((Date.now() - startedAt) / 1000) }))

  const status = (c: Ctx, v: Visitor) =>
    json(c, {
      mode: config.mode,
      liveLeft: budget.left(v.hash, c.get('client')),
      requests: DEMO_REQUESTS.map((r) => ({ id: r.id, text: r.text })),
      contactEmail: config.contactEmail,
      siteUrl: config.siteUrl,
      filmUrl: config.filmUrl,
    })
  app.get('/demo/api/status', withVisitor('status', status))

  const body = async (c: Ctx): Promise<Record<string, unknown> | null> => {
    const b = (await c.req.json().catch(() => null)) as unknown
    return b && typeof b === 'object' && !Array.isArray(b) ? (b as Record<string, unknown>) : null
  }
  const str = (v: unknown, max: number): string | null => (typeof v === 'string' ? v.slice(0, max) : null)

  app.post(
    '/demo/api/event',
    withVisitor('event', async (c, v) => {
      const b = await body(c)
      const type = b?.type
      const requestId = str(b?.requestId, 64)
      const ms = typeof b?.ms === 'number' && Number.isFinite(b.ms) ? Math.max(0, Math.round(b.ms)) : null
      if (type === 'undo' && requestId && v.requestIds.has(requestId)) {
        datalog.write('session', { visitor: v.hash, event: 'undo', requestId, msSinceApplied: ms, within2min: ms !== null && ms <= 120_000 })
      } else if (type === 'runtime_error' && requestId && v.requestIds.has(requestId)) {
        datalog.write('outcome', { visitor: v.hash, requestId, outcome: 'runtime_error' satisfies Outcome, msSinceApplied: ms })
      } else if (type === 'film_click' || type === 'site_click' || type === 'admin_click') {
        datalog.write('session', { visitor: v.hash, event: type })
      } else {
        return json(c, { error: 'unknown event' }, 400)
      }
      return json(c, { ok: true })
    }),
  )

  app.post(
    '/demo/api/feedback',
    withVisitor('event', async (c, v) => {
      const b = await body(c)
      const requestId = str(b?.requestId, 64)
      const answer = b?.answer
      if (!requestId || !v.requestIds.has(requestId) || (answer !== 'yes' && answer !== 'not_quite')) return json(c, { error: 'unknown request or answer' }, 400)
      const reasons = Array.isArray(b?.reasons) ? [...new Set(b.reasons.filter((r): r is string => typeof r === 'string' && FEEDBACK_REASONS.includes(r)))] : []
      const comment = str(b?.comment, 1000)?.trim() || null
      datalog.write('feedback', { visitor: v.hash, requestId, answer, reasons, comment })
      return json(c, { ok: true })
    }),
  )

  app.post('/demo/api/lead', async (c) => {
    const tooMany = limit(c as Ctx, 'lead')
    if (tooMany) return tooMany
    const v = visitor(c as Ctx)
    if (v instanceof Response) return v
    const b = await body(c as Ctx)
    const email = str(b?.email, 254)?.trim() ?? ''
    if (!EMAIL.test(email)) return json(c as Ctx, { error: 'that does not look like an e-mail address' }, 400)
    const note = str(b?.note, 1000)?.trim() || null
    const useful = b?.useful === 'yes' || b?.useful === 'no' ? b.useful : null
    datalog.lead({ visitor: v.hash, email, note, useful })
    datalog.write('session', { visitor: v.hash, event: 'email_left' })
    return json(c as Ctx, { ok: true })
  })

  // --- the CRM's data API: each visitor has a copy of the demo data ---

  app.all('/api/pleatkit-token', (c) => json(c as Ctx, { error: 'not in the public demo' }, 404))
  app.all(
    '/api/*',
    withVisitor('data', (c, v) => v.data.fetch(c.req.raw)),
  )

  // --- store-server: the visitor's own store, as the visitor's own app ---

  const sanitized = (c: Ctx, v: Visitor): Headers => {
    const h = new Headers(c.req.raw.headers)
    for (const k of STRIPPED) h.delete(k)
    h.set('x-pleatkit-app', v.appId)
    const user = h.get('x-pleatkit-user')
    if (user !== null && !USERS.includes(user)) h.set('x-pleatkit-user', 'alice')
    return h
  }

  app.all(
    '/pleatkit-store/*',
    withVisitor('store', async (c, v) => {
      const url = new URL(c.req.url)
      url.pathname = url.pathname.replace(/^\/pleatkit-store/, '') || '/'
      const hasBody = !['GET', 'HEAD'].includes(c.req.method)
      const req = new Request(url, { method: c.req.method, headers: sanitized(c, v), ...(hasBody ? { body: await c.req.arrayBuffer() } : {}) })
      return visitors.storeOf(v).fetch(req)
    }),
  )

  // signed bundles of the visitor's edits: always from the visitor's own namespace, whatever app the path names
  app.get(
    '/pleatkit/b/:app/:file',
    withVisitor('bundle', async (c, v) => {
      const file = c.req.param('file') ?? ''
      if (!/^[A-Za-z0-9._-]{1,200}$/.test(file)) return json(c, { error: 'not found' }, 404)
      const url = new URL(c.req.url)
      url.pathname = `/v1/b/${encodeURIComponent(v.appId)}/${file}`
      return visitors.storeOf(v).fetch(new Request(url, { headers: sanitized(c, v) }))
    }),
  )

  // --- the agent server ---

  app.all('/agent/v1/b/*', (c) => json(c as Ctx, { error: 'not found' }, 404))
  app.get('/agent/health', (c) => deps.agent.fetch(new Request(c.req.url)))
  app.get('/agent/v1/health', (c) => deps.agent.fetch(new Request(c.req.url)))

  const isRun = (p: string) => p === '/agent/run' || p === '/agent/v1/run'

  app.all(
    '/agent/*',
    async (c) => {
      const p = new URL(c.req.url).pathname
      const tooMany = limit(c as Ctx, isRun(p) ? 'run' : 'agent')
      if (tooMany) return tooMany
      const v = visitor(c as Ctx)
      if (v instanceof Response) return v
      const headers = sanitized(c as Ctx, v)
      let payload: Record<string, unknown> | null = null
      if (c.req.method === 'POST') {
        payload = await body(c as Ctx)
        if (!payload) return json(c as Ctx, { error: 'Body must be a JSON object' }, 400)
        // the visitor's own namespace, whatever the page says
        payload.appId = v.appId
        if (payload.userId !== undefined) payload.userId = typeof payload.userId === 'string' && USERS.includes(payload.userId) ? payload.userId : 'alice'
        headers.set('content-type', 'application/json')
      }
      const req = new Request(c.req.url, { method: c.req.method, headers, ...(payload ? { body: JSON.stringify(payload) } : {}) })
      if (!isRun(p) || !payload) return deps.agent.fetch(req)
      return run(c as Ctx, v, payload, req)
    },
  )

  /** One run: route it, hand it to the agent app, and log the result as it streams past. */
  async function run(c: Ctx, v: Visitor, payload: Record<string, unknown>, req: Request): Promise<Response> {
    const started = Date.now()
    const text = typeof payload.request === 'string' ? payload.request : ''
    const chip = demoRequestOf(text)
    let route: Route
    let live = false
    if (chip) route = 'scripted'
    else if (budget.liveEnabled) {
      const d = budget.begin(v.hash, c.get('client'))
      if (d.ok) {
        route = 'live'
        live = true
      } else route = d.why === 'busy' ? 'busy' : 'cap'
    } else route = 'refuse'
    if (route === 'scripted') budget.count('scripted')
    else if (route === 'refuse') budget.count('refused')
    else if (route !== 'live') budget.count('capped')

    const seq = ++v.seq
    const recent = { text, words: wordsOf(text), chip: Boolean(chip), at: started }
    for (const e of derivedEvents(v.recent, recent)) datalog.write('session', { visitor: v.hash, seq, event: e.type, sinceMs: e.sinceMs, ...(e.overlap !== undefined ? { overlap: e.overlap } : {}), request: text.slice(0, 4000) })
    v.recent.push(recent)
    if (v.recent.length > 20) v.recent.shift()

    let settled = false
    const base = {
      visitor: v.hash,
      seq,
      mode: route === 'live' ? 'live' : 'scripted',
      route,
      request: text.slice(0, 4000),
      chip: Boolean(chip),
      chipId: chip?.id ?? null,
      target: typeof payload.target === 'string' ? payload.target : null,
      clarification: Boolean(payload.clarification),
      lang: typeof payload.locale === 'string' ? payload.locale : null,
    }
    const settle = (result: (Omit<AgentResult, 'requestId'> & { requestId?: string | null }) | null, error: string | null, steps: number) => {
      if (settled) return
      settled = true
      const usage = result?.usage ?? []
      const cost = usage.reduce((s, u) => s + (u.costUsd ?? 0), 0)
      if (live) budget.finish(cost)
      if (result?.requestId) {
        v.requestIds.add(result.requestId)
        if (v.requestIds.size > 200) v.requestIds.delete(v.requestIds.values().next().value!)
      }
      const files = Object.entries(result?.files ?? {})
      datalog.write('request', {
        ...base,
        requestId: result?.requestId ?? null,
        verdict: result?.verdict ?? null,
        outcome: result ? outcomeOf(route, result) : 'failed',
        classification: result?.classification ?? null,
        model: result?.model ?? null,
        models: usage.map((u) => u.model),
        tokens: {
          input: usage.reduce((s, u) => s + u.inputTokens, 0),
          output: usage.reduce((s, u) => s + u.outputTokens, 0),
          cacheRead: usage.reduce((s, u) => s + u.cacheReadTokens, 0),
          cacheWrite: usage.reduce((s, u) => s + u.cacheWriteTokens, 0),
        },
        costUsd: Math.round(cost * 1e6) / 1e6,
        priced: usage.every((u) => u.costUsd !== null),
        latencyMs: { total: Date.now() - started, model: result?.timings.modelMs ?? null, classify: result?.timings.classifyMs ?? null },
        answer: result?.summary ?? null,
        error: error ?? result?.error ?? null,
        stopReason: result?.stopReason ?? null,
        panels: files.map(([p]) => p),
        files: { count: files.length, bytes: files.reduce((s, [, src]) => s + Buffer.byteLength(src), 0) },
        steps,
        toolCalls: result?.log.length ?? 0,
        modelCalls: result?.modelCalls ?? 0,
      })
    }

    // a stream that is dropped without flush or cancel still releases its budget reservation
    setTimeout(() => settle(null, 'no result within 5 minutes', 0), 300_000).unref()
    let res: Response
    try {
      res = await runContext.run({ route }, () => deps.agent.fetch(req))
    } catch (e) {
      settle(null, (e as Error).message, 0)
      throw e
    }
    if (!res.body || !(res.headers.get('content-type') ?? '').includes('text/event-stream')) {
      const msg = await res
        .clone()
        .text()
        .catch(() => '')
      settle(null, msg.slice(0, 500) || `HTTP ${res.status}`, 0)
      return res
    }
    let buffer = ''
    let steps = 0
    const decoder = new TextDecoder()
    const onBlock = (block: string) => {
      let event = 'message'
      let data = ''
      for (const line of block.split('\n')) {
        if (line.startsWith('event:')) event = line.slice(6).trim()
        else if (line.startsWith('data:')) data += line.slice(5).trim()
      }
      if (event === 'progress') steps++
      else if (event === 'result') {
        try {
          settle(JSON.parse(data) as AgentResult, null, steps)
        } catch {
          settle(null, 'unreadable result', steps)
        }
      } else if (event === 'error') {
        let message = 'agent error'
        try {
          message = (JSON.parse(data) as { message?: string }).message ?? message
        } catch {
          // keep the generic message
        }
        settle(null, message, steps)
      }
    }
    const tap = new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        controller.enqueue(chunk)
        buffer += decoder.decode(chunk, { stream: true }).replace(/\r\n/g, '\n')
        let i: number
        while ((i = buffer.indexOf('\n\n')) >= 0) {
          onBlock(buffer.slice(0, i))
          buffer = buffer.slice(i + 2)
        }
      },
      flush() {
        if (buffer.trim()) onBlock(buffer)
        settle(null, 'the stream ended without a result (the visitor cancelled or disconnected)', steps)
      },
      cancel() {
        settle(null, 'cancelled by the visitor', steps)
      },
    } as Transformer<Uint8Array, Uint8Array>)
    return new Response(res.body.pipeThrough(tap), { status: res.status, headers: res.headers })
  }

  // --- the app itself ---

  const root = path.resolve(config.webDir)
  const index = () => fs.readFileSync(path.join(root, 'index.html'))

  app.get('/robots.txt', (c) => c.body(ROBOTS, 200, { 'content-type': TYPES['.txt']!, 'cache-control': 'public, max-age=3600' }))

  app.get('*', async (c) => {
    const tooMany = limit(c as Ctx, 'page')
    if (tooMany) return tooMany
    const url = new URL(c.req.url)
    const rel = decodeURIComponent(url.pathname)
    const file = path.resolve(root, '.' + rel)
    if (/\.manifest\.json$/.test(rel)) return json(c as Ctx, { error: 'not found' }, 404)
    if (rel !== '/' && file.startsWith(root + path.sep) && fs.existsSync(file) && fs.statSync(file).isFile()) {
      const type = TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream'
      const immutable = rel.startsWith('/assets/')
      return c.body(fs.readFileSync(file), 200, { 'content-type': type, 'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'public, max-age=300' })
    }
    if (path.extname(rel) && rel !== '/admin') return json(c as Ctx, { error: 'not found' }, 404)
    // a crawler gets the page as a file: no sandbox, no cookie, no line in the log
    if (isCrawler(c as Ctx) && !visitors.get(getCookie(c, COOKIE))) {
      return c.body(index(), 200, { 'content-type': TYPES['.html']!, 'cache-control': 'no-store', ...(rel === '/' ? {} : { 'x-robots-tag': 'noindex, nofollow' }) })
    }
    // a page: the CRM or /admin; every visitor gets their sandbox (and cookie) here
    const v = visitor(c as Ctx)
    if (v instanceof Response) return v
    // the page builds its namespace from this readable cookie (a hash, not the secret visitor id)
    if (getCookie(c, APP_COOKIE) !== v.appId) setCookie(c, APP_COOKIE, v.appId, { path: '/', sameSite: 'Lax', secure: config.secureCookie, maxAge: Math.floor(config.visitorTtlMs / 1000) })
    if (rel.replace(/\/$/, '') === '/admin') datalog.write('session', { visitor: v.hash, event: 'admin_opened' })
    return c.body(index(), 200, { 'content-type': TYPES['.html']!, 'cache-control': 'no-store' })
  })

  return app
}

/** The outcome enum of a run (docs/demo-hosting.md). `runtime_error` arrives later, from the page. */
export function outcomeOf(route: Route, r: Pick<AgentResult, 'verdict' | 'stopReason' | 'log' | 'rateLimited'>): Outcome {
  if (route === 'refuse') return 'refused_out_of_scope'
  if (route === 'cap' || route === 'busy') return 'cap_reached'
  switch (r.verdict) {
    case 'ok':
    case 'partial':
      return 'applied'
    case 'needs-backend':
      return 'needs_backend'
    case 'refused':
    case 'declined':
      return 'refused_offtopic'
    case 'not-editable':
      return 'refused_out_of_scope'
    case 'clarify':
      return 'clarify'
    case 'restore':
      return 'restore'
    default: {
      if (r.stopReason === 'timeout' || r.rateLimited) return 'timeout'
      const checks = r.log.filter((e) => e.tool === 'check' || e.tool === 'commit')
      if (checks.length && !checks[checks.length - 1]!.ok) return 'compile_error'
      return 'failed'
    }
  }
}
