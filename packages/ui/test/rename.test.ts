import { describe, expect, it } from 'vitest'
import * as ui from '../src/index.js'

describe('deprecated aliases from @pleatkit/ui (DECISIONS 68)', () => {
  it('each old name is the very same value as its new name', () => {
    expect(ui.MorphkitChat).toBe(ui.PleatkitChat)
    expect(ui.useMorphkitUiStyles).toBe(ui.usePleatkitUiStyles)
    const props: ui.MorphkitChatProps = { agentUrl: '/agent' } as ui.MorphkitChatProps
    const same: ui.PleatkitChatProps = props
    expect(same).toBe(props)
  })
})
