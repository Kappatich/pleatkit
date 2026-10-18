import { isAppKey, TokenError, verifyUserToken, type UserRole } from '@pleatkit/runtime/security'

type Env = Record<string, string | undefined>

/** The app this agent server works for: its app key (server to server, bundle signing) and user-JWT secret. */
export interface AgentCredentials {
  appId: string
  appKey: string
  jwtSecret: string
}

export interface AgentAuth {
  /** Null in development without credentials: requests are trusted as sent (demo). */
  credentials: AgentCredentials | null
  production: boolean
}

/** Who a run is for, after authentication. */
export interface Identity {
  appId: string
  orgId: string
  userId: string
  environment: string | null
  via: 'jwt' | 'demo'
  /** C8: the token's role (`user` without a token); only `admin` may rebuild the wish map. */
  role?: UserRole
}

export class AgentAuthError extends Error {
  constructor(
    readonly status: 401 | 403,
    message: string,
  ) {
    super(message)
    this.name = 'AgentAuthError'
  }
}

/**
 * PLEATKIT_APP_ID (default `default`), PLEATKIT_APP_KEY (`mk_live_…`), PLEATKIT_JWT_SECRET (32+ characters).
 * With NODE_ENV=production the agent server refuses to start without them (V1 A1): it spends money on a
 * model key, so anonymous callers are never accepted there.
 */
export function agentAuthFromEnv(env: Env): AgentAuth {
  const production = env.NODE_ENV === 'production'
  const { PLEATKIT_APP_KEY: appKey, PLEATKIT_JWT_SECRET: jwtSecret } = env
  if (!appKey && !jwtSecret) {
    if (production) {
      throw new Error(
        'NODE_ENV=production: refusing to start without credentials. Set PLEATKIT_APP_ID, PLEATKIT_APP_KEY (mk_live_…) and PLEATKIT_JWT_SECRET (the secret your backend signs user tokens with).',
      )
    }
    return { credentials: null, production }
  }
  if (!isAppKey(appKey)) throw new Error('PLEATKIT_APP_KEY must look like mk_live_<24+ characters> (generate one with `pleatkit keys new`)')
  if (!jwtSecret || jwtSecret.length < 32) throw new Error('PLEATKIT_JWT_SECRET must be at least 32 characters')
  return { credentials: { appId: env.PLEATKIT_APP_ID || 'default', appKey, jwtSecret }, production }
}

/**
 * Identify the caller of `/run` and `/compile`. With credentials the browser must send the user token minted
 * by the customer's backend, and the token decides the user and the app; the body cannot claim another user.
 * Without credentials (development) the body's `userId` and `appId` are trusted.
 */
export async function identify(authorization: string | undefined, body: { userId?: string; appId?: string }, auth: AgentAuth): Promise<Identity> {
  const token = authorization && /^Bearer\s+(.+)$/i.exec(authorization.trim())?.[1]
  const creds = auth.credentials
  if (token) {
    if (!creds) throw new AgentAuthError(401, 'this agent server has no credentials configured, so it cannot verify user tokens')
    try {
      const claims = await verifyUserToken(token, creds.jwtSecret)
      if (claims.app !== creds.appId) throw new AgentAuthError(403, 'the token belongs to another app')
      if (body.userId && body.userId !== claims.sub) throw new AgentAuthError(403, 'the request is for another user than the token')
      return { appId: claims.app, orgId: claims.org ?? 'default', userId: claims.sub, environment: claims.env ?? null, via: 'jwt', role: claims.role ?? 'user' }
    } catch (e) {
      if (e instanceof TokenError) throw new AgentAuthError(401, e.message)
      throw e
    }
  }
  if (creds && (auth.production || (body.appId ?? 'default') === creds.appId)) {
    throw new AgentAuthError(401, 'authentication required: send the user token as Authorization: Bearer <token>')
  }
  // development: the body says who (a missing userId is reported by the request validation)
  return { appId: body.appId ?? 'default', orgId: 'default', userId: typeof body.userId === 'string' ? body.userId : '', environment: null, via: 'demo' }
}
