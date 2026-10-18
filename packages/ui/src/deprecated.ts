// Names from before the rename to pleatkit (DECISIONS 68), kept for one release; removed in the next minor
// version. CHANGELOG, "Renamed".
import { PleatkitChat, type PleatkitChatProps } from './chat.js'
import { usePleatkitUiStyles } from './styles.js'

/** @deprecated Renamed to `PleatkitChat`. */
export const MorphkitChat = PleatkitChat
/** @deprecated Renamed to `PleatkitChatProps`. */
export type MorphkitChatProps = PleatkitChatProps
/** @deprecated Renamed to `usePleatkitUiStyles`. */
export const useMorphkitUiStyles = usePleatkitUiStyles
