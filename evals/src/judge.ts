import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import Anthropic from '@anthropic-ai/sdk'
import { costUsd } from '@pleatkit/agent'
import type { PleatkitManifest } from '@pleatkit/runtime/compiler'
import type { GraderResult, JudgeResult } from './types.js'

/**
 * The visual-quality judge (DECISIONS 75 Р3, 80, brainstorm 16 part 2 item 2): deterministic pre-checks on the "after"
 * render fail fast; otherwise a small model scores the before/after pair per criterion against a rubric (the app's
 * design system, no layout breakage, the change is what was asked, nothing unrelated changed). 1 to 5 per criterion
 * and overall; overall >= 4 is "a designer would accept it". It answers what pass/fail graders cannot: whether a
 * passing edit is also fit to ship.
 */
export const JUDGE_MODEL = 'claude-haiku-5-5'
export const JUDGE_THRESHOLD = 4
export const JUDGE_CRITERIA = ['design_system', 'no_breakage', 'did_what_asked', 'nothing_unrelated'] as const
export type JudgeCriterion = (typeof JUDGE_CRITERIA)[number]

const RUBRIC_FILE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'rubrics', 'visual.md')
export const loadRubric = (): string => fs.readFileSync(RUBRIC_FILE, 'utf8')

const score = { type: 'integer', enum: [1, 2, 3, 4, 5] } as const
const SCHEMA = {
  type: 'object',
  properties: { design_system: score, no_breakage: score, did_what_asked: score, nothing_unrelated: score, overall: score, reason: { type: 'string' } },
  required: ['design_system', 'no_breakage', 'did_what_asked', 'nothing_unrelated', 'overall', 'reason'],
  additionalProperties: false,
} as const

export interface JudgeInput {
  /** What the user asked for. */
  request: string
  /** The app's design-system digest and notes (`manifest.designSystem`), trimmed. */
  designSystem?: string
  /** PNG screenshots of the panel before and after the change. */
  before: Buffer
  after: Buffer
  /** DECISIONS 80: deterministic problems found on the "after" render; when any, the model is not called. */
  preCheck?: string[]
}

export type Judge = (input: JudgeInput, signal?: AbortSignal) => Promise<JudgeResult>

export interface JudgeOptions {
  apiKey: string
  baseURL?: string
  model?: string
  /** Thinking effort (default medium: at low the judge missed a subtle bold change in one of two runs). */
  effort?: 'low' | 'medium' | 'high'
  /** For tests: a fetch that never reaches the network. */
  fetch?: typeof fetch
}

/** The design system as the judge reads it: the digest (components and variants) and the app's notes, at most 4,000 characters. */
export function designSystemOf(m: Pick<PleatkitManifest, 'designSystem'> | null | undefined): string | undefined {
  const ds = m?.designSystem
  if (!ds) return undefined
  const text = [ds.docs?.trim(), ds.digest.trim()].filter(Boolean).join('\n\n')
  return text.length > 4000 ? `${text.slice(0, 4000)}\n…` : text
}

/** A judge result built from the deterministic pre-checks alone (the model was not called). */
function preCheckFailure(problems: string[], model: string): JudgeResult {
  // breakage is what the pre-checks catch; the other criteria are unknown, scored 1 so overall is 1 and not accepted
  return { score: 1, accept: false, reason: `pre-check failed: ${problems.join('; ')}`.slice(0, 400), model, costUsd: 0, criteria: { design_system: 1, no_breakage: 1, did_what_asked: 1, nothing_unrelated: 1 }, preCheck: problems }
}

export function createJudge(o: JudgeOptions): Judge {
  const client = new Anthropic({ apiKey: o.apiKey, ...(o.baseURL ? { baseURL: o.baseURL } : {}), ...(o.fetch ? { fetch: o.fetch } : {}), maxRetries: 2 })
  const model = o.model ?? JUDGE_MODEL
  const effort = o.effort ?? 'medium'
  const rubric = loadRubric()
  return async (input, signal) => {
    if (input.preCheck?.length) return preCheckFailure(input.preCheck, model)
    const image = (b: Buffer) => ({ type: 'image' as const, source: { type: 'base64' as const, media_type: 'image/png' as const, data: b.toString('base64') } })
    const msg = await client.messages.create(
      {
        model,
        max_tokens: 1024,
        output_config: { effort, format: { type: 'json_schema', schema: SCHEMA } },
        system: [{ type: 'text', text: rubric, cache_control: { type: 'ephemeral' } }],
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: `<design_system>\n${input.designSystem ?? '(not documented)'}\n</design_system>\n\n<user_request>\n${input.request}\n</user_request>\n\nScore each criterion and the overall per the rubric.\n\nBEFORE:` },
              image(input.before),
              { type: 'text', text: 'AFTER:' },
              image(input.after),
            ],
          },
        ],
      },
      signal ? { signal } : {},
    )
    const usage = { inputTokens: msg.usage.input_tokens, outputTokens: msg.usage.output_tokens, cacheReadTokens: msg.usage.cache_read_input_tokens ?? 0, cacheWriteTokens: msg.usage.cache_creation_input_tokens ?? 0 }
    const cost = costUsd(msg.model, usage) ?? costUsd(model, usage) ?? 0
    const text = msg.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('')
    let overall = 0
    let reason = msg.stop_reason === 'refusal' ? 'the judge refused to answer' : 'the judge gave no readable answer'
    let criteria: JudgeResult['criteria']
    try {
      const p = JSON.parse(text) as Record<string, unknown>
      const read = (k: string) => (typeof p[k] === 'number' && (p[k] as number) >= 1 && (p[k] as number) <= 5 ? Math.round(p[k] as number) : 0)
      criteria = { design_system: read('design_system'), no_breakage: read('no_breakage'), did_what_asked: read('did_what_asked'), nothing_unrelated: read('nothing_unrelated') }
      overall = read('overall')
      if (typeof p.reason === 'string' && p.reason.trim()) reason = p.reason.trim()
    } catch {
      // overall stays 0: shown as "no score", never accepted
    }
    return { score: overall, accept: overall >= JUDGE_THRESHOLD, reason, model: msg.model, costUsd: cost, ...(criteria ? { criteria } : {}) }
  }
}

/** The judge's verdict as a grader row: advisory, so a low score shows in its own column and never fails the run. */
export function judgeGrader(j: JudgeResult | null, why?: string): GraderResult {
  if (!j) return { grader: 'judge', pass: true, skipped: true, advisory: true, reason: why ?? 'not judged' }
  const crit = j.criteria ? ` [${JUDGE_CRITERIA.map((c) => `${c.split('_').map((w) => w[0]).join('')}${j.criteria![c]}`).join(' ')}]` : ''
  return { grader: 'judge', pass: j.accept, advisory: true, reason: `${j.score || 'no score'}/5${crit}: ${j.reason}` }
}

export const readShot = (file: string): Buffer | null => (fs.existsSync(file) ? fs.readFileSync(file) : null)
