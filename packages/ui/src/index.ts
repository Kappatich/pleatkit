export { PleatkitChat, type PleatkitChatProps } from './chat.js'
export { ElementPicker, panelAt, panelRect } from './picker.js'
export { callAgent, readSse, AgentRequestError, type SseMessage } from './sse.js'
export { usePleatkitUiStyles } from './styles.js'
// pre-rename names, one release (DECISIONS 68)
export { translator, detectLocale, UI_MESSAGES, type UiKey, type Translate } from './i18n.js'
export { addStep, visibleSteps, MAX_VISIBLE_STEPS, type Step } from './steps.js'
export { panelDomSnapshot, prepareImage, addImages, imageFiles, MAX_IMAGE_SIDE, type PendingImage } from './attachments.js'
