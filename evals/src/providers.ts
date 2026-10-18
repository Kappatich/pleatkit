import fs from 'node:fs'
import path from 'node:path'
import { loadFixtures, ReplayProvider, ScriptedProvider } from '@pleatkit/agent'
import type { Classification, ModelProvider, ModelSession, ModelTurn, ToolCall } from '@pleatkit/agent'
import type { FileMap, TokenUsage } from '@pleatkit/runtime/compiler'
import { FIXTURE_DIRS, RECORDINGS_DIR, readRefs } from './tasks.js'
import type { EvalTask } from './types.js'

const zero = (): TokenUsage => ({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 })

/**
 * An agent that knows the task's expected answer (sanity check, brainstorm 04 §8 item 9). The classifier gives the
 * label the expected verdict needs; the main loop writes the reference files (`write: true`, the reference agent)
 * or nothing at all (`write: false`, the null agent), then finishes with the expected verdict. The null agent keeps
 * the right verdict on purpose: it proves the graders look at the code, not only at the verdict.
 */
export function oracleProvider(task: EvalTask, o: { write: boolean }): ModelProvider {
  const v = task.expected.verdict
  const files: FileMap = o.write && task.reference ? readRefs(task.reference.files) : {}
  const model = o.write ? 'reference' : 'null'
  return {
    name: model,
    model,
    async classify(): Promise<Classification> {
      const base = { usage: zero(), model: 'oracle-classifier' }
      if (v === 'refused') return { ...base, label: 'off-topic', reason: '' }
      if (v === 'needs-backend') return { ...base, label: 'needs-backend', reason: 'This needs a change on the server, so it went to the administrator.' }
      if (v === 'clarify') return { ...base, label: 'unclear', reason: 'Two readings are possible.', question: 'Which part do you mean?', options: ['The first one', 'The second one'] }
      return { ...base, label: 'ui', reason: '' }
    },
    start(): ModelSession {
      const calls: ToolCall[] = Object.entries(files).map(([p, content], i) => ({ id: `oracle_w${i}`, name: 'write_file', input: { path: p, content } }))
      // `partial` needs a change; the null agent writes none, so it claims `ok` instead
      const verdict = !o.write && v === 'partial' ? 'ok' : v === 'refused' ? 'declined' : v
      calls.push({ id: 'oracle_finish', name: 'finish', input: { verdict, summary: task.locale === 'ru' ? 'Готово.' : 'Done.', ...(v === 'partial' ? { backend_note: 'The server part is described for the administrator.' } : {}), ...(v === 'clarify' ? { question: 'Which part do you mean?', options: ['The first one', 'The second one'] } : {}) } })
      let done = false
      return {
        say: () => undefined,
        next: async (): Promise<ModelTurn> => {
          if (done) return { text: '', toolCalls: [], stop: 'end_turn', usage: zero(), model }
          done = true
          return { text: '', toolCalls: calls, stop: 'tool_use', usage: zero(), model }
        },
      }
    },
  }
}

export const recordingFile = (taskId: string, dir = RECORDINGS_DIR): string => path.join(dir, `${taskId}.jsonl`)

/** The task's recorded transcript, replayed without a model. */
export function replayProvider(task: EvalTask, dir = RECORDINGS_DIR): ReplayProvider {
  const file = recordingFile(task.id, dir)
  if (!fs.existsSync(file)) throw new Error(`No recording for task ${task.id} (${path.basename(file)}): run "pnpm eval:record" to produce it.`)
  return new ReplayProvider(file)
}

/** The scripted fixture that plays the agent for this task's offline recording, matched by name, not by text. */
export function scriptedProvider(task: EvalTask, dirs = FIXTURE_DIRS): ScriptedProvider {
  const name = task.record?.fixture
  if (!name) throw new Error(`Task ${task.id} has no record.fixture: it cannot be recorded offline.`)
  const fx = dirs.flatMap((d) => loadFixtures(d)).find((f) => f.name === name)
  if (!fx) throw new Error(`Task ${task.id}: no scripted fixture named "${name}" in ${dirs.join(', ')}`)
  return new ScriptedProvider([{ ...fx, patterns: [/[\s\S]*/] }])
}
