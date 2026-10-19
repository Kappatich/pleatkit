import fs from 'node:fs'
import path from 'node:path'

/** The apps `pnpm eval:classify` knows (`APP_IDS` in evals/src/apps.ts): a probe is classified against one's data contract. */
export const EVAL_APPS = ['demo-crm', 'shadcn-admin', 'tailadmin'] as const
/**
 * The labels of the /admin Labels screen; `eval:classify` scores each (clarify → unclear, declined → adversarial, mixed → ui,
 * restore → restore: DECISIONS 84.2).
 */
export const PROBE_LABELS = ['ui', 'needs-backend', 'clarify', 'off-topic', 'declined', 'mixed', 'restore'] as const
export const DEFAULT_LABELS_OUT = path.join('evals', 'probes', 'human-disagreements.json')

export interface LabelsExportOptions {
  /** store-server base URL, e.g. http://localhost:8790 */
  store: string
  /** The store's app id. */
  app: string
  /** The eval app the probes run against; default `app` when it is one of EVAL_APPS. */
  evalApp?: string
  /** Every human label, not only the disagreements with the classifier. */
  all?: boolean
  /** App key (`mk_live_…`) or an admin user token. Without one, the development admin header is sent. */
  key?: string
  /** Output file. Default evals/probes/human-disagreements.json (relative to the current directory). */
  out?: string
  fetch?: typeof fetch
  cwd?: string
  now?: Date
}

interface ExportItem {
  requestId: string
  request: string
  label: string
  suggested: string | null
  labeledBy: string
  labeledAt: string
}

export interface Probe {
  id: string
  app: string
  request: string
  expected: string
  suggested: string | null
  labeledBy: string
  labeledAt: string
}

/** Probe ids: the request id, plus the labeller when several people labelled the same request. */
export function toProbes(items: ExportItem[], evalApp: string): Probe[] {
  const per = new Map<string, number>()
  for (const i of items) per.set(i.requestId, (per.get(i.requestId) ?? 0) + 1)
  return items
    .filter((i) => (PROBE_LABELS as readonly string[]).includes(i.label) && i.request.trim())
    .map((i) => ({
      id: `human-${i.requestId}${(per.get(i.requestId) ?? 0) > 1 ? `-${i.labeledBy.replace(/[^\w.-]/g, '_')}` : ''}`,
      app: evalApp,
      request: i.request,
      expected: i.label,
      suggested: i.suggested,
      labeledBy: i.labeledBy,
      labeledAt: i.labeledAt,
    }))
}

/**
 * `pleatkit labels export` (DECISIONS 81): the requests people labelled on the /admin Labels screen where they disagreed
 * with the classifier (`--all`: every label), as a probes file for `pnpm eval:classify -- --probes <file>`.
 */
export async function labelsExport(o: LabelsExportOptions): Promise<{ ok: boolean; lines: string[]; file?: string; probes?: Probe[] }> {
  const evalApp = o.evalApp ?? o.app
  if (!(EVAL_APPS as readonly string[]).includes(evalApp)) {
    return {
      ok: false,
      lines: [
        o.evalApp
          ? `--eval-app "${o.evalApp}" is not an eval app: use one of ${EVAL_APPS.join(', ')}`
          : `app "${o.app}" is not an eval app (${EVAL_APPS.join(', ')}): pass --eval-app <id>, the eval app whose screens these requests were made on`,
      ],
    }
  }
  const base = o.store.replace(/\/$/, '').replace(/\/v1$/, '')
  const url = `${base}/v1/admin/labels/export?filter=${o.all ? 'all' : 'disagreements'}`
  const headers: Record<string, string> = { 'x-pleatkit-app': o.app, ...(o.key ? { authorization: `Bearer ${o.key}` } : { 'x-pleatkit-admin': '1' }) }
  let res: Response
  try {
    res = await (o.fetch ?? globalThis.fetch)(url, { headers })
  } catch (e) {
    return { ok: false, lines: [`could not reach store-server at ${base}: ${(e as Error).message}`] }
  }
  if (!res.ok) return { ok: false, lines: [`store-server answered ${res.status}: ${(await res.text()).slice(0, 300)}`, ...(res.status === 401 ? ['set PLEATKIT_APP_KEY (or pass --key) for a production store'] : [])] }
  const body = (await res.json()) as { items?: ExportItem[] }
  const probes = toProbes(body.items ?? [], evalApp)
  const what = o.all ? 'labels' : 'disagreements with the classifier'
  if (probes.length === 0) return { ok: true, probes, lines: [`no ${what} in app ${o.app} yet: nothing written`] }
  const day = (o.now ?? new Date()).toISOString().slice(0, 10)
  const doc = {
    description: `DECISIONS 81: requests labelled by people on the /admin Labels screen of app "${o.app}" (${o.all ? 'every label' : 'only where the person disagreed with the classifier'}), exported ${day} with \`pleatkit labels export\`. expected is the person's label, suggested the classifier's. Run: pnpm eval:classify -- --probes <this file>.`,
    probes,
  }
  const file = path.resolve(o.cwd ?? process.cwd(), o.out ?? DEFAULT_LABELS_OUT)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(doc, null, 2) + '\n')
  return { ok: true, file, probes, lines: [`exported ${probes.length} ${what} of app ${o.app} as ${evalApp} probes`, `-> ${file}`, `run: pnpm eval:classify -- --probes ${path.relative(o.cwd ?? process.cwd(), file).replace(/\\/g, '/')}`] }
}
