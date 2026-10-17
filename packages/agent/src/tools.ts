import type { AgentVerdict, ToolLogEntry } from '@morphkit/runtime/compiler'
import type { ToolCall, ToolResult, ToolSpec } from './types.js'
import { formatErrors, Workspace, ZoneError } from './workspace.js'

const obj = (properties: Record<string, unknown>): ToolSpec['input_schema'] => ({
  type: 'object',
  properties,
  required: Object.keys(properties),
  additionalProperties: false,
})

export const TOOLS: ToolSpec[] = [
  {
    name: 'list_files',
    description: 'List every file you can see, with its zone (dynamic = writable, readonly, core types) and size.',
    input_schema: obj({}),
  },
  {
    name: 'read_file',
    description: 'Read a file from the dynamic zone, the readonly zone, or a core .d.ts.',
    input_schema: obj({ path: { type: 'string', description: 'Project-relative path, e.g. src/dynamic/customer-card.tsx' } }),
  },
  {
    name: 'write_file',
    description:
      'Create or replace a file in the dynamic zone with its complete new content (not a diff). Writes outside the dynamic zone are refused and logged as violations.',
    input_schema: obj({
      path: { type: 'string', description: 'Path inside the dynamic zone' },
      content: { type: 'string', description: 'The whole file' },
    }),
  },
  {
    name: 'check',
    description:
      'Compile the whole dynamic zone exactly like the browser will (esbuild, same externals) and verify that every panel still has a default export. Returns errors as file:line:column text.',
    input_schema: obj({}),
  },
  {
    name: 'finish',
    description:
      'End the task. verdict "ok": your changes are ready (finish re-runs check and refuses while it fails). "needs-backend": the request needs server or data changes outside the dynamic zone; write no code and explain in one sentence. "failed": you cannot do it.',
    input_schema: obj({
      summary: { type: 'string', description: 'One or two plain-language sentences for the user, in their language; no code or file names' },
      verdict: { type: 'string', enum: ['ok', 'needs-backend', 'failed'] },
    }),
  },
]

export interface Finish {
  verdict: Exclude<AgentVerdict, 'clarify'>
  summary: string
}

/** Executes tool calls against the workspace, records the tool log and notices `finish`. */
export class ToolRunner {
  readonly log: ToolLogEntry[] = []
  finished: Finish | null = null
  violations = 0

  constructor(
    private readonly ws: Workspace,
    private readonly onEvent: (entry: ToolLogEntry, call: ToolCall) => void,
  ) {}

  async run(call: ToolCall, turn: number): Promise<ToolResult> {
    const started = performance.now()
    let ok = true
    let content: string
    let violation: string | undefined
    try {
      content = await this.exec(call)
    } catch (e) {
      ok = false
      content = (e as Error).message
      if (e instanceof ZoneError) {
        violation = content
        this.violations++
      }
    }
    const entry: ToolLogEntry = {
      turn,
      tool: call.name,
      input: logInput(call),
      ok,
      result: content.length > 600 && ok ? `${content.slice(0, 600)}… (${content.length} chars)` : content,
      ms: Math.round(performance.now() - started),
      ...(violation ? { violation } : {}),
    }
    this.log.push(entry)
    this.onEvent(entry, call)
    return { id: call.id, ok, content }
  }

  private async exec(call: ToolCall): Promise<string> {
    const input = call.input
    const str = (key: string): string => {
      const v = input[key]
      if (typeof v !== 'string') throw new Error(`"${key}" must be a string`)
      return v
    }
    switch (call.name) {
      case 'list_files':
        return JSON.stringify(this.ws.list(), null, 1)
      case 'read_file':
        return this.ws.read(str('path'))
      case 'write_file': {
        const path = str('path')
        const content = str('content')
        this.ws.write(path, content)
        return `Wrote ${path} (${content.length} chars). Run check before finishing.`
      }
      case 'check': {
        const r = await this.ws.check()
        return r.ok ? `OK: the dynamic zone compiles and every panel has a default export (${r.timeMs.toFixed(0)} ms).` : `FAILED:\n${formatErrors(r.errors)}`
      }
      case 'finish': {
        const verdict = str('verdict') as Finish['verdict']
        const summary = str('summary').trim()
        if (!['ok', 'needs-backend', 'failed'].includes(verdict)) throw new Error(`Unknown verdict "${verdict}"`)
        if (verdict === 'ok' && this.ws.changed && this.ws.needsCheck) await this.ws.check()
        if (verdict === 'ok' && this.ws.changed && !this.ws.lastCheck?.ok) {
          // The commit is refused, exactly as the browser would refuse it; the model gets the errors and fixes them.
          throw new Error(`Commit rejected, the code does not pass check:\n${formatErrors(this.ws.lastCheck?.errors ?? [])}\nFix the errors, then call finish again.`)
        }
        this.finished = { verdict, summary: summary || defaultSummary(verdict) }
        return 'Finished.'
      }
      default:
        throw new Error(`Unknown tool "${call.name}"`)
    }
  }
}

function defaultSummary(v: Finish['verdict']): string {
  return v === 'ok' ? 'Done.' : v === 'needs-backend' ? 'This needs a change on the server; I passed it to the administrator.' : 'I could not make this change.'
}

/** Keep logs small: file contents are replaced by their size. */
function logInput(call: ToolCall): Record<string, unknown> {
  if (call.name === 'write_file') {
    const { content, ...rest } = call.input
    return { ...rest, bytes: typeof content === 'string' ? content.length : 0 }
  }
  return call.input
}
