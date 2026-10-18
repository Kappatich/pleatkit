import fs from 'node:fs'
import path from 'node:path'
import { PROMPT_VERSION } from '../prompt.js'
import type { Classification, ClassifyInput, ModelProvider, ModelSession, ModelTurn, PromptParts, ToolResult, ToolSpec, TurnOptions } from '../types.js'
import type { ClusterInput, ClusterOutput } from '../wishes.js'

/**
 * Full transcripts of model runs (brainstorm 04 §6, §8 items 2 and 11). `RecordingProvider` wraps any provider and
 * writes one JSONL file per run: the prompt parts, every turn's tool results as sent and the model's answer with
 * the complete tool inputs (file contents included, unlike the request log), usage, stop reason and timing, the
 * prompt version and the model. `ReplayProvider` plays such a file back without a model: a recorded live run
 * becomes a deterministic regression test (`pnpm eval:replay`, `pnpm eval:pin`).
 */
export type TranscriptLine =
  | { kind: 'meta'; runId: string; promptVersion: string; provider: string; model: string; at: string; taskId?: string; trial?: number }
  | { kind: 'classify'; input: ClassifyInput; output: Omit<Classification, 'usage'> & { usage: Classification['usage'] }; ms: number }
  | { kind: 'start'; prompt: Omit<PromptParts, 'images'> & { images: number }; tools: string[]; request: string }
  | { kind: 'turn'; index: number; results: ToolResult[]; turn: ModelTurn; ms: number; maxOutputTokens: number }
  | { kind: 'say'; text: string }
  | { kind: 'cluster'; input: ClusterInput; output: ClusterOutput; ms: number }

export interface RecordingOptions {
  /** Directory of transcripts; one `<runId>.jsonl` per run. */
  dir: string
  /** Labels of the eval harness. */
  taskId?: string
  trial?: number
}

let seq = 0
const newRunId = () => `${new Date().toISOString().replace(/[:.]/g, '-')}-${process.pid}-${++seq}`

export class RecordingProvider implements ModelProvider {
  readonly name: string
  readonly model: string
  /** Transcript files written so far, newest last. */
  readonly files: string[] = []
  private current: string | null = null

  constructor(
    private readonly inner: ModelProvider,
    private readonly o: RecordingOptions,
  ) {
    this.name = inner.name
    this.model = inner.model
    fs.mkdirSync(o.dir, { recursive: true })
  }

  private open(): string {
    const runId = newRunId()
    const file = path.join(this.o.dir, `${runId}.jsonl`)
    this.files.push(file)
    this.current = file
    this.write({ kind: 'meta', runId, promptVersion: PROMPT_VERSION, provider: this.inner.name, model: this.inner.model, at: new Date().toISOString(), ...(this.o.taskId ? { taskId: this.o.taskId } : {}), ...(this.o.trial !== undefined ? { trial: this.o.trial } : {}) })
    return file
  }

  private write(line: TranscriptLine, file = this.current): void {
    if (file) fs.appendFileSync(file, JSON.stringify(line) + '\n')
  }

  async classify(input: ClassifyInput, signal: AbortSignal): Promise<Classification> {
    const file = this.open()
    const started = performance.now()
    const output = await this.inner.classify(input, signal)
    this.write({ kind: 'classify', input, output, ms: Math.round(performance.now() - started) }, file)
    return output
  }

  /** C9: the clustering call of the wish-list map gets a transcript of its own. */
  async cluster(input: ClusterInput, signal: AbortSignal): Promise<ClusterOutput> {
    if (!this.inner.cluster) return { clusters: [], usage: null, model: null }
    const file = this.open()
    const started = performance.now()
    const output = await this.inner.cluster(input, signal)
    this.write({ kind: 'cluster', input, output, ms: Math.round(performance.now() - started) }, file)
    this.current = null
    return output
  }

  start(prompt: PromptParts, tools: ToolSpec[], meta: { request: string }): ModelSession {
    // a run without the classifier (target, clarification, migration) starts its own file
    const file = this.current && fs.existsSync(this.current) && !fs.readFileSync(this.current, 'utf8').includes('"kind":"start"') ? this.current : this.open()
    const { images, ...rest } = prompt
    this.write({ kind: 'start', prompt: { ...rest, images: images?.length ?? 0 }, tools: tools.map((t) => t.name), request: meta.request }, file)
    const session = this.inner.start(prompt, tools, meta)
    let index = 0
    return {
      say: (text) => {
        this.write({ kind: 'say', text }, file)
        session.say(text)
      },
      next: async (results: ToolResult[], options: TurnOptions) => {
        const started = performance.now()
        const turn = await session.next(results, options)
        this.write({ kind: 'turn', index: index++, results, turn, ms: Math.round(performance.now() - started), maxOutputTokens: options.maxOutputTokens }, file)
        return turn
      },
    }
  }
}

export function readTranscript(file: string): TranscriptLine[] {
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as TranscriptLine)
}

/** Plays a recorded transcript back: the same classification and the same model answers, in order. */
export class ReplayProvider implements ModelProvider {
  readonly name = 'replay'
  readonly model: string
  private readonly lines: TranscriptLine[]

  constructor(fileOrLines: string | TranscriptLine[]) {
    this.lines = typeof fileOrLines === 'string' ? readTranscript(fileOrLines) : fileOrLines
    const meta = this.lines.find((l) => l.kind === 'meta')
    this.model = meta && meta.kind === 'meta' ? `replay:${meta.model}` : 'replay'
  }

  async classify(): Promise<Classification> {
    const c = this.lines.find((l) => l.kind === 'classify')
    if (!c || c.kind !== 'classify') return { label: 'ui', reason: '', usage: null, model: null }
    return c.output
  }

  /** The recorded clustering answer of a wish-list map transcript. */
  async cluster(): Promise<ClusterOutput> {
    const c = this.lines.find((l) => l.kind === 'cluster')
    return c && c.kind === 'cluster' ? c.output : { clusters: [], usage: null, model: null }
  }

  start(): ModelSession {
    const turns = this.lines.flatMap((l) => (l.kind === 'turn' ? [l.turn] : []))
    let i = 0
    return {
      say: () => undefined,
      next: async () => turns[i++] ?? { text: '', toolCalls: [], stop: 'end_turn', usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, model: this.model },
    }
  }
}
