// Environment variable names after the rename (DECISIONS 68): `PLEATKIT_*` is the name; the old `MORPHKIT_*`
// names are read as a fallback for one release, with one deprecation line. Pure: the caller passes the env
// object (`process.env` on Node), so this file stays free of Node APIs.

export type EnvMap = Record<string, string | undefined>

export const ENV_PREFIX = 'PLEATKIT_'
/** @deprecated The pre-rename prefix; read as a fallback until the next release. */
export const LEGACY_ENV_PREFIX = 'MORPHKIT_'

const warnedFor = new WeakMap<object, Set<string>>()

/**
 * Fill every unset `PLEATKIT_X` from a legacy `MORPHKIT_X` in `env` (in place, so child processes inherit the
 * new names) and print one line naming the legacy variables. `PLEATKIT_X` wins when both are set. Idempotent;
 * each legacy name is reported once per env object. Returns `env` for chaining:
 * `configFromEnv(pleatkitEnv(process.env))`.
 */
export function pleatkitEnv<T extends EnvMap>(env: T, warn: (line: string) => void = (line) => console.warn(line)): T {
  const legacy: string[] = []
  for (const name of Object.keys(env)) {
    if (!name.startsWith(LEGACY_ENV_PREFIX)) continue
    const value = env[name]
    if (value === undefined) continue
    const current = ENV_PREFIX + name.slice(LEGACY_ENV_PREFIX.length)
    if (env[current] === undefined) (env as EnvMap)[current] = value
    legacy.push(name)
  }
  if (!legacy.length) return env
  let seen = warnedFor.get(env)
  if (!seen) warnedFor.set(env, (seen = new Set()))
  const fresh = legacy.filter((name) => !seen.has(name))
  if (fresh.length) {
    for (const name of fresh) seen.add(name)
    warn(
      `[pleatkit] deprecated environment variable${fresh.length > 1 ? 's' : ''} ${fresh.join(', ')}: rename to ${ENV_PREFIX}* ` +
        `(the ${LEGACY_ENV_PREFIX}* fallback is removed in the next release)`,
    )
  }
  return env
}
