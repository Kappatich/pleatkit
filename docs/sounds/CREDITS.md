# Demo film sound credits

The demo film (`docs/demo.mp4`, `site/demo.mp4`) is mixed by `scripts/record-demo.mjs` from the samples in
`apps/demo-crm/e2e/sounds/`. Every sample comes from a third-party pack under CC0 or CC BY 4.0. Each one was
changed for the film: decoded with ffmpeg, made mono 48 kHz 16-bit WAV, trimmed to its onset, cut short with a
fade-out and set to the same average loudness as the others. The mixer then changes its level again for each kind of
event.

| File | Event | Source file | Pack | Author | License |
|---|---|---|---|---|---|
| `key-1.wav` | typed character | `Single Keys/keypress-004.wav` | [Keyboard Soundpack #1](https://opengameart.org/content/keyboard-soundpack-1-typing-and-single-keystrokes) (OpenGameArt) | unicaegames | [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/) |
| `key-2.wav` | typed character | `Single Keys/keypress-006.wav` | same | unicaegames | CC0 1.0 |
| `key-3.wav` | typed character | `Single Keys/keypress-013.wav` | same | unicaegames | CC0 1.0 |
| `key-4.wav` | typed character | `Single Keys/keypress-017.wav` | same | unicaegames | CC0 1.0 |
| `key-5.wav` | typed character | `Single Keys/keypress-019.wav` | same | unicaegames | CC0 1.0 |
| `click-1.wav` | pointer click | `Audio/click5.ogg` | [UI Audio](https://kenney.nl/assets/ui-audio) | Kenney (kenney.nl) | [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/) |
| `drawer-1.wav` | the drawer opens | `Audio/switch_007.ogg` | [Interface Sounds](https://kenney.nl/assets/interface-sounds) | Kenney (kenney.nl) | CC0 1.0 |
| `applied-1.wav` | the change lands | `wav/01 Hero Sounds/hero_simple-celebration-01.wav` | [Material Design product sounds](https://m2.material.io/design/sound/sound-resources.html) | Google | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) |
| `band-1.wav` | title band | `wav/03 Primary System Sounds/navigation_backward-selection.wav` | Material Design product sounds | Google | CC BY 4.0 |
| `whoosh-1.wav` | camera move | `wav/04 Secondary System Sounds/navigation_transition-left.wav` | Material Design product sounds | Google | CC BY 4.0 |
| `close-1.wav` | closing card | `wav/01 Hero Sounds/hero_simple-celebration-03.wav` | Material Design product sounds | Google | CC BY 4.0 |
| `close-2.wav` | the low drop under the closing card | `Audio/impactSoft_heavy_000.ogg` | [Impact Sounds](https://kenney.nl/assets/impact-sounds) | Kenney (kenney.nl) | CC0 1.0 |
| `thud-1.wav` | area plate appears | `Audio/impactSoft_medium_001.ogg` | Impact Sounds | Kenney (kenney.nl) | CC0 1.0 |

## Attribution (CC BY 4.0)

`applied-1.wav`, `band-1.wav`, `whoosh-1.wav` and `close-1.wav`, and the demo film that contains them:

> Sounds from the Material Design product sounds by Google
> (https://m2.material.io/design/sound/sound-resources.html), licensed under CC BY 4.0
> (https://creativecommons.org/licenses/by/4.0/). Changed: trimmed, faded, converted to mono 48 kHz and
> level-adjusted.

The Material sounds were published as
`https://storage.googleapis.com/material-design/downloads/material_product_sounds.zip` with the line "Available
under CC-BY 4.0" on the sound resources page. That URL now answers 403; the zip was taken from the Internet
Archive's copy of it (snapshot 2019-11-18, `web.archive.org/web/20191118135809/...material_product_sounds.zip`),
the one linked from the archived page.

## CC0

The Kenney and unicaegames sounds are public domain (CC0); no attribution is required. Credit, as both authors ask:
sounds by Kenney (www.kenney.nl) and by unicaegames (Keyboard Soundpack #1, recorded on a Cherry KC 1000).
