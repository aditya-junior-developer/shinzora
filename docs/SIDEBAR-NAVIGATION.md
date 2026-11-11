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
column the user keeps open while they work. The marketing menu is genuinely
modal, so it keeps using `createDrawer` unchanged. The admin console used it too
until the two shells were made to match — see "The admin console" below.

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
| < 1024px | Off-canvas panel **below the topbar**, subtle scrim, page scroll locked while open; closes on a link, a view change, Escape, the ✕, the scrim, or the ☰ — which stays clickable because the bar is the topmost layer |

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

## The admin console

The admin console uses **the same controller as the dashboard** (`createSidebar`),
because it is the same product: a column of navigation on a desktop, an icon rail
when collapsed, and an overlay drawer below 1024px where there is no room for a
column.

It used to use `createDrawer` at every width, which meant a desktop monitor
showed the console with its own content dimmed and blurred behind a scrim — a
menu that covered the page while offering nothing the page did not already have.
`tests/admin-drawer.test.mjs` drives the real controller against the real
`public/admin/index.html` at both widths, and `tests/drawer-surfaces.test.mjs`
pins the stylesheet split.

What that requires, and why:

* **the content is offset, not covered** — `.admin-main { margin-left:
  var(--shell-nav) }` beside `.admin-sidebar { width: var(--shell-nav) }`, with
  `--shell-nav` shrinking from 280px to 76px on `[data-sidebar="rail"]`.
* **no scrim on a desktop** (`display: none` in `@media (min-width: 1024px)`)
  and no `backdrop-filter`, so nothing is darkened or blurred while the menu is
  in the layout.
* **the phone drawer starts below the topbar** (`inset: var(--nav-h) auto 0 0`)
  with the bar on top (topbar 70 > panel 60 > scrim 55). This was the original
  complaint: the ☰ sits at the far left of the bar, exactly the strip a
  full-height panel covers, so the click landed on the panel and nothing
  happened. A `z-index` on the button could never fix it — the bar is its own
  stacking context, so every child is painted at the bar's level.
* **open is driven by the controller's body class** (`body.sidebar-open`), not by
  an `.is-open` class nobody sets. The ✕ carries `data-sidebar-close`, which is
  what the shared controller binds.
* **the rail preference is applied before the first frame** by an inline script in
  `public/admin/index.html`, the same `shinzora:sidebar` key the dashboard uses,
  so a collapsed menu does not flash open and then snap.
* the console **registers the service worker itself** (`registerServiceWorker()`
  in `public/js/boot/admin.js`). Before, only the marketing site and the dashboard
  registered one, so a browser that went straight to `/admin/` kept running
  whatever code and CSS the old worker had cached — and an old `admin.css` leaves
  the navigation permanently on screen, which is indistinguishable from "the
  drawer will not close".

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
