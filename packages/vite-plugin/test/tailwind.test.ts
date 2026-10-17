import { describe, expect, it } from 'vitest'
import { extractTailwindBlocks } from '../src/tailwind.js'

describe('extractTailwindBlocks', () => {
  it('keeps @theme, @utility and @custom-variant, drops everything else', () => {
    const css = `@import "tailwindcss" source(none);
@source "./";
@source inline("{text,bg}-red-{500,600}");
/* @theme in a comment { --x: 1 } */
@custom-variant dark (&:where(.dark, .dark *));
@theme inline {
  --color-card: var(--card);
  --font-display: "Inter", sans-serif; /* { brace in comment */
}
:root { --card: oklch(1 0 0); }
body { @apply bg-background; }
@layer base { h1 { @apply text-2xl; } }
@utility content-auto { content-visibility: auto; }
@media (min-width: 640px) { .x { color: red } }`
    const blocks = extractTailwindBlocks(css)
    expect(blocks).toHaveLength(3)
    expect(blocks[0]).toBe('@custom-variant dark (&:where(.dark, .dark *));')
    expect(blocks[1]).toMatch(/^@theme inline \{[\s\S]*--font-display: "Inter", sans-serif;[\s\S]*\}$/)
    expect(blocks[2]).toBe('@utility content-auto { content-visibility: auto; }')
    expect(blocks.join('\n')).not.toContain('@source')
    expect(blocks.join('\n')).not.toContain('@apply')
  })
})
