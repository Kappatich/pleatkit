import { isAppKey, safeEqual, TokenError, verifyUserToken, type UserRole } from '@pleatkit/runtime/security'

/** Secrets of one app: the server-to-server app key and the secret the customer's backend signs user tokens with. */
export interface AppCredentials {
  /** `mk_live_…` / `mk_test_…`: the agent server (and the customer's backend) authenticate with it. Also derives the bundle-signing key. */
  appKey: string
  /** HS256 secret for user tokens (at least 32 characters). */
  jwtSecret: string
}

export interface AuthOptions {
  /** Credentials per app id. Apps not listed here can only be used with demo headers (development). */
  apps?: Record<string, AppCredentials>
  /**
   * Trust `x-pleatkit-user` / `x-pleatkit-admin` / `x-pleatkit-agent` headers (the demo). Development only:
   * `createStoreApp` refuses it when `production` is set.
   */
  demoHeaders?: boolean
  /** Running with NODE_ENV=production: demo headers are never accepted. */
  production?: boolean
}

/** Who is calling, resolved from the request. */
export interface Caller {
  appId: string
  orgId: string
  /** The user whose data the call reads and writes (the user acted as when `viewer` is set). */
  userId: string | null
  /** `role === 'admin'`: may use every /admin route. */
  admin: boolean
  /**
   * `user` or `admin` in the open core (the app key is `admin`); another role only when a store extension declares it
   * (`StoreExtension.roles`, the cloud's `support`).
   */
  role: UserRole
  /**
   * Who is acting as `userId` (`x-pleatkit-act-as`), set only by a store extension's `actAs` (the cloud); null in the
   * open core. The audit chain names both ids.
   */
  viewer: string | null
  /** Server to server (the agent with the app key). */
  agent: boolean
  environment: string | null
  via: 'app-key' | 'jwt' | 'demo'
}

export class AuthError extends Error {
  constructor(
    readonly status: 401 | 403,
    message: string,
    /** Machine-readable reason in the JSON answer (`cloud-feature`: the open core does not have this). */
    readonly code?: string,
  ) {
    super(message)
    this.name = 'AuthError'
  }
}

/** The JSON `code` of a 403 for what only a store extension (the pleatkit cloud) provides: other roles, acting as a user. */
export const CLOUD_FEATURE = 'cloud-feature'

/** What the loaded store extensions add to caller resolution (DECISIONS 89). */
export interface CallerAccess {
  /** Roles beyond `user` and `admin` that an extension declares. */
  roles?: readonly string[]
  /** Acting as another user, when an extension provides it. */
  actAs?: (who: Caller, target: string) => Caller
}

type Headers = (name: string) => string | undefined

const bearer = (h: Headers): string | null => {
  const v = h('authorization')
  const m = v ? /^Bearer\s+(.+)$/i.exec(v.trim()) : null
  return m ? m[1]!.trim() : null
}

/**
 * Resolve the caller:
 * - `Authorization: Bearer mk_live_…`: the app key; full authority over that app (agent + admin). The user it
 *   acts for comes from `x-pleatkit-user`.
 * - `Authorization: Bearer <jwt>`: a user token minted by the customer's backend (`mintUserToken`); `role: admin`
 *   for /admin routes.
 * - demo headers, only when enabled and not in production.
 * A role other than `user` and `admin`, or `x-pleatkit-act-as`, is refused with 403 `cloud-feature` unless a store
 * extension provides it (`access`).
 */
export async function resolveCaller(h: Headers, auth: AuthOptions, access: CallerAccess = {}): Promise<Caller> {
  const headerApp = h('x-pleatkit-app') || null
  const token = bearer(h)
  const apps = auth.apps ?? {}
  if (token && isAppKey(token)) {
    const entry = Object.entries(apps).find(([, c]) => safeEqual(c.appKey, token))
    if (!entry) throw new AuthError(401, 'unknown app key')
    const [appId] = entry
    if (headerApp && headerApp !== appId) throw new AuthError(403, 'the app key belongs to another app')
    return {
      appId,
      orgId: h('x-pleatkit-org') || 'default',
      userId: h('x-pleatkit-user') || null,
      admin: true,
      role: 'admin',
      viewer: null,
      agent: true,
      environment: h('x-pleatkit-env') || null,
      via: 'app-key',
    }
  }
  if (token) {
    const appId = headerApp ?? appFromToken(token)
    const creds = appId ? apps[appId] : undefined
    if (!creds) throw new AuthError(401, 'no credentials are configured for this app')
    try {
      const claims = await verifyUserToken(token, creds.jwtSecret)
      if (claims.app !== appId) throw new AuthError(403, 'the token belongs to another app')
      const role = knownRole(claims.role ?? 'user', access)
      return actingAs(h, { appId, orgId: claims.org ?? 'default', userId: claims.sub, viewer: null, admin: role === 'admin', role, agent: false, environment: claims.env ?? null, via: 'jwt' }, access)
    } catch (e) {
      if (e instanceof TokenError) throw new AuthError(401, e.message)
      throw e
    }
  }
  if (auth.demoHeaders && !auth.production) {
    const appId = headerApp || 'default'
    if (apps[appId]) throw new AuthError(401, 'this app has credentials configured: send a user token or the app key')
    const role = knownRole(h('x-pleatkit-admin') === '1' ? 'admin' : h('x-pleatkit-role') || 'user', access)
    // acting as a user, the one acting is the demo user (or, without one, the role's name)
    const self = h('x-pleatkit-act-as') ? h('x-pleatkit-user') || role : h('x-pleatkit-user') || null
    return actingAs(
      h,
      { appId, orgId: h('x-pleatkit-org') || 'default', userId: self, viewer: null, admin: role === 'admin', role, agent: h('x-pleatkit-agent') === '1', environment: h('x-pleatkit-env') || null, via: 'demo' },
      access,
    )
  }
  throw new AuthError(401, 'authentication required: Authorization: Bearer <user token or app key>')
}

/** `user` and `admin`, or a role a store extension declares; anything else is a cloud feature (403). */
function knownRole(role: string, access: CallerAccess): UserRole {
  if (role === 'user' || role === 'admin' || access.roles?.includes(role)) return role
  throw new AuthError(403, `the role "${role.slice(0, 32)}" is a pleatkit cloud feature; the open store knows the roles user and admin`, CLOUD_FEATURE)
}

/** `x-pleatkit-act-as: <user>`: only through a store extension (the cloud); without one, 403 `cloud-feature`. */
function actingAs(h: Headers, who: Caller, access: CallerAccess): Caller {
  const target = h('x-pleatkit-act-as')
  if (!target) return who
  if (!access.actAs) throw new AuthError(403, 'acting as another user (x-pleatkit-act-as) is a pleatkit cloud feature', CLOUD_FEATURE)
  return access.actAs(who, target)
}

/** The `app` claim, read without verification only to pick the secret to verify with. */
function appFromToken(token: string): string | null {
  try {
    const body = token.split('.')[1] ?? ''
    const json = JSON.parse(atob(body.replace(/-/g, '+').replace(/_/g, '/'))) as { app?: unknown }
    return typeof json.app === 'string' ? json.app : null
  } catch {
    return null
  }
}

type Env = Record<string, string | undefined>

/**
 * Credentials from the environment:
 * - one app: PLEATKIT_APP_ID (default `default`), PLEATKIT_APP_KEY, PLEATKIT_JWT_SECRET;
 * - several: PLEATKIT_APPS = JSON `{ "<appId>": { "appKey": "mk_live_…", "jwtSecret": "…" } }`.
 * Throws on malformed values, so a typo never silently falls back to demo mode.
 */
export function credentialsFromEnv(env: Env): Record<string, AppCredentials> {
  const apps: Record<string, AppCredentials> = {}
  if (env.PLEATKIT_APPS) {
    let parsed: unknown
    try {
      parsed = JSON.parse(env.PLEATKIT_APPS)
    } catch {
      throw new Error('PLEATKIT_APPS must be JSON: { "<appId>": { "appKey": "mk_live_…", "jwtSecret": "…" } }')
    }
    for (const [appId, c] of Object.entries(parsed as Record<string, Partial<AppCredentials>>)) apps[appId] = { appKey: c?.appKey ?? '', jwtSecret: c?.jwtSecret ?? '' }
  }
  if (env.PLEATKIT_APP_KEY || env.PLEATKIT_JWT_SECRET) {
    apps[env.PLEATKIT_APP_ID || 'default'] = { appKey: env.PLEATKIT_APP_KEY ?? '', jwtSecret: env.PLEATKIT_JWT_SECRET ?? '' }
  }
  for (const [appId, c] of Object.entries(apps)) {
    if (!isAppKey(c.appKey)) throw new Error(`app "${appId}": the app key must look like mk_live_<24+ characters> (generate one with \`pleatkit keys new\`)`)
    if (!c.jwtSecret || c.jwtSecret.length < 32) throw new Error(`app "${appId}": the user-JWT secret must be at least 32 characters`)
  }
  return apps
}

/**
 * Auth settings for a server process. With NODE_ENV=production the server refuses to start unless every app
 * it serves has an app key and a user-JWT secret (V1 A1): demo headers would let anyone write any user's code.
 */
export function authFromEnv(env: Env): AuthOptions {
  const production = env.NODE_ENV === 'production'
  const apps = credentialsFromEnv(env)
  if (production && Object.keys(apps).length === 0) {
    throw new Error(
      'NODE_ENV=production: refusing to start without credentials. Set PLEATKIT_APP_KEY (mk_live_…, server to server) and ' +
        'PLEATKIT_JWT_SECRET (HS256 secret for user tokens, 32+ characters), or PLEATKIT_APPS for several apps. Demo headers are disabled in production.',
    )
  }
  return { apps, production, demoHeaders: !production && env.PLEATKIT_DEMO_HEADERS !== '0' }
}
