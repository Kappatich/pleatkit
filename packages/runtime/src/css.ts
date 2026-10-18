import type { CssConfig, FileMap, TailwindModule } from './types.js'

export interface CssMetrics {
  /** Time to load and initialize the Tailwind compiler, ms. Null until initialized. */
  tailwindInitMs: number | null
  lastCssMs: number | null
  lastCssBytes: number | null
}

const SPLIT = /[\s"'`;{}()<>\\]+/
const CANDIDATE = /^[!a-z@*\-[]/i

/**
 * Class candidates in source text. Tailwind ignores anything that is not a utility, so a generous split is
 * enough: `className="p-4 w-[123px]"`, `cn('a', ok && 'b')` and template literals all yield their classes.
 */
export function extractCandidates(sources: Iterable<string>): string[] {
  const out = new Set<string>()
  for (const source of sources) {
    for (const token of source.split(SPLIT)) {
      if (token.length < 2 || token.length > 120 || !CANDIDATE.test(token)) continue
      out.add(token.replace(/[,]+$/, ''))
    }
  }
  return [...out]
}

/** Compiles Tailwind 4 utilities for the classes used by dynamic code (DECISIONS item 1). */
export class CssCompiler {
  readonly mode: CssConfig['mode']
  private loaded: Promise<TailwindModule> | null = null
  readonly metrics: CssMetrics = { tailwindInitMs: null, lastCssMs: null, lastCssBytes: null }

  constructor(private readonly config: CssConfig | undefined) {
    this.mode = config?.mode === 'tailwind' && config.load ? 'tailwind' : 'palette'
  }

  /** Load the compiler (lazy chunk) and warm it up with one compile. Idempotent; no-op in palette mode. */
  init(): Promise<void> {
    if (this.mode !== 'tailwind') return Promise.resolve()
    if (!this.loaded) {
      const started = performance.now()
      this.loaded = (async () => {
        const tw = await this.config!.load!()
        await this.compile(tw)
        this.metrics.tailwindInitMs = performance.now() - started
        return tw
      })()
      this.loaded.catch(() => {
        this.loaded = null
      })
    }
    return this.loaded.then(() => undefined)
  }

  // Tailwind's build() is additive across calls, so compile afresh each time: the CSS of a snapshot then
  // depends only on its files, which keeps the bundle cache deterministic. A compile takes a few ms.
  private compile(tw: TailwindModule) {
    return tw.compile(tw.input, {
      base: '/',
      loadStylesheet: async (id, base) => {
        const content = tw.stylesheets[id]
        if (content === undefined) throw new Error(`pleatkit: stylesheet "${id}" is not available to the runtime Tailwind compiler`)
        return { path: id, base, content }
      },
      loadModule: async (id) => {
        throw new Error(`pleatkit: Tailwind plugins/configs are not supported at runtime ("${id}")`)
      },
    })
  }

  /** CSS for the utilities used in `files` (plus readonly sources, so cascade order matches Tailwind's). */
  async build(files: FileMap): Promise<string> {
    if (this.mode !== 'tailwind') return ''
    await this.init()
    const tw = await this.loaded!
    const started = performance.now()
    const compiler = await this.compile(tw)
    const sources = Object.entries(files)
      .filter(([p]) => !p.endsWith('.css'))
      .map(([, s]) => s)
    const css = compiler.build(extractCandidates([...(tw.extraSources ?? []), ...sources]))
    this.metrics.lastCssMs = performance.now() - started
    this.metrics.lastCssBytes = css.length
    return css
  }
}
