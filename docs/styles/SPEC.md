# Style gallery spec (for the five research agents)

Product: morphkit. An AI agent rewrites the React UI panels a developer allows, per user, with undo, history and an admin dashboard. Surfaces that need a visual language: a chat drawer inside a customer's app ("ask for a change"), a version history, an admin dashboard with requests/diffs, a landing page.

Goal: 20 genuinely different design directions per agent, 100 total. Minte's rule: NOT the same layout in different colours, NOT different palettes over the same card/button set. Each direction must bring its OWN components, taken from a real non-AI visual tradition (print, instruments, software history, cartography/engineering, graphic design movements). They must still fit a developer-facing B2B product: readable, usable, not a joke.

Hard bans (these read as "AI-made" in 2026): purple/violet gradients, glassmorphism, glow, blur, rounded 12–16px cards with soft shadows, Inter / Space Grotesk / Instrument Serif / Plus Jakarta, sparkles/stars icons, robot illustrations, warm beige paper + serif + orange (Anthropic), navy + yellow highlighter + expanded grotesk (our rejected v2), three-column feature cards with icons, hero with centered headline + two pill buttons.

## Output

Write ONE file: `styles-<LETTER>.json` (the letter is given in your task) in the directory given in your task. JSON array of 20 objects:

```json
{
  "id": "a07",                       // letter + two digits
  "name": "Solari departure board",
  "family": "instruments",           // one of: paper, instruments, software, engineering, graphic
  "origin": "Split-flap airport boards (Solari di Udine, 1956)",
  "why_not_ai": "one sentence: which concrete conventions make it look hand-made/historical rather than generated",
  "fits": "one sentence: why it suits an agent that edits a live app with versions and undo",
  "palette": ["#0b0b0b", "#f2f2f0", "#ffcc00"],   // 3–5 hex values, named roles in `roles`
  "roles": { "bg": "#0b0b0b", "fg": "#f2f2f0", "accent": "#ffcc00" },
  "type": { "display": "Oswald", "body": "IBM Plex Sans", "mono": "IBM Plex Mono" },   // Google Fonts names or system stacks; never the banned ones
  "fonts": ["Oswald:wght@500;700", "IBM+Plex+Mono:wght@400;600"],  // Google Fonts families to load for this tile, may be []
  "components": ["flap row", "stamp badge", "ticket-stub version", "dial budget"],      // the style-specific component names used in the html
  "html": "<div class=\"tile s-a07\"> ... </div>"
}
```

## HTML rules for `html`

- Root: `<div class="tile s-<id>">` containing a `<style>` whose EVERY rule is prefixed with `.s-<id> ` (scoping). No global selectors, no `body`, no `*`. No external scripts. No images except inline SVG you write yourself (small). No `<link>` tags (fonts are declared in `fonts`).
- Fixed tile width is set by the gallery (360px); make the content fit at 360px wide, any height up to ~560px. Use `font-size` 11–15px.
- The tile must show, in that style's own vocabulary (not a generic card):
  1. a header strip with the product name "morphkit" and a zone/panel label (e.g. "customer-card.tsx · dynamic"),
  2. a customer panel with 3 fields (Email hank@globex.example · City Springfield · Next payment Oct 11, 2026 overdue) where "overdue" is visually marked,
  3. a user request line: "Add phone and city; overdue in red",
  4. three progress lines (Reading the card · Changing the fields · Checking the build) with the last one in a "done" state,
  5. a version indicator showing v0, v1, v2 with v2 current,
  6. a primary action ("Apply") and a secondary ("Undo"),
  7. a status badge "Applied" and a "Needs admin" variant somewhere.
- Every one of those seven must be rendered through a component that belongs to the style (examples: perforated ticket stubs for versions; a split-flap row for progress; a rubber-stamp for status; a ledger line with ruled columns for fields; a receipt tape; a punch card; a library catalog card; a Solari board; a car odometer; an oscilloscope trace; a subway line with stations as versions; a Palm OS list; a Norton Commander two-pane; a seed packet; a patent figure with reference numerals). Reusing the same visual component across two of your styles is a failure.
- Colours only from the style's palette. Text must be readable (contrast ≥ 4.5:1 for body text).
- Keep each `html` under 6,000 characters. Valid HTML, properly escaped inside JSON.

## Distinctness checklist (self-check before writing the file)

For each pair of your 20 styles: different structural idea (not just palette), different type pairing, at least 3 of the 7 required parts rendered with different component metaphors. Different families should be visibly different at thumbnail size.

Do NOT call any `mcp__hearthbot__*` tools. Do not modify any other files. When done, reply with the file path and a 20-line list "id · name · one component you are proudest of".
