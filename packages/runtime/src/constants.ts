/** Global accessor the compiled bundle uses to reach host modules. Set up by `installExternals`. */
export const EXTERNALS_GLOBAL = '__morphkit'

/**
 * Version of the code that turns a snapshot into a bundle: esbuild (the same pinned version in the browser
 * and on the agent server, V1 B6), the bundle format and the externals shim. Part of every bundle key (F4).
 */
export const ESBUILD_VERSION = '0.28.2'
export const BUNDLE_FORMAT = 3
export const COMPILER_VERSION = `esbuild@${ESBUILD_VERSION}+f${BUNDLE_FORMAT}`
