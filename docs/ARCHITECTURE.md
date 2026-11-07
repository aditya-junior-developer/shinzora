# Architecture

Shinzora is a static frontend plus a Postgres backend. There is no server process of our own: the browser talks to
Supabase directly for CRUD (under RLS) and to Edge Functions for anything that must not be trusted to the client.

```
                    ┌────────────────────────────────────────────┐
   browser          │  public/  (HTML + CSS + ES modules)         │
                    │  boot/*  →  modules/*  →  lib/*, ui/*       │
                    └───────────────┬───────────────┬────────────┘
                                    │               │
                     supabase-js    │               │  fetch (JWT)
                     (RLS-scoped)   │               │
                    ┌───────────────▼───────┐  ┌────▼─────────────────────────┐
                    │  Postgres + Auth      │  │  Edge Functions (Deno)       │
                    │  + Storage + Realtime │  │  ai · domains · payments ·   │
                    │                       │  │  integrations · admin · site │
                    └───────────────────────┘  └────┬─────────────────────────┘
                                                    │ service role + secrets
                                        ┌───────────▼────────────┐
                                        │ Gemini · registrar ·   │
                                        │ GitHub · Vercel · RZP  │
                                        └────────────────────────┘
```

---

## Frontend layering

Each layer only knows about the one below it.

| Layer | Path | Responsibility |
| --- | --- | --- |
| Boot | `js/boot/*.js` | One entry module per surface. Wire the page: guard → hydrate → render → bind. |
| Modules | `js/modules/**` | Features. `dashboard/router.js` lazy-loads views; `admin/shell.js` does the same for the console. |
| UI | `js/ui/*` | Toast, modal/dialog, reveal, form, PWA install, aurora, and the `install-panel` download centre. Surface-agnostic. |
| Lib | `js/lib/*` | Icons, DOM helpers, formatting, validation, Supabase client, Edge Function client, state store, route guards. |
| Config | `js/config/env.js` | Public environment + plan catalogue. No secrets. |

Rules that keep the codebase honest as it grows:

- Views never query Supabase directly; they call `modules/dashboard/data.js`, so error handling and column choices live in
  one place.
- Privileged operations never go through `data.js`; they go through `lib/api.js`, which is a thin wrapper over Edge
  Functions with a consistent timeout and error envelope.
- Formatting and escaping are centralised (`lib/format.js`, `lib/dom.js#esc`) — every interpolated string is escaped at
  the point of interpolation.

### Rendering

No virtual DOM. Each view renders a string into `#view-root` and then binds events with delegated listeners. That keeps
the bundle small and makes the generated markup auditable, at the cost of re-rendering a view on filter changes — which is
the right trade at this scale.

`router.js` behaviour:

- `?view=x` is the source of truth; unknown ids fall back to `overview`.
- Views load through `import()`; a failed import renders an error card with a retry — never a blank screen.
- In-page anchors and `shinzora:navigate` events are intercepted so navigation does not reload the shell.
- `popstate` is handled, so the back button works between views.

### Sandboxed generation

Generated code is untrusted input. It is rendered like this:

1. `builder-core.js#buildPreviewDocument(files, entry)` inlines every `<link rel="stylesheet">` and `<script src>` that
   points at a sibling generated file, producing one self-contained HTML string.
2. That string becomes the `srcdoc` of an iframe with `sandbox="allow-scripts allow-forms allow-popups"` — deliberately
   **without** `allow-same-origin`, so the frame is treated as a unique opaque origin. It cannot read `localStorage`,
   cookies, the parent DOM or the Supabase session.
3. A CSP of `default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data: https:;` is injected
   into the document, with `base-uri 'none'` and `form-action 'none'`.
4. The same builder is used by `/site/?p=slug` for published versions.

The API side strips remote `<script src="http...">` tags from generated HTML before it is ever stored, so a generated file
cannot pull a third-party script into a published site.

---

## Backend layering

### Direct client access (RLS)

The dashboard reads and writes its own rows with the publishable key. Every table is protected:

- owner policies for `profiles`, `businesses`, `projects`, `project_versions`, `ai_conversations`, `ai_messages`,
  `store_*`, `campaigns`, `support_*`, `notifications`;
- `subscriptions` and `payments` are **read-only** to owners — writes exist only for the service role, which is why a
  client cannot grant itself a plan or a verified payment;
- public read is allowed only for a published project and its published version, which is what `/site/` needs;
- `admin_users` allows a self-select (so the console can show your own role) and nothing else.

### Edge Functions

| Function | Why it exists |
| --- | --- |
| `ai` | Holds `GEMINI_API_KEY`; consumes quota atomically; validates generated payloads |
| `domains` | Talks to a registrar; re-checks prices server-side before creating an order |
| `payments` | Creates payment records with server-side prices; accepts UTR proof |
| `payments-webhook` | Verifies a Razorpay HMAC and is the only automatic path to `verified` |
| `integrations` | Exchanges OAuth codes, stores tokens in a service-role-only table, pushes commits, deploys |
| `admin` | Cross-customer reads and the manual payment approval, gated by `admin_users` |
| `site` | Public read of one published version, no session required |
| `config` | Public booleans describing which providers are connected |

Shared code sits in `_shared/`: HTTP envelopes, JWT verification, the Gemini client, provider flags, and the prompt
library (which is where the product voice and the "never invent statistics" rule live).

### AI data flow

```
view → api.ai.generate({type, brief, pages, style})
     → ai Edge Function
         ├─ verify JWT
         ├─ consume_ai_credit()  (Postgres, service role, atomic)
         ├─ build prompt with business profile read server-side
         ├─ call Gemini (JSON response mode)
         ├─ sanitise files (name allowlist, size cap, strip remote scripts)
         └─ return { files, entry, seo, design_system, notes, model }
     → client inserts project + version rows (owner RLS)
```

The function does not write projects. That keeps ownership enforcement in one place — Postgres — and means a failed
generation never leaves a half-created project behind.

Chat is different: the function persists the conversation and both messages itself, because history must be ordered and
attributed server-side.

---

## State

`lib/store.js` holds a tiny observable store: the authenticated user, profile, business, subscription and onboarding
flags. `loadIdentity()` hydrates it once per page load and after any mutation that could change it (plan upgrade, profile
edit). Views read from it synchronously; nothing caches data that RLS might later refuse.

---

## Progressive web app

`manifest.webmanifest` declares the name, icons, shortcuts (Assistant, Builder, Orders) and standalone display. `sw.js`
pre-caches the shell (shell CSS/JS, aurora, guide CSS and boot module) and serves a navigation fallback; `404.html` and
`offline.html` are branded. The install prompt (`ui/pwa.js`) captures `beforeinstallprompt`, can be dismissed, and
remembers that choice in `localStorage`. There is no fake app-store button.

### Download centre (`ui/install-panel.js`)

One modal, three screens: `device` (Phone / Computer) → `family` (Android|iOS or Windows|macOS|Linux) → `platform`
(what that platform can actually do). Screens cross-fade and slide; the panel's height is animated between steps from a
measured `offsetHeight`, so the card grows with the content instead of snapping. Escape walks back and closes at the top
level; focus is trapped and restored; `prefers-reduced-motion` collapses every transition to ~0 ms.

Availability is derived, not written:

1. `GET /downloads/manifest.json` — the build registry. Absent or empty means no native build exists.
2. Each listed entry gets a `HEAD` request. Only a `200` produces a Download button; the response's `content-length`
   becomes the displayed size.
3. Downloading streams the body through `ReadableStream` and fills the bar from bytes received. Without a stream or a
   known length it hands the file to the browser and says so, rather than animating a fabricated percentage.
4. No entry → the platform's supported browser-install route is shown, plus a live `beforeinstallprompt` button when the
   browser has one. iOS never gets a pretend IPA.

`/downloads/` is explicitly skipped by the service worker: a stale manifest would advertise a build that no longer
exists, and installer bytes must arrive intact.

### Setup guide (`/install-guide/`)

A standalone, print-friendly page — Android, iPhone/iPad, Windows, macOS, Linux, plus troubleshooting. It is a plain
document (content in the HTML, readable with scripts off); the small boot module only mounts the aurora, injects the
official platform marks into the section headers, stamps the year and highlights the active section in the sticky nav.
The panel links to it with `target="_blank" rel="noopener noreferrer"` — it always opens in its own tab, never inside the
modal. `/install/` keeps the older short-form instructions and now links here.

---

## Decisions worth recording

| Decision | Reason |
| --- | --- |
| No framework, no build step | The requirement was vanilla ES modules. Removing bundling also removes supply-chain surface. |
| Vendored `supabase-js` and `qrcode` | A zero-CDN policy means the app works offline and cannot break when a CDN is blocked in India. |
| Server-side prices for payments | A client-supplied amount is a trivially exploitable input. |
| Payment approval as an explicit admin action | Manual UPI has no webhook; pretending otherwise would mark payments verified without money. |
| Tokens in a table with no policies | `integration_tokens` is readable only by the service role, and optionally encrypted with AES-GCM. |
| Generated sites in a non-same-origin iframe | Generated JS must never touch the dashboard's session. |
| Capability flags instead of hidden features | A disabled feature with an explanation is more useful than a button that fails silently. |
