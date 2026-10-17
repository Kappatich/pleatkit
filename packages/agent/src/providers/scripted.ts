import fs from 'node:fs'
import path from 'node:path'
import type { RequestClass, TokenUsage } from '@morphkit/runtime/compiler'
import { emptyUsage } from '../pricing.js'
import type { Classification, ClassifyInput, ModelProvider, ModelSession, ModelTurn, PromptParts, ToolResult, TurnOptions } from '../types.js'

/**
 * A scripted conversation: the provider replays the tool calls of each turn instead of asking a model, so the
 * whole pipeline (tools, check, limits, log, SSE, browser commit) runs in tests and demos without network.
 */
export interface ScriptFixture {
  name: string
  description?: string
  /** Case-insensitive regular expressions; the first fixture with a matching one is used. */
  match: string[]
  classify?: { label: RequestClass; reason?: string; question?: string; options?: string[] }
  turns: ScriptTurn[]
}

export interface ScriptTurn {
  text?: string
  delayMs?: number
  /** Simulated token usage of this turn (tests of the output budget). */
  usage?: Partial<TokenUsage>
  calls: ScriptCall[]
}

export interface ScriptCall {
  tool: string
  input?: Record<string, unknown>
  /** Load `input.content` from this file (relative to the fixture). */
  contentFile?: string
  /** Assert the tool result, so a fixture fails loudly when the pipeline behaves differently. */
  expect?: 'ok' | 'error'
}

interface LoadedFixture extends ScriptFixture {
  dir: string
  patterns: RegExp[]
}

export function loadFixtures(dir: string): LoadedFixture[] {
  if (!fs.existsSync(dir)) return []
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => {
      const fx = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) as ScriptFixture
      return { ...fx, dir, patterns: fx.match.map((m) => new RegExp(m, 'i')) }
    })
}

export class ScriptedProvider implements ModelProvider {
  readonly name = 'scripted'
  readonly model = 'scripted'
  private readonly fixtures: LoadedFixture[]

  /**
   * @param pace extra delay before every scripted answer (classifier and each turn), so a recorded demo
   *   shows the progress lines at a readable speed. 0 in tests.
   */
  constructor(
    fixturesOrDir: string | LoadedFixture[],
    private readonly pace: { delayMs?: number } = {},
  ) {
    this.fixtures = typeof fixturesOrDir === 'string' ? loadFixtures(fixturesOrDir) : fixturesOrDir
  }

  find(request: string): LoadedFixture | null {
    return this.fixtures.find((f) => f.patterns.some((p) => p.test(request))) ?? null
  }

  async classify(input: ClassifyInput, signal?: AbortSignal): Promise<Classification> {
    if (this.pace.delayMs && signal) await delay(this.pace.delayMs, signal)
    const fx = this.find(input.request)
    const c = fx?.classify
    return {
      label: c?.label ?? 'ui',
      reason: c?.reason ?? '',
      ...(c?.question && c.options ? { question: c.question, options: c.options } : {}),
      usage: emptyUsage(),
      model: 'scripted-classifier',
    }
  }

  /** What each scripted run received besides text: a model would see the images, the script only notes them. */
  readonly received: { request: string; images: number; targetDom: boolean }[] = []

  start(prompt: Pick<PromptParts, 'images' | 'user'>, _tools: unknown, meta: { request: string }): ModelSession {
    this.received.push({ request: meta.request, images: prompt.images?.length ?? 0, targetDom: prompt.user.includes('<panel_dom') })
    if (this.received.length > 50) this.received.shift()
    const fx = this.find(meta.request)
    const turns: ScriptTurn[] = fx
      ? fx.turns
      : [
          {
            calls: [
              {
                tool: 'finish',
                input: {
                  verdict: 'failed',
                  summary: 'The demo runs without a model key (scripted provider) and has no recorded answer for this request. Set MORPHKIT_API_KEY to use a real model.',
                },
              },
            ],
          },
        ]
    let i = 0
    let expected: (ScriptCall['expect'] | undefined)[] = []
    let ids = 0
    return {
      say: () => undefined,
      next: async (results: ToolResult[], options: TurnOptions): Promise<ModelTurn> => {
        results.forEach((r, k) => {
          const want = expected[k]
          if (want && (want === 'ok') !== r.ok) {
            throw new Error(`scripted fixture "${fx?.name}": turn ${i} call ${k + 1} expected ${want}, got ${r.ok ? 'ok' : 'error'}: ${r.content.slice(0, 300)}`)
          }
        })
        const turn = turns[i++]
        if (!turn) return { text: '', toolCalls: [], stop: 'end_turn', usage: emptyUsage(), model: this.model }
        const wait = (turn.delayMs ?? 0) + (this.pace.delayMs ?? 0)
        if (wait) await delay(wait, options.signal)
        expected = turn.calls.map((c) => c.expect)
        const toolCalls = turn.calls.map((c) => {
          const input = { ...(c.input ?? {}) }
          if (c.contentFile) input.content = fs.readFileSync(path.join(fx!.dir, c.contentFile), 'utf8')
          return { id: `scripted_${++ids}`, name: c.tool, input }
        })
        return { text: turn.text ?? '', toolCalls, stop: 'tool_use', usage: { ...emptyUsage(), ...turn.usage }, model: fx ? `scripted:${fx.name}` : 'scripted' }
      },
    }
  }
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms)
    signal.addEventListener('abort', () => {
      clearTimeout(t)
      reject(signal.reason as Error)
    })
  })
}
