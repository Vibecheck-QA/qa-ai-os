---
name: design
description: Set up and enforce the repo's design guidelines — find what the repo already has (tokens, colours, dark mode, classes), agree a short DESIGN.md with the user, and turn every rule that a script can check into a push gate (text contrast in every mode, banned patterns like light-grey text), leaving AI review only for the rules no script can check. Use when the user says "design guidelines", "design system", "DESIGN.md", "check contrast", "enforce our design", or a UI review keeps finding the same style mistakes.
---

# QA AI OS — design

Goal: the repo ends with (1) a short `DESIGN.md` written from **this repo and
this user**, never from someone else's rules, and (2) every rule a script can
check running as a push gate. Ask before every write.

Economics (QUALITY.md §0): a rule a script can check never goes to an AI. A
rule nothing checks is a wish. Keep it to **at most 3 review-only rules**;
past that, nobody, human or model, holds them all in mind.

## 1. Read what exists (before asking anything)
- An existing `DESIGN.md`, style guide, brand doc, or `docs/design*`.
- **Token source:** CSS custom properties (`globals.css`, `index.css`, `app.css`,
  a Tailwind v4 `@theme` block), a token file (`*tokens*.json/ts`), or
  `tailwind.config.*` `theme.extend.colors`.
- **Mode mechanism:** a `.dark` class, `[data-theme=…]`, or
  `@media (prefers-color-scheme: dark)`. Note the exact selectors.
- **What the code actually does:** grep the UI files for the usual offenders:
  light-grey text classes (`text-(gray|slate|zinc|neutral|stone)-[1-4]00`),
  low text opacity (`opacity-[1-5]0`, `/[1-5]0` modifiers), raw hex colours in
  components. Count them; that's the size of the cleanup.

## 2. Ask (one message, skip what the repo answered)
1. Who uses this, and where? (bright rooms, older eyes, phones in the sun → stricter contrast)
2. Light, dark, or both?
3. The brand colour(s) and anything about the look that must not change.
4. Any rule you already hold? (e.g. "no grey text", "one accent colour", fonts)

## 3. Draft DESIGN.md (short: under ~80 lines)
Each rule gets a **Check** column: `contrast`, `banned`, or `review`. Offer
these as candidates; the user picks and edits:

| Rule | Check |
|---|---|
| All readable text meets WCAG AA (4.5:1; 3:1 for large text and UI borders) in every mode | `contrast` |
| No light-grey text classes in light mode | `banned` |
| Components use tokens, not raw hex | `banned` (when tokens exist) |
| Text never below N% opacity | `banned` |
| One primary action colour per screen; layout/spacing rules | `review` |

Lead with the rule and a ✅/❌ example; no essays. Show the draft, write on
approval.

## 4. Configure the checks
Add a `design` section to `.qa-ai-os.json`:

```json
"design": {
  "tokens": { "css": ["app/globals.css"] },
  "modes": { "light": [":root"], "dark": [":root", ".dark"] },
  "minContrast": 4.5,
  "pairs": [
    { "text": "foreground", "on": "background" },
    { "text": "muted-foreground", "on": "card", "alpha": 0.8 },
    { "text": "border", "on": "background", "min": 3 }
  ],
  "banned": [
    { "pattern": "\\btext-(gray|slate|zinc|neutral)-[1-4]00\\b",
      "paths": ["app/**/*.tsx", "components/**/*.tsx"],
      "why": "DESIGN.md rule 2: no light grey text" }
  ]
}
```

- **Modes** list the CSS blocks merged in order, later wins: dark = `:root`
  then `.dark`, exactly how the browser cascades them. Nest with `>`:
  `"@media (prefers-color-scheme: dark) > :root"`. `@layer` is not a nesting
  level, but it ranks like the browser: unlayered beats layered, a later
  declared layer beats an earlier one, then the list order. `!important` on a
  token stops the check (exit 2). A pair's `modes`, if set, must be a
  non-empty list. Or use `"tokens": { "json": "tokens.json" }` (`{mode: {name: colour}}`).
- **Pairs:** every `X-foreground` on `X`, and every text token on every
  surface the app puts text on (background, card, popover, muted…). Set
  `alpha` to the faintest opacity the code applies to that text.
- **No tokens at all** (raw Tailwind palette classes everywhere)? Use `banned`
  only, and offer extracting tokens as its own change later. Not now.
- Colours: hex, `rgb()`, `hsl()`, `oklch()`, `oklab()`, bare `R G B` /
  `H S% L%` triplets, `var()` chains. Anything else is reported as UNKNOWN
  (exit 2), never passed.

## 5. Install the gate
Copy `${CLAUDE_PLUGIN_ROOT}/scripts/design-check.js` to
`scripts/qa-design-check.js` in the repo (vendored, like AGENTS.md, so CI and
other agents run the same check without the plugin). Add it first in the gates,
since it takes about a second:

```json
{ "name": "design", "run": "node scripts/qa-design-check.js", "timeoutSeconds": 60 }
```

Needs Node 18+. Exit 0 pass, 1 a rule failed (names the pair/mode/ratio or
file:line), 2 could not check.

## 6. Prove it is honest
1. **Run it on the current commit.** Red means existing violations. Show the
   count, then let the user choose for each rule: fix now (its own change),
   narrow `paths`, or mark a real exception on the line with
   `design-allow: <reason>` (reported on every run). Never weaken a threshold
   to get green.
2. **Prove it can fail:** with approval, lighten one light-mode text token
   (or add a banned class to a scratch file), run it, confirm exit 1, restore
   from a byte copy, and confirm green. A design gate that can't fail protects
   nothing.

## 7. Review-only rules ride the existing review
No extra AI call for design. When a diff touches UI files, `/qa-ai-os:review`
adds the `review` rules from DESIGN.md to the **same** diff round: "Also check
the UI changes against these rules only: <rules>. Contrast and banned patterns
are already checked by script; don't re-check them."

## 8. Report
What is enforced by script now, what is review-only, the cleanup count from
step 6.1, and the files written.
