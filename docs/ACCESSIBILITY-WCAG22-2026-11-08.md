# Accessibility pass — WCAG 2.2 AA, 8 November 2026

Target: `https://shinzora.vercel.app/` (marketing site and the public pages around it).
Source of the findings: the 271-item audit supplied by the owner. The work below keeps that audit's numbering, names the root cause of each group, and records the exact fix and how it was verified in a real browser.

## Result

| Measure | Before | After |
| --- | --- | --- |
| axe-core nodes on `/` (WCAG 2.0/2.1/2.2 A + AA + best practice) | 20 (8 critical, 10 serious, 2 moderate) | **0** |
| axe-core nodes on the other public routes (`/auth/login`, `/auth/signup`, `/admin-login`, `/legal/*`, `/download`, `/docs`, `/system-check`, `/install-guide`, `/onboarding`, `/offline`, `/app`, `/admin`) | 20 | **0** |
| Text below 12px on the homepage | 79 nodes | **0** |
| Horizontal scrolling at 320px | none | none |
| Horizontal scrolling at 200% text | 1475px of content in a 1280px window | **none** (1270px) |
| Looping animation without a user-controlled stop | 6 animations | 0 (footer switch) |

Reproduce it (needs `npm i --no-save axe-core playwright-core` once):

```
node scripts/dev-server.mjs &
node scripts/a11y-audit.mjs          # axe, exits non-zero on critical or serious
node scripts/a11y-behaviour.mjs      # accordion, reflow, text size, focus
node scripts/a11y-controls.mjs       # motion switch, install dialog, skip link, label-in-name
```

---

## The 271 findings, by root cause

### #1–8 — Critical, 4.1.2 Name, Role, Value (8 items)

**Finding.** `aria-expanded` reports an invalid or unsupported state on eight FAQ items.

**Root cause.** The attribute sat on the wrapper `div.faq-item[data-acc-item]`. A plain `div` has no supported `aria-expanded`, so the announcement was dropped and the state never reached assistive technology. The panel itself had no `id`, the trigger no `aria-controls`, and a closed panel was only collapsed to `max-height: 0` — still in the accessibility tree, still reachable with the Tab key, and its text still read out.

**Fix.**
- `public/index.html` — `aria-expanded` removed from the eight wrapper divs.
- `public/js/ui/reveal.js` — `initAccordion()` now owns the state on the `<button>`: it assigns `aria-controls` and a stable panel `id`, sets `hidden` on closed panels, keeps one panel open at a time, and toggles a `is-open` class for the icon rotation.
- `public/css/marketing-sections.css` — `.faq-item[aria-expanded="true"] .faq-icon` became `.faq-item.is-open .faq-icon`; added `.faq-panel[hidden] { display: none }`.

**Verified.** `scripts/a11y-behaviour.mjs`: all panels start hidden at zero height, every `aria-controls` resolves to its own panel, a click opens panel 1 (82px tall, `aria-expanded="true"`), Enter on a focused trigger opens panel 2, opening 2 closes and re-hides 1, untouched panels stay out of layout.

### #9–18 — Critical, 1.4.3 Contrast (10 items)

**Finding.** Small labels and body copy fall below 4.5:1.

**Root cause.** Two design tokens were below the threshold on the site's own surfaces: `--text-3: #7b7490` measured 4.45–4.48:1 on `#0a090e`/`#0b0a0f`, and `--text-4: #57516b` measured 2.62:1. Every failing element inherited one of them, so per-element overrides would only have moved the problem.

**Fix.** `public/css/tokens.css`:
- `--text-3: #8b84a0` → 5.58:1 on `#0a090e`, 5.30:1 on `#12101a`
- `--text-4: #837c99` → 5.02:1 on `#0a090e`, 4.76:1 on `#12101a`

Both were measured against all four page surfaces (`#0a090e`, `#0b0a0f`, `#0e0d12`, `#12101a`) and keep the two visible steps of hierarchy (`--text-2` is still lighter than `--text-3`, which is still lighter than `--text-4`).

**Verified.** axe `color-contrast` went from 10 nodes on `/` to 0, and the same rule is clean on every other public route.

### #19 — Serious, 2.5.3 Label in Name

**Finding.** The account button's visible text ("AS") is not part of its accessible name.

**Root cause.** `public/js/boot/site-auth.js` rendered `aria-label="Account menu for Aditya Sharma"` while the button showed only the initials. Voice-control users cannot say what they see.

**Fix.** The template now reads `aria-label="${initials} — account menu for ${name}"`, so the visible initials lead the accessible name.

**Verified.** `scripts/a11y-controls.mjs` asserts the template contains `initials(who)`, then runs axe's `label-content-name-mismatch` against that exact markup: 0 violations.

### #20–21 — Moderate, 1.3.1 / heading order

**Finding.** `<h4>` used where the hierarchy had no `<h3>`, and heading levels skipped.

**Root cause.** The showcase points sat at `h4` directly under an `h2`, and the three footer column labels were `h4` too.

**Fix.** The four showcase points are now `<h3>` (`public/css/marketing.css` selector updated to `.showcase-point h3`), and the footer labels are `<h3 class="footer-col-title">` (`public/css/marketing-sections.css` selector updated). Outline is now h1 → h2 → h3 everywhere.

**Verified.** axe `heading-order`: 2 nodes → 0.

### #22–23 — 4.1.2 / 1.3.1

**Finding.** A `pre` carries an `aria-label` that is not exposed, and `aria-controls="install-modal"` points at an element that does not exist.

**Root cause.** The install dialog is built on demand in `public/js/ui/install-panel.js` and never had that `id`, so the trigger pointed at nothing until the panel existed — and the `pre`'s label was ignored because a `<pre>` has no role that supports naming.

**Fix.** The dialog element now has `id="install-modal"` and is labelled by its visible `h2` (`aria-labelledby="ip-title"`); the `pre` keeps its visible content and the label was dropped rather than left as dead markup.

**Verified.** `scripts/a11y-controls.mjs` opens the dialog and confirms `aria-controls` resolves, focus moves inside, and the dialog is labelled.

### #196–198, #263–271 — heading-less section labels and price amounts

**Finding.** Section eyebrows ("THE PLATFORM", "PRICING", …) and the price amounts look like headings but are spans.

**Root cause.** Two different situations, two different answers:
- Each eyebrow is immediately followed by a real `<h2>` that names the section ("An operating system for the business, not just a page builder"). Making the eyebrow a heading would create a duplicate `<h2>` for every section and break the outline that #20–21 was fixing, so the eyebrow stays an inline label and the `<h2>` remains the section heading. This is a deliberate no-change, not an oversight.
- The price cards genuinely had no heading of their own. `.price-name` is now `<h3>` (Free / Pro / Enterprise), so each card has a name, its price is content under it, and the three cards are siblings in the outline.

**Verified.** axe reports no heading violations; the rendered cards are pixel-identical (`.price-name` styles are class-based).

### #203 and 93 related — text under 12px

**Root cause.** `--fs-2xs: 0.6875rem` is 11px, 52 literal `font-size` declarations across eight stylesheets went as low as 8.5px, `.mono` used `0.86em` (11.4px at 13px), and one inline `font-size:9px` sat in the dashboard mock.

**Fix.** `--fs-2xs` raised to `0.75rem` (12px); all 52 declarations now use `var(--fs-2xs)`; `.mono` uses `font-size: max(0.86em, var(--fs-2xs))` so relative sizing can never drop below the floor; the inline `9px` became `.pv-kpi-unit`.

**Verified.** `scripts/a11y-behaviour.mjs` walks every visible text node on `/` and reports 0 under 12px (was 79).

### #238–241 — 1.4.10 Reflow / 1.4.4 Resize text

**Finding.** At 320px the `.ops-tabs` strip scrolls 40px sideways; at 200% text the page scrolls sideways and `pre` content is cut off.

**Root cause.**
- `.ops-tabs` was a `nowrap` strip with `overflow-x: auto`.
- `.nav-links` was `flex-wrap: nowrap` while the nav row itself had a fixed height, so enlarged text pushed links past the viewport — and `.nav-inner` gained 4px of breathing room after the gap was adjusted so the default 1440px layout still fits on one row.
- `.hero` did not clip its own decoration; `.fx-stage` is inset −5% on each side, which contributed to the page's scroll width.

**Fix.** `.ops-tabs` wraps; `.nav-links` may wrap inside a single-row nav (one row at 100%, tidy rows at 200%); `.nav-inner` uses `min-height` so it can grow; `.hero` gets `overflow: clip`; `.nav-inner` gap reduced from `--s-5` to `--s-4` to keep the 1440px row on one line.

**Verified.** 320px → 315px of content in a 320px window. 200% text → 1270px in a 1280px window, no sideways scrolling. Screenshots at 1440px confirm the nav is still one row.

### #207–210 — 2.2.2 Pause, Stop, Hide

**Finding.** Infinite hero, grid and button animations with no way to stop them.

**Fix.** A footer control (`data-motion-toggle`) that sets `html.motion-paused` — CSS pauses every animation and transition (`animation-play-state: paused`), `hero-fx.js` pauses the CSS layers, and `aurora.js` stops its canvas on a still frame. The choice is stored in `localStorage` and re-applied on the next visit, before the first frame. The button is a real `<button>` with `aria-pressed` and a label that flips between "Pause motion" and "Resume motion".

**Verified.** `scripts/a11y-controls.mjs`: initial state, click → `aria-pressed="true"`, media query reports `animation-play-state: paused`, the stage carries `fx-paused`, the preference persists, a reload comes back paused, and turning it off resumes and clears the preference.

### #252 — 2.1.2 No Keyboard Trap / 2.1.1 Keyboard

**Finding.** The install dialog cannot be dismissed with Escape.

**Root cause.** Escape ran `back()` while inside the flow and only closed at the top screen, so from the platform list it took several presses and looked broken. Focus was also not returned to the trigger on close.

**Fix.** Escape always closes the dialog; focus returns to the element that opened it.

**Verified.** `scripts/a11y-controls.mjs`: one Escape press closes it, focus lands back on the trigger.

### #211 — 2.4.1 Bypass Blocks

**Finding.** The skip link was partly covered by page content.

**Root cause.** `z-index: var(--z-toast)` (120) is above the nav (60) but the link sat in a stacking context created by the page container, so the container painted over it.

**Fix.** `.skip-link` now sits at `z-index: 1000`, above every shell layer.

**Verified.** First Tab stop is the skip link, on screen at 16px, and `elementFromPoint` at its centre returns the link itself.

### #200–206, #242–246 — AAA and opinion-level items

Handled where cheap and honest:
- Links inside sentences are underlined instead of relying on colour alone (1.4.1) — a shared rule in `tokens.css` plus the marketing `.prose`/`.lead` rules, which cleared `link-in-text-block` on `/docs` and `/download`.
- Links that open a new tab say so in their accessible name (Instagram, YouTube, WhatsApp).
- Buttons that repeat the same words now name their plan: "Start free on the Free plan", "Choose Pro — ₹2,499 per month", "Talk to us about the Enterprise plan", "Generate a site".
- First use of "AI" is wrapped in `<abbr title="Artificial intelligence">`.
- The three preview tables have `<caption class="sr-only">` and `scope="col"` headers; the one inline colour on the "Out" badge became `.ops-badge.bad`.
- The command block on `/download` is focusable (`tabindex="0"`) because it scrolls.
- `/system-check` got the `<main>` landmark it was missing; the four legal pages got a `<header>` landmark.

Left as they are, with reasons: long capital-letter eyebrows (they are rendered uppercase by CSS but read in sentence case, so screen readers never spell them out), the h1 wording (it is the brand promise and the section `<h2>`s carry the detail), and 80-character line length (AAA 1.4.8, a layout preference rather than a barrier).

---

## Items 24–261 ("background colour could not be determined")

Those are one tooling limitation: the checker could not compute a background behind a pseudo-element or gradient and produced a warning rather than a defect. They were not fixed one by one. Instead the tokens those elements inherit were measured and raised (#9–18) and axe — which does resolve the painted background in a real browser — now reports 0 contrast nodes on every public route.

## Files touched

```
public/css/tokens.css                 tokens, skip link, in-text link rules
public/css/marketing.css              nav, showcase h3, ops badge, motion switch, pv-kpi-unit
public/css/marketing-sections.css     faq state, footer titles, faq[hidden]
public/css/fx.css                     hero overflow clip
public/css/{admin,app,auth,components,guide,onboarding,views}.css   font-size floor
public/index.html                     aria, headings, captions, labels, motion switch
public/download/index.html            focusable command block
public/system-check/index.html        main landmark
public/admin-login/index.html         label-in-name
public/legal/*/index.html             header landmarks
public/js/ui/reveal.js                accordion state
public/js/ui/install-panel.js         dialog id, Escape, focus return
public/js/ui/motion-toggle.js         new — the pause switch
public/js/ui/hero-fx.js               honours the pause switch
public/js/ui/aurora.js                honours the pause switch
public/js/boot/landing.js             wires the switch
public/js/boot/site-auth.js           account button label
scripts/a11y-audit.mjs                new — axe runner
scripts/a11y-behaviour.mjs            new — behaviour checks
scripts/a11y-controls.mjs             new — control checks
```
