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
    name: 'edit_file',
    description:
      'Change part of a dynamic file: old_str must occur exactly once in it and is replaced by new_str. Cheaper than write_file for a small change in a large file. Use write_file for new files.',
    input_schema: obj({
      path: { type: 'string', description: 'Path inside the dynamic zone' },
      old_str: { type: 'string', description: 'Exact text to replace, with enough context to be unique' },
      new_str: { type: 'string', description: 'The replacement' },
    }),
  },
  {
    name: 'check',
    description:
      'Compile the whole dynamic zone exactly like the browser will (esbuild, same externals), verify that every panel still has a default export, and run the static rules (no eval or new Function, no document.cookie, no dangerouslySetInnerHTML or innerHTML, network requests only to relative URLs of this app, no import() of URLs, imports only from the allowed modules). Returns errors as file:line:column text.',
    input_schema: obj({}),
  },
  {
    name: 'finish',
    description:
      'End the task. "ok": your changes are ready (finish re-runs check and refuses while it fails). "partial": the screen part is done and checked, the rest needs the server (say what in backend_note). "needs-backend": it needs server or data changes; write no code. "not-editable": it is about a part of the screen that is not open for changes (outside the dynamic zone, not a server matter). "declined": you will not do it (harmful, deceptive, against the app\'s rules). "clarify": two readings would give clearly different results; ask one question with 2 to 4 short options (only once per edit). "failed": you cannot do it.',
    input_schema: obj({
      summary: { type: 'string', description: 'One or two plain-language sentences for the user, in their language; no code or file names' },
      verdict: { type: 'string', enum: ['ok', 'partial', 'needs-backend', 'not-editable', 'declined', 'clarify', 'failed'] },
      backend_note: { type: 'string', description: 'For partial and needs-backend: what the server would need, for the administrator; otherwise empty' },
      question: { type: 'string', description: 'For clarify: the one question; otherwise empty' },
      options: { type: 'array', items: { type: 'string' }, description: 'For clarify: 2 to 4 short answers; otherwise empty' },
    }),
  },
]

export interface Finish {
  verdict: AgentVerdict
  summary: string
  backendNote?: string
  clarify?: { question: string; options: string[] }
}

const VERDICTS = ['ok', 'partial', 'needs-backend', 'not-editable', 'declined', 'clarify', 'failed'] as const
/** Verdicts whose files are applied: the code must pass check. */
const WITH_CODE = new Set(['ok', 'partial'])

/** Executes tool calls against the workspace, records the tool log and notices `finish`. */
export class ToolRunner {
  readonly log: ToolLogEntry[] = []
  finished: Finish | null = null
  violations = 0
  /** Files were written since the last check (the loop checks automatically at the end of the turn). */
  wroteSinceCheck = false

  /** The user already answered this edit's one clarifying question. */
  clarified = false

  constructor(
    private readonly ws: Workspace,
    private readonly onEvent: (entry: ToolLogEntry, call: ToolCall) => void,
  ) {}

  /** Record a call that was not run (cut off by max_tokens). */
  note(call: ToolCall, turn: number, why: string): void {
    const entry: ToolLogEntry = { turn, tool: call.name, input: logInput(call), ok: false, result: why, ms: 0, violation: 'output cut off (max_tokens)' }
    this.log.push(entry)
    this.onEvent(entry, call)
  }

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
    // static-rule violations found by check (or by the check finish runs) are logged as violations too
    const ruleHits = call.name === 'check' || call.name === 'finish' ? (this.ws.lastCheck?.errors ?? []).filter((e) => e.rule) : []
    if (ruleHits.length && !violation) {
      violation = `static check: ${[...new Set(ruleHits.map((e) => e.rule))].join(', ')}`
      this.violations++
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
    return { id: call.id, ok, content: capResult(content) }
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
        this.wroteSinceCheck = true
        return `Wrote ${path} (${content.length} chars).`
      }
      case 'edit_file': {
        const path = str('path')
        const oldStr = str('old_str')
        const newStr = str('new_str')
        if (!this.ws.isWritable(path)) this.ws.write(path, '') // throws the zone error with its explanation
        const current = this.ws.zoneOf(path) === 'dynamic' ? this.ws.read(path) : null
        if (current === null) throw new Error(`No such dynamic file: ${path}. Use write_file to create it.`)
        if (!oldStr) throw new Error('old_str is empty; use write_file to replace a whole file')
        const count = current.split(oldStr).length - 1
        if (count !== 1) {
          const near = nearestLines(current, oldStr)
          throw new Error(count === 0 ? `old_str was not found in ${path}.${near}` : `old_str occurs ${count} times in ${path}; add surrounding lines so it is unique.`)
        }
        this.ws.write(path, current.replace(oldStr, () => newStr))
        this.wroteSinceCheck = true
        return `Edited ${path}.`
      }
      case 'check': {
        this.wroteSinceCheck = false
        return checkText(await this.ws.check())
      }
      case 'finish': {
        const verdict = str('verdict') as Finish['verdict']
        const summary = str('summary').trim()
        if (!(VERDICTS as readonly string[]).includes(verdict)) throw new Error(`Unknown verdict "${verdict}"`)
        const opt = (k: string) => (typeof input[k] === 'string' ? (input[k] as string).trim() : '')
        if (verdict === 'clarify') {
          if (this.clarified) throw new Error('The user already answered your one question for this edit. Do not ask again: do your best with the answer.')
          const options = Array.isArray(input.options) ? (input.options as unknown[]).filter((o): o is string => typeof o === 'string' && o.trim() !== '').slice(0, 4) : []
          if (!opt('question') || options.length < 2) throw new Error('clarify needs a question and 2 to 4 options')
          this.finished = { verdict, summary: opt('question'), clarify: { question: opt('question').slice(0, 300), options: options.map((o) => o.slice(0, 80)) } }
          return 'Finished.'
        }
        if (WITH_CODE.has(verdict) && this.ws.changed && this.ws.needsCheck) await this.ws.check()
        if (WITH_CODE.has(verdict) && this.ws.changed && !this.ws.lastCheck?.ok) {
          // The commit is refused, exactly as the browser would refuse it; the model gets the errors and fixes them.
          throw new Error(`Commit rejected, the code does not pass check:\n${formatErrors(this.ws.lastCheck?.errors ?? [])}\nFix the errors, then call finish again.`)
        }
        if (verdict === 'partial' && !this.ws.changed) throw new Error('partial means some of it is done on screen, but nothing was changed; use needs-backend')
        this.finished = { verdict, summary: summary || defaultSummary(verdict), ...(opt('backend_note') ? { backendNote: opt('backend_note').slice(0, 1000) } : {}) }
        return 'Finished.'
      }
      default:
        throw new Error(`Unknown tool "${call.name}"`)
    }
  }
}

/** Longest tool result returned to the model (code review 06 item 10): a huge file or error list must not flood the context. */
export const MAX_TOOL_RESULT_CHARS = 24_000

export function capResult(content: string): string {
  if (content.length <= MAX_TOOL_RESULT_CHARS) return content
  return `${content.slice(0, MAX_TOOL_RESULT_CHARS)}
… [cut: ${content.length - MAX_TOOL_RESULT_CHARS} more characters of ${content.length}. Work with the part shown; edit_file changes a part of a file without rewriting it.]`
}

function defaultSummary(v: Finish['verdict']): string {
  switch (v) {
    case 'ok':
      return 'Done.'
    case 'partial':
      return 'I did the part that is on the screen; the rest needs a change on the server, so I passed it to the administrator.'
    case 'needs-backend':
      return 'This needs a change on the server; I passed it to the administrator.'
    case 'not-editable':
      return 'This part of the screen cannot be changed here.'
    case 'declined':
      return 'I will not make this change.'
    default:
      return 'I could not make this change.'
  }
}

/** The check result as the model reads it. */
export function checkText(r: { ok: boolean; errors: Parameters<typeof formatErrors>[0]; timeMs: number }): string {
  return r.ok ? `OK: the dynamic zone compiles, follows the rules and every panel has a default export (${r.timeMs.toFixed(0)} ms).` : `FAILED:\n${formatErrors(r.errors)}`
}

/** For an edit_file miss: the line of the file that shares the most words with old_str, with 3 lines around it. */
function nearestLines(source: string, needle: string): string {
  const lines = source.split('\n')
  const words = new Set(needle.split(/\W+/).filter((w) => w.length > 2))
  let best = -1
  let score = 0
  lines.forEach((l, i) => {
    const s = l.split(/\W+/).filter((w) => words.has(w)).length
    if (s > score) [best, score] = [i, s]
  })
  if (best < 0) return ''
  const from = Math.max(0, best - 3)
  return ` Closest lines (${from + 1}-${Math.min(lines.length, best + 4)}):\n${lines.slice(from, best + 4).join('\n')}`
}

/** Keep logs small: file contents are replaced by their size. */
function logInput(call: ToolCall): Record<string, unknown> {
  if (call.name === 'edit_file') {
    const { old_str, new_str, ...rest } = call.input
    return { ...rest, oldBytes: typeof old_str === 'string' ? old_str.length : 0, newBytes: typeof new_str === 'string' ? new_str.length : 0 }
  }
  if (call.name === 'write_file') {
    const { content, ...rest } = call.input
    return { ...rest, bytes: typeof content === 'string' ? content.length : 0 }
  }
  return call.input
}
