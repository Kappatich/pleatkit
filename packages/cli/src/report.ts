import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { doctor, formatFindings, type DoctorOptions, type Finding } from './doctor.js'

/**
 * `pleatkit report` (C13, brainstorm 05 #21): one markdown file to attach to a bug report. The doctor's findings,
 * the versions that matter (pleatkit packages, React, Vite, TypeScript, Node, OS), the app's Vite config and the
 * pleatkit environment with every secret redacted, and a summary of the build manifest. Nothing leaves the machine:
 * the user reads the file and pastes it into the issue.
 */
export interface BugReportOptions extends Pick<DoctorOptions, 'root' | 'dist' | 'url'> {
  env?: Record<string, string | undefined>
  /** For tests: findings instead of running the doctor. */
  findings?: Finding[]
  now?: Date
  cliVersion?: string
}

/** Environment variables whose values are not secret and help to reproduce. Everything else is only "set". */
const SHOWN_ENV = new Set([
  'NODE_ENV',
  'PLEATKIT_PROVIDER',
  'PLEATKIT_MODEL',
  'PLEATKIT_CLASSIFIER_MODEL',
  'PLEATKIT_EFFORT',
  'PLEATKIT_APP_ID',
  'PLEATKIT_REGION',
  'PLEATKIT_ENVIRONMENT',
  'PLEATKIT_MODERATION',
  'PLEATKIT_TYPECHECK',
  'PLEATKIT_STREAM',
  'PLEATKIT_FALLBACKS',
  'PLEATKIT_LEARNING',
  'PLEATKIT_PLAN',
  'PLEATKIT_TELEMETRY',
  'PLEATKIT_STORE_URL',
  'PLEATKIT_BASE_URL',
  'PLEATKIT_AGENT_PORT',
  'PLEATKIT_STORE_PORT',
])
const ENV_PREFIXES = ['PLEATKIT_', 'MORPHKIT_', 'ANTHROPIC_', 'OPENAI_', 'OPENROUTER_', 'VITE_PLEATKIT']

const REDACTED = '[redacted]'

/**
 * Remove what must never be in a public issue: app keys, model API keys, JWTs, private keys, URL credentials,
 * values assigned to key/secret/token/password names, and long opaque strings.
 */
export function redact(text: string): string {
  return text
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, `-----BEGIN PRIVATE KEY----- ${REDACTED} -----END PRIVATE KEY-----`)
    .replace(/\bmk_(live|test)_[A-Za-z0-9_-]+/g, (_m, kind: string) => `mk_${kind}_${REDACTED}`)
    .replace(/\bsk-ant-[A-Za-z0-9_-]+/g, `sk-ant-${REDACTED}`)
    .replace(/\bsk-(proj-)?[A-Za-z0-9_-]{20,}/g, `sk-${REDACTED}`)
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+/g, `${REDACTED}.jwt`)
    .replace(/(\/\/)[^/\s:@]+:[^/\s@]+@/g, `$1${REDACTED}@`)
    .replace(/((?:key|secret|token|password|passwd|apiKey|api_key)["']?\s*[:=]\s*)(["'`])(?:(?!\2).)+\2/gi, `$1$2${REDACTED}$2`)
    .replace(/(?<![\w/.-])[A-Za-z0-9+/_-]{40,}={0,2}(?![\w/.-])/g, REDACTED)
}

function versionOf(root: string, name: string): string {
  let dir = path.resolve(root)
  for (;;) {
    const p = path.join(dir, 'node_modules', name, 'package.json')
    if (fs.existsSync(p)) {
      try {
        return (JSON.parse(fs.readFileSync(p, 'utf8')) as { version?: string }).version ?? '?'
      } catch {
        return '?'
      }
    }
    const up = path.dirname(dir)
    if (up === dir) return 'not installed'
    dir = up
  }
}

const PACKAGES = ['@pleatkit/runtime', '@pleatkit/ui', '@pleatkit/vite-plugin', '@pleatkit/agent', '@pleatkit/cli', 'react', 'react-dom', 'vite', 'typescript', 'tailwindcss', 'esbuild']
const CONFIG_FILES = ['vite.config.ts', 'vite.config.mts', 'vite.config.js', 'vite.config.mjs']

export async function bugReport(o: BugReportOptions): Promise<{ markdown: string; findings: Finding[] }> {
  const env = o.env ?? process.env
  const root = path.resolve(o.root)
  const findings = o.findings ?? (await doctor({ root, ...(o.dist ? { dist: o.dist } : {}), ...(o.url ? { url: o.url } : {}) }))
  const lines: string[] = [
    '## pleatkit report',
    '',
    `_Made by \`pleatkit report\` on ${(o.now ?? new Date()).toISOString()}. Keys, tokens and secrets are redacted; read it once before you paste it._`,
    '',
    '### Versions',
    '',
    '| What | Version |',
    '|---|---|',
    `| pleatkit cli | ${o.cliVersion ?? '0.1.0'} |`,
    ...PACKAGES.map((p) => `| ${p} | ${versionOf(root, p)} |`),
    `| node | ${process.version} |`,
    `| os | ${os.platform()} ${os.release()} ${os.arch()} |`,
    '',
    '### pleatkit doctor',
    '',
    '```',
    redact(formatFindings(findings, root)),
    '```',
    '',
  ]
  const config = CONFIG_FILES.map((f) => path.join(root, f)).find((f) => fs.existsSync(f))
  lines.push('### Vite config (redacted)', '')
  if (config) {
    const src = fs.readFileSync(config, 'utf8').split('\n')
    lines.push(`\`${path.basename(config)}\`${src.length > 200 ? ' (first 200 lines)' : ''}`, '', '```ts', redact(src.slice(0, 200).join('\n')), '```', '')
  } else lines.push('No vite.config.* in the app folder.', '')

  lines.push('### Environment', '')
  const names = Object.keys(env)
    .filter((k) => ENV_PREFIXES.some((p) => k.startsWith(p)) || k === 'NODE_ENV')
    .sort()
  if (!names.length) lines.push('No PLEATKIT_* variables set in this shell.')
  for (const k of names) lines.push(`- \`${k}\`: ${SHOWN_ENV.has(k) ? `\`${redact(String(env[k]))}\`` : 'set (value not shown)'}`)
  lines.push('')

  const manifestFile = path.join(path.resolve(root, o.dist ?? 'dist'), 'pleatkit.manifest.json')
  lines.push('### Build manifest', '')
  if (fs.existsSync(manifestFile)) {
    try {
      const m = JSON.parse(fs.readFileSync(manifestFile, 'utf8')) as {
        version?: number
        dynamicRoots?: string[]
        dynamic?: unknown[]
        readonly?: unknown[]
        externals?: string[]
        css?: { mode?: string }
        compile?: string
        protected?: string[]
      }
      lines.push(
        `- format ${m.version ?? '?'}; dynamic roots ${(m.dynamicRoots ?? []).join(', ') || '(none)'}`,
        `- ${m.dynamic?.length ?? 0} dynamic files, ${m.readonly?.length ?? 0} readonly files, ${m.externals?.length ?? 0} externals, ${m.protected?.length ?? 0} protected selectors`,
        `- css ${m.css?.mode ?? 'none'}${m.compile ? `, compile ${m.compile}` : ''}`,
        '',
        'The manifest has your panel sources; it is not attached. Share a panel only if the bug needs it.',
      )
    } catch (e) {
      lines.push(`Could not read ${path.relative(root, manifestFile)}: ${(e as Error).message}`)
    }
  } else lines.push(`No ${path.relative(root, manifestFile).replace(/\\/g, '/')}: run your build first if the bug is about the built app.`)
  lines.push('', '### What happened', '', '<!-- What you did, what you expected, what you saw. The time of the change (in the drawer’s history) helps us find the version. -->', '')
  return { markdown: lines.join('\n'), findings }
}
