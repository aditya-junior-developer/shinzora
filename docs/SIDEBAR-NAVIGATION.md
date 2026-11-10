# The sidebar

The dashboard navigation is a **column of the layout**, not a modal. One hamburger
button in the top-left of the header moves it between two states, and the page
beside it stays live in both.

| State | Width | What is shown |
|-------|-------|---------------|
| Expanded | `--sidebar-w` (258px) | Icons, labels, workspace switcher, AI usage, full navigation, recent chats |
| Rail | `--sidebar-w-collapsed` (76px) | The same links as icons, with a tooltip on hover and on keyboard focus |
| Overlay (below 1024px) | `min(86vw, 300px)` | The full panel, sliding over the content with a scrim |

## Why it is not the shared drawer

`public/js/ui/drawer.js` is a **modal**: it locks page scroll, traps focus, and
closes on Escape or a scrim click. Every one of those behaviours is wrong for a
column the user keeps open while they work. The admin console and the marketing
menu are genuinely modal, so they keep using it unchanged.

The dashboard has its own small controller, `public/js/ui/sidebar.js`, which owns
the two-state column and the phone overlay. It reuses the same markup, the same
`[data-label]` tooltips and the same close-on-navigate rule — it just does not
lock a desktop page that has nothing to be protected from.

## How it is wired

```
public/app/index.html
  <html data-sidebar="expanded|rail">      ← set before first paint, from localStorage
  #sidebar-toggle[data-sidebar-toggle]     ← the only toggle, in the topbar
  #app-sidebar                             ← the panel; a column on desktop, an overlay below 1024px
  #sidebar-scrim                           ← exists only below 1024px
  #sidebar-recent                          ← recent conversations, rendered by shell.js
```

* **Persistence** — `localStorage["shinzora:sidebar"]`. A remembered rail is
  applied by an inline script in `<head>`, so a returning user never sees a
  full-width sidebar flash and then snap narrower.
* **No keyboard shortcut** — there is none for the sidebar. ⌘K / Ctrl-K still
  focuses global search, and nothing else is bound.
* **The width is the animation** — the panel is `position: fixed` at
  `width: var(--shell-nav)` and the content column carries
  `margin-left: var(--shell-nav)`, with both transitions on 0.26s. `width` and
  `margin-left` animate in every browser; a grid track does not.
* **The rail keeps its names** — collapsed labels are clipped with
  `clip-path: inset(50%)`, never `display: none`, so a screen reader still
  announces "Orders" rather than an unnamed link. Each item also carries a
  `data-label`, shown in a fixed-position `.rail-tip` bubble (a pseudo-element
  would be clipped by the navigation's own scroll box).
* **The chat list is hidden in the rail**, not clipped, so invisible links never
  enter the tab order.

## What the nav items do

Every item in `NAV` / `AGENT_NAV` (`public/js/modules/dashboard/shell.js`) is a
real `/app/?view=…` link that the router intercepts, so switching sections never
reloads the page. The workspace switcher opens its menu (and expands the rail
first, since a 76px column has no room for a menu). The chats section reads
`ai_conversations`:

* a conversation opens `/app/?view=assistant&conversation=<id>` — the assistant
  view loads that thread and keeps the URL in step, so a refresh lands back on it;
* "New chat" opens `/app/?view=assistant&new=1` — an empty composer, no thread;
* "All chats" opens `/app/?view=assistant&history=1` — the same History panel the
  button in the assistant header opens, not a second list;
* the active conversation is highlighted, and the list refreshes on
  `shinzora:chats-changed` (fired when a conversation is created, renamed or
  deleted).

## Responsive rules

| Width | Behaviour |
|-------|-----------|
| ≥ 1024px | Fixed column, content offset by its width, **no scrim, no blur, no scroll lock, no overlay** |
| < 1024px | Off-canvas panel, subtle scrim, page scroll locked while open; closes on a link, a view change, Escape, the ✕, or the scrim |

Crossing the breakpoint clears the other mode's state, so an overlay left open
cannot keep a scrim over a desktop layout.

`prefers-reduced-motion: reduce` reduces every sidebar transition to 0.01ms.

## Tests

* `tests/sidebar-navigation.test.mjs` drives the real controller against the real
  page markup: both states, persistence, focus, the phone overlay (all five ways
  out), the breakpoint change, tooltip labels, recent-chat links, agent
  navigation, and that no keyboard shortcut grew back.
* `tests/drawer-surfaces.test.mjs` pins the stylesheet agreement: fixed panel,
  offset content, animated width, scrim and scroll lock scoped to the phone
  breakpoint, and the rail clipping (not deleting) its labels.

## If the hamburger ever seems dead

That is almost always a mixed-version page, not this controller. The service
worker used to serve JavaScript cache-first while HTML came from the network, so
the first visit after a deploy ran yesterday's `shell.js` against today's markup:
the old module looked for `[data-sidebar-open]`, the new page shipped
`[data-sidebar-toggle]`, and nothing answered a click.

Two fixes are in place, in this order of importance:

1. **The service worker now serves `/js/` and `/css/` network-first**, with the
   cache kept only as the offline fallback (`shinzora-v35`). Images and fonts keep
   the cheaper serve-cached-refresh-later strategy.
2. **The controller binds the old toggle attributes too**, so even a browser
   still holding a cached page or module can collapse the sidebar instead of
   freezing it open.

If a stale page is still in front of you, one hard reload (`Ctrl`/`Cmd` +
`Shift` + `R`) clears it — after that the service worker activates and keeps
code current on its own.

## Not verified here

Chromium cannot run in this sandbox (the host is missing the browser's system
libraries and they cannot be installed), so the layout was checked by reading the
computed cascade and by DOM tests, not by a rendered screenshot. Every behaviour
above is covered by a test that runs in CI-style `npm test`; the visual polish on
a real screen is still worth a look on your device.
