import * as esbuild from 'esbuild'
import { staticCheck as sharedStaticCheck, type CheckContext, type CompileError, type FileMap, type StaticCheckOptions, type TransformFn } from '@pleatkit/runtime/compiler'

// The static rules live in @pleatkit/runtime (`check`), so the browser and the agent server run the same code
// (code review 06 item 12). This wrapper supplies native esbuild for the TypeScript strip.
export { cssRules, type StaticRule, type CheckContext as StaticContext } from '@pleatkit/runtime/compiler'

const transform: TransformFn = (source, options) => esbuild.transform(source, options)

/** The shared static rules with native esbuild (scripts, CSS, protected elements, default exports). */
export function staticCheck(files: FileMap, ctx: CheckContext, options: StaticCheckOptions = {}): Promise<CompileError[]> {
  return sharedStaticCheck(files, ctx, transform, options)
}
