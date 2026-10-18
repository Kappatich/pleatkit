// Names from before the rename to pleatkit (DECISIONS 68), kept for one release. Each is the very same value or
// type as its pleatkit name; they are removed in the next minor version. CHANGELOG, "Renamed".
import { PLEATKIT_FRAME } from './compiler.js'
import { PleatkitEngine } from './engine.js'
import { PleatkitProvider, usePleatkit, usePleatkitState, usePleatkitTags, type PleatkitProviderProps } from './react.js'
import type { PleatkitConfig, PleatkitManifest } from './types.js'
import { PleatkitUiRoot } from './ui-root.js'

/** @deprecated Renamed to `PleatkitEngine`. */
export const MorphkitEngine = PleatkitEngine
/** @deprecated Renamed to `PleatkitEngine`. */
export type MorphkitEngine = PleatkitEngine
/** @deprecated Renamed to `PleatkitProvider`. */
export const MorphkitProvider = PleatkitProvider
/** @deprecated Renamed to `PleatkitProviderProps`. */
export type MorphkitProviderProps = PleatkitProviderProps
/** @deprecated Renamed to `usePleatkit`. */
export const useMorphkit = usePleatkit
/** @deprecated Renamed to `usePleatkitState`. */
export const useMorphkitState = usePleatkitState
/** @deprecated Renamed to `usePleatkitTags`. */
export const useMorphkitTags = usePleatkitTags
/** @deprecated Renamed to `PleatkitUiRoot`. */
export const MorphkitUiRoot = PleatkitUiRoot
/** @deprecated Renamed to `PLEATKIT_FRAME`. */
export const MORPHKIT_FRAME = PLEATKIT_FRAME
/** @deprecated Renamed to `PleatkitManifest`. */
export type MorphkitManifest = PleatkitManifest
/** @deprecated Renamed to `PleatkitConfig`. */
export type MorphkitConfig = PleatkitConfig
