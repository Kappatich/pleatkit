// `@morphkit/runtime/compiler`: the React-free part of the runtime, safe to import in Node.
// The agent server uses it to check code with exactly the same virtual-fs and externals as the browser.
export { Compiler, toCompileErrors, virtualFsPlugin, entrySource, isScript } from './compiler.js'
export type { CompilerMetrics, CompilerOptions, EsbuildApi, CompileContext } from './compiler.js'
export { resolveSpecifier, matchesExternal, applyAlias, loaderFor } from './vfs.js'
export { hashFiles, ulid } from './util.js'
export { extractCandidates } from './css.js'
export type * from './types.js'
export type * from './protocol.js'
