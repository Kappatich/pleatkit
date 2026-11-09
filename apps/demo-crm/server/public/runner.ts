import { AsyncLocalStorage } from 'node:async_hooks'
import { classifierContext, emptyUsageOf, runAgent, ScriptedProvider, type AgentRunner, type ModelProvider } from './agent-api.js'
import type { AgentResult, AgentRunRequest, Classification, ClassifyInput, ModelSession, PromptParts, ToolSpec } from './agent-api.js'

/**
 * How the gateway routed one run: the recorded answers (one of the six requests), the real model (LIVE, within the
 * budget), or a fixed refusal (free text in SCRIPTED mode, the cap reached, too many live runs at once).
 */
export type Route = 'scripted' | 'live' | 'refuse' | 'cap' | 'busy'

export interface RunContext {
  route: Route
}

/** The gateway decides the route before it hands the request to the agent app; the runner reads it here. */
export const runContext = new AsyncLocalStorage<RunContext>()

export interface DemoTexts {
  refuse: string
  cap: string
  busy: string
}

export function demoTexts(contactEmail: string): DemoTexts {
  return {
    refuse: `This public demo answers the six example requests (pick one above the composer). For your own requests on your own app, ask Alex for a live pilot: ${contactEmail}`,
    cap: `Today's live requests are used up, so this demo answers only the six example requests until midnight UTC. For a live pilot on your own app, write to Alex: ${contactEmail}`,
    busy: 'The live model is busy with other visitors right now. Try again in a minute, or pick one of the six example requests.',
  }
}

function refused(req: AgentRunRequest, summary: string, runner: Pick<AgentRunner, 'name' | 'model'>): Omit<AgentResult, 'requestId'> {
  return {
    verdict: 'refused',
    refusal: 'off-topic',
    summary,
    files: {},
    deleted: [],
    log: [],
    classification: null,
    provider: runner.name,
    model: runner.model,
    usage: [],
    modelCalls: 0,
    timings: { totalMs: 0, classifyMs: null, modelMs: 0, toolsMs: 0 },
    ...(req.expectedHeadId !== undefined ? { expectedHeadId: req.expectedHeadId } : {}),
  }
}

/**
 * The agent server's runner in the demo: one agent app, three ways to answer. LIVE runs are capped at
 * `perRequestUsd` and always start with the cheap classifier (the off-topic guard): the agent loop skips the
 * classifier for a pointed-at panel or an answered question, so those get one classifier call here first.
 */
export function demoRunner(options: { scripted: ModelProvider; live: ModelProvider | null; perRequestUsd: number; texts: DemoTexts }): AgentRunner {
  const runner: AgentRunner = {
    name: 'pleatkit-demo',
    model: options.live ? `scripted+${options.live.model}` : 'scripted',
    run: async (req, runOptions = {}) => {
      const route = runContext.getStore()?.route ?? 'refuse'
      if (route === 'scripted') return runAgent(req, options.scripted, runOptions)
      if (route === 'live' && options.live) {
        const live = options.live
        if (req.target || req.clarification || req.migration) {
          const started = Date.now()
          const c = await live.classify({ request: req.request, context: classifierContext(req) }, runOptions.signal ?? new AbortController().signal)
          if (c.label === 'off-topic') {
            const usage = c.usage && c.model ? [{ model: c.model, calls: 1, ...c.usage, costUsd: null }] : []
            return { ...refused(req, offTopicText, { name: live.name, model: live.model }), classification: 'off-topic', usage, timings: { totalMs: Date.now() - started, classifyMs: Date.now() - started, modelMs: 0, toolsMs: 0 } }
          }
        }
        return runAgent(req, live, { ...runOptions, classifierMode: 'sequential', limits: { ...runOptions.limits, maxCostUsd: Math.min(options.perRequestUsd, runOptions.limits?.maxCostUsd ?? Infinity) } })
      }
      return refused(req, route === 'cap' ? options.texts.cap : route === 'busy' ? options.texts.busy : options.texts.refuse, runner)
    },
  }
  return runner
}

const offTopicText = 'I can only change how this app looks and works. Ask about the customer card, the deals or the dashboard.'

/**
 * LIVE mode without a key (local runs and the demo's tests): a stand-in for the model with made-up but priced usage,
 * so the budget, the cap fallback and the cost log behave as with Anthropic. Requests that look off-topic or like an
 * injection are refused by its "classifier"; anything else changes the customer card (a recorded panel).
 */
export class FakeLiveProvider implements ModelProvider {
  readonly name = 'fake-live'
  readonly model = 'claude-sonnet-5-5'
  readonly classifierModel = 'claude-haiku-5-5'
  private readonly inner: ScriptedProvider
  private runs = 0

  constructor(
    fixturesDir: string,
    private readonly costPerRunUsd = 0.12,
    delayMs = 0,
  ) {
    this.inner = new ScriptedProvider(
      [
        {
          name: 'fake-live-edit',
          match: ['.'],
          patterns: [/./],
          dir: fixturesDir,
          classify: { label: 'ui', reason: 'A display change.' },
          turns: [
            {
              calls: [
                { tool: 'write_file', input: { path: 'src/dynamic/customer-card.tsx' }, contentFile: '../customer-card.overdue.tsx', expect: 'ok' },
                { tool: 'check', input: {}, expect: 'ok' },
              ],
            },
            { calls: [{ tool: 'finish', input: { verdict: 'ok', summary: 'Done (fake live model): an overdue payment date now stands out in the customer card.' }, expect: 'ok' }] },
          ],
        },
      ],
      { delayMs },
    )
  }

  static readonly OFF_TOPIC = /\b(poem|joke|recipe|weather|python|javascript code|essay|translate|bitcoin)\b/i
  static readonly INJECTION = /ignore (all |the )?(previous|prior|above) instructions|system prompt|reveal your (prompt|instructions)/i

  async classify(input: ClassifyInput, _signal: AbortSignal): Promise<Classification> {
    const usage = { ...emptyUsageOf(), inputTokens: 1_500, outputTokens: 40, billedUsd: 0.002 }
    if (FakeLiveProvider.INJECTION.test(input.request)) return { label: 'off-topic', reason: '', intentLabel: 'adversarial', usage, model: this.classifierModel }
    if (FakeLiveProvider.OFF_TOPIC.test(input.request)) return { label: 'off-topic', reason: '', usage, model: this.classifierModel }
    return { label: 'ui', reason: 'A display change.', usage, model: this.classifierModel }
  }

  start(prompt: PromptParts, tools: ToolSpec[], meta: { request: string }): ModelSession {
    const session = this.inner.start(prompt, tools, meta)
    const perTurn = this.costPerRunUsd / 2
    const run = ++this.runs
    return {
      say: (text) => session.say(text),
      next: async (results, options) => {
        const turn = await session.next(results, options)
        // every run changes the file a little, so a second run is a new version and not "nothing changed"
        const note = `\n// fake live edit ${run}: ${meta.request.replace(/[\r\n*/]/g, ' ').slice(0, 80)}\n`
        const toolCalls = turn.toolCalls.map((c) => (c.name === 'write_file' && typeof c.input.content === 'string' ? { ...c, input: { ...c.input, content: c.input.content + note } } : c))
        return { ...turn, toolCalls, model: this.model, usage: { ...turn.usage, inputTokens: 9_000, outputTokens: 900, billedUsd: perTurn } }
      },
    }
  }
}
