# Groups, mentions and notifications — live walkthrough

Run this against the deployed app with three real accounts. Each step lists what
you do and **exactly what should happen**. If a step does something else, that
step failed — note it and stop, because later steps build on it.

Temporary accounts are fine; delete them when you are done. Nothing in this
document has been pre-seeded: every group, member and message is created by you
in these steps.

| account | role in the test |
| --- | --- |
| **A** | creates the group, becomes its owner |
| **B** | promoted to Group Admin |
| **C** | stays a member, gets mentioned |

> **Use one browser profile for the push steps.** A Web Push subscription and a
> notification permission belong to a browser profile, not to an account, so two
> incognito windows cannot both hold one. Use two normal profiles plus one
> incognito window, and keep **C** in a normal profile — C is the one who needs
> to receive a closed-tab notification.

---

## 1. A creates a group

**A** → `/app/?view=messages` → the **Groups** tab → **New** → name it
`Walkthrough test` → **Create group**.

- [ ] The group opens immediately and the thread says nothing yet.
- [ ] The header reads **"1 member · you are owner"**.
- [ ] **Group info** appears in the header; **Edit**, **Change picture** and
      **Add people** are inside it.

## 2. A adds B and C

**A** → **Group info** → **Add people** → type `@b…` → click the search result.
Repeat for **C**.

- [ ] The member list shows three people, A labelled **Owner**.
- [ ] Adding someone already in the group offers no row for them.

## 3. A promotes B

**A** → **Group info** → on B's row → **Make admin**.

- [ ] B's chip changes to **Group admin**.
- [ ] A's own row has no "Make admin" and no **Remove** next to it (an owner
      cannot be removed).

## 4. B changes the group picture

**B** reloads → **Group info** → **Change picture** → pick a JPEG/PNG/WebP.

- [ ] The picture appears **centred** in the circle, not zoomed or off-centre.
- [ ] After A and C refresh their list, they see the same picture.

## 5. C cannot

**C** → **Group info**.

- [ ] There is **no** Change picture, **no** Edit and **no** Add people.
- [ ] To prove the button is not what protects anything, open the browser console
      on C's tab and run:

      ```js
      await supabase.rpc('group_update', { p_group: '<group id>', p_name: 'hijacked' })
      ```

- [ ] It must fail with **"Only the group owner or a group admin can change this
      group."** The name must stay unchanged.

  (The group id is in the address bar after `?group=`.)

## 6. B mentions C

**B** types `@` in the message box.

- [ ] A menu opens listing **this group's members only** (not everybody on
      Shinzora), each with their handle and role, plus **Everyone in this group**
      if the group allows it.
- [ ] Arrow keys / click insert `@c…` and close the menu.
- [ ] After sending, C sees the mention rendered as a **chip**, visually distinct
      from the rest of the sentence.

## 7. C is notified (open tab)

- [ ] Within a second or two a notice appears with **who sent it**, **the group
      name**, **"mentioned you"** and a preview of the message.
- [ ] If sound is on, a short two-note chime plays. (The first click anywhere in
      the app unlocks audio — browsers require a gesture.)
- [ ] The sidebar **Notifications** badge increases by one.

Click the notice.

- [ ] It opens `/app/?view=messages&tab=groups&group=…&message=…`.
- [ ] The mentioned message is scrolled into view and briefly outlined.

Click the mention chip in the thread.

- [ ] C's profile sheet opens.

## 8. `@everyone` follows the group's settings

**A** → **Edit** → *Who may use @everyone*:

| setting | C sends `@everyone hi` | B sends `@everyone hi` |
| --- | --- | --- |
| Nobody | refused | refused |
| Owner and group admins only | refused | delivered |
| Any member | delivered | delivered |

- [ ] A refusal is a visible error in the composer stating the database's reason —
      the message is **not** posted.
- [ ] `@all` behaves the same as `@everyone`.

## 9. Duplicates and strangers

- [ ] `@c @c hello` produces **one** chip and **one** notification for C.
- [ ] `@nobody hello` posts normally, renders no chip, and notifies nobody.
- [ ] A phrase like `someone@example` in a sentence notifies nobody.

## 10. Preferences

**C** → **Settings → Preferences → Groups & mentions**.

- [ ] The toggles match what was saved — reload the page and they are still set
      (they live on the account, not the device).
- [ ] Turn **Group messages** off → B sends an ordinary message → C gets **no
      notice**, but the unread count in the Groups list still rises.
- [ ] Leave messages off and let B mention C → the mention notice **still
      arrives**. Mentions are not silenced by muting chatter.

## 11. Mute a group

**C** → **Group info** → **Mute this group**.

- [ ] B's ordinary messages stop producing notices for C.
- [ ] B's **mention** of C still arrives.
- [ ] The muted group appears in Settings → Preferences under *Muted groups*, and
      clicking the chip there unmutes it.

## 12. Background tab

Put C's tab in the background and have B send a mention.

- [ ] The operating system shows a notification (this needs the *Desktop alerts*
      preference on and the permission granted — press **Turn on** in Settings →
      Preferences → *Closed-tab alerts* first, which is the only place the
      permission is ever requested).

## 13. Closed browser

Close every Shinzora window, then have B mention C.

- [ ] A notification arrives with the app closed.
- [ ] Clicking it opens Shinzora **on that group, at that message** — it does not
      open a second empty tab if a Shinzora window is already there.

This is the one step that depends on the `push` function and the VAPID keys. If
nothing arrives, check Settings → Preferences: the line under *Closed-tab alerts*
states whether the deployment is configured, whether this browser supports it,
and how many devices are subscribed. Trust that line over the absence of a
notification.

## 14. Removal is immediate

**A** → **Group info** → **Remove** on C.

- [ ] The group disappears from C's Groups list on refresh.
- [ ] C's open tab can no longer read it: sending fails with **"You are not a
      member of that group."**
- [ ] C receives no further notifications from the group.
- [ ] On C's console, `group_get` returns **"You are not a member of that
      group."** — not an empty group.

## 15. Ownership moves only on purpose

**A** → **Group info** → **Make owner** on B → confirm.

- [ ] B is now **Owner**; A is **Group admin**.
- [ ] A can no longer promote anyone or transfer ownership.
- [ ] The message history is still there for everyone.

## 16. Nothing else broke

- [ ] **Direct** tab still lists conversations and a message sends.
- [ ] The public **Community** channel still reads and posts, and its banner
      shows the real number of groups C is in.
- [ ] The Notifications bell still opens the drawer, items still link, and
      **Mark all read** still clears the badge.
- [ ] Reloading the app does not double-subscribe to realtime or duplicate notices.

---

### What is already proven, and by what

| claim | evidence |
| --- | --- |
| roles, ownership, RLS and member-only reads | `tests/groups-rbac.test.mjs` — 55 assertions against real Postgres |
| mention resolution, dedupe, `@everyone` gating, non-members ignored | same file, sections 6–7 |
| preferences and push subscriptions are per user | same file, section 8 |
| removal revokes the RPC **and** the RLS read | same file, section 9 |
| the push trigger, its shared secret and its payload | `tests/groups-push.test.mjs` — 9 assertions |
| the push function refuses callers without the secret | `node scripts/smoke-functions.mjs --remote` — 401 |
| the trigger reaches the function in production | one live trip through `pg_net` recorded in `net._http_response` |
| **delivery to a real closed browser** | **not yet proven — that is step 13** |

---

## 17. Pictures and files in a group

**A** → Groups → open the group → **Attach** → choose a photo → **Send**.

- [ ] The photo appears in the thread **as a picture**, not a filename.
- [ ] Clicking it opens the full-size image in a new tab (a signed link that
      expires; nothing is public).
- [ ] A PDF shows as a named link instead.
- [ ] Choosing a file shows a chip above the composer with its size, and the
      **×** on the chip removes it before sending.
- [ ] Dragging a picture onto the thread does the same thing.
- [ ] The emoji buttons insert into the message box at the cursor.
- [ ] `@` still works alongside a file: the mention chip renders after send.

What the database did, and will not be talked out of: the file must be filed
under this group's own folder, be a JPEG/PNG/WebP/GIF/PDF, and be under 20 MB.
Sending a path that points at another group is refused with *"That file does not
belong to this group."*

## 18. Voice call, one to one

**A** and **B** both in a **Direct** conversation. **A** presses **Call**.

- [ ] The browser asks for the microphone (once; the answer is remembered).
- [ ] A call panel opens with both names and a **level meter** that moves when
      you speak — that is the fastest proof the microphone works.
- [ ] B, with the same conversation open, sees **"A is calling"** and hears a
      ring; pressing **Join** connects them.
- [ ] Mute silences you for the other person (the track is disabled, not just
      the icon), and the tile shows *muted*.
- [ ] Leaving stops the microphone — check the browser's tab indicator.

## 19. Video meeting in a group

**A** → Groups → open the group → **Meet**.

- [ ] A panel opens with your own camera, mirrored, and *"You are the only one
      here"* until somebody joins.
- [ ] **B**, with the same group open, sees the ring banner and joins. Both see
      two tiles.
- [ ] Camera on/off, mute, **Share** (screen), and **Leave** all do what they say.
- [ ] Minimising the panel keeps the call running.
- [ ] A seventh person is told the meeting is full rather than being let in to
      degrade it for everyone.

### The two honest limits here

- **Ringing needs the app open on that screen.** There is no push-based ring
  yet, so a group member who is not on the Messages screen will not be rung.
- **No TURN relay is configured.** Two peers on ordinary home/office networks
  connect directly; two peers behind strict carrier-grade NAT (some mobile
  networks, some corporate firewalls) cannot. The panel says *network* on the
  affected tile rather than spinning forever. To fix it, set
  `SHINZORA_TURN_URL`, `SHINZORA_TURN_USER` and `SHINZORA_TURN_CREDENTIAL` in the
  build environment — the engine picks them up with no code change.

## 20. The messaging hub — one surface for everybody

**Messages → Groups** and **Community** are now the same three-column page for
an owner, a plain member and a freelancer account. Community opens on its first
public room; a signed-out visitor still gets the plainer read-only room page,
because a visitor has no groups to put in the rail — that is the only branch. Nothing about the shape changes with
role; only the rows the database would refuse are left out.

**Left rail** — public **Channels** (# General, # Projects, # Wins,
# Announcements) on top, then your **Groups** with their picture, last message,
time and unread badge. Channels are public Community rooms: text only, and the
attach control is not offered while one is open.

**Middle** — the pinned-message bar under the group name, then the thread, then
the composer (emoji, attach, image/file, send). The header carries search,
voice meeting, video meeting and a **⋯** menu; **Details** appears only on the
narrow widths where the right column folds away.

**Right — Group info.** Picture with a camera badge (owner/admin only), name,
member count with an honest *active now* figure (members whose heartbeat is
inside five minutes), the About line, then the action rows: Add members, Group
permissions, Mute (a real switch), Edit description, Leave group — then the
member strip with **See all members** and the **Group media** grid with
**See all**.

### 20.1 Pinning a message

**A** (owner or admin) hovers a message → the pin button → the bar appears for
everyone.

- [ ] A plain member gets no pin button, and calling `group_pin` directly is
      refused by the database — the check is there, not in the button.
- [ ] Pinning a second message replaces the first: one pin per group.
- [ ] Clicking the pin jumps to the message; the ✕ on the bar unpins it.
- [ ] Deleting the pinned message clears the pin (the column is
      `on delete set null`), so no bar ever points at nothing.

### 20.2 Searching a group

The magnifier in the header opens a search field; from two characters it asks
`group_messages_search` for this group only, and a hit opens the thread on that
message. An outsider cannot search a group they are not in.

### 20.3 "I am not getting notifications" — the ten-second check

Settings → Notifications → **Test this account**.

- [ ] It stores **one real notification** for your account, linked to your first
      group if you have one, and says so: the row is stored, counted in the
      badge and pushed like any other. Nothing is faked.
- [ ] It reports what the browser says: permission granted or not, and how many
      devices are subscribed for closed-tab alerts.
- [ ] If no in-app notice appears within four seconds it says so plainly — that
      means the Realtime stream is not reaching this tab, not that the data is
      missing.
- [ ] **Clear test notifications** deletes those rows again.

Two limits, stated rather than glossed:

- **Desktop alerts only fire while the tab is open** (behind another window is
  fine). That is now real: the *Desktop alerts while the tab is open* preference
  is wired to `Notification`, so turning it off actually stops them.
- **Closed-tab alerts need Web Push configured** — permission granted, a
  subscription row, and the `push` function's VAPID keys. The card tells you
  which of those is missing instead of promising delivery.

## 21. The composer, richer attachments, polls, and six themes

### 21.1 The message bar

One row at every width: **😊** and **📎** at the left, the six quick reactions
next to them, the field in the middle taking what is left, **Send** at the
right.

- [ ] On a laptop the quick reactions are visible; under ~1080 px they step
      away, because the field matters more than six shortcut faces.
- [ ] On a phone **Send** becomes its icon and the field keeps at least a
      usable width. Nothing wraps onto a second row.

### 21.2 The emoji button

- [ ] It opens the **whole set** — 2,295 emoji in nine groups (Smileys, People,
      Nature, Food, Travel, Activity, Objects, Symbols, Flags).
- [ ] The search box finds emoji by name: type `rocket`, `party`, `thumbs`.
- [ ] Picking one inserts it at the caret in the message field, not at the end.

Skin-tone variants are the one omission: they repeat a base emoji the picker
already offers, and including them would have tripled the file. Everything else
in Unicode 15.1 is here.

### 21.3 The attach button

It asks *what* is being attached, because the four flows end differently:

| Kind | What happens |
| --- | --- |
| **Photo or video** | picture shown inline, video gets a player in the bubble |
| **Document** | PDF, Word, Excel, CSV, text — opens in the browser's own viewer, never a forced download |
| **Poll** | a real poll in the thread: question, 2–10 options, one vote per person unless "pick more than one" |
| **Audio** | a voice note or clip with a player in the bubble |

- [ ] A file that is not one of the allowed types is refused by the database,
      not only by the file picker — try `text/html` from the console and read the
      refusal.
- [ ] Each file may be up to 50 MB, five per message.
- [ ] A poll's tally updates for everyone who can see it; an outsider cannot
      read or vote on it.
- [ ] Voting twice for the same option is a no-op; on a single-choice poll a new
      vote replaces the old one.

### 21.4 Six themes

Settings → Appearance now offers **Midnight**, **Nebula**, **Grove** (dark) and
**Blossom**, **Daylight**, **Porcelain** (light). Same components, different
tokens; every text step is above 4.5:1 on the surface behind it, and the choice
follows the account to other devices.

### 21.5 Community is channels only

The Community page is the same three-column hub, but its rail lists the public
rooms and nothing else: groups live under Messages. A signed-out visitor still
gets the read-only room page.

### 21.6 Two fixes worth knowing about

- **Analytics** failed with `on is not defined` — a helper was called without
  being imported, so the whole view threw after painting its skeleton. Fixed,
  and `scripts/check.mjs` now refuses to pass a module that calls a `lib/dom`
  helper it never imported, which is how this shipped in the first place.
- **The AI command bar** occasionally answered `ai_bad_json`. The site builder
  already retried once with a stricter instruction; the assistant, the ideas,
  the support replies and the analysis now do the same, so one malformed answer
  no longer costs the sentence you typed.

### 21.7 What a browser run found, and what changed because of it

Everything below was measured in Chromium against the real views, not eyeballed.

| Found | Fixed |
| --- | --- |
| The rail clock read "10 minutes ago", which squeezed the group name to "Desig…". | The rail now uses a compact clock — `now`, `12m`, `3h`, `2d`, `5w` — and the name keeps the room. Bubbles still spell it out. |
| The **Details** button carried a 30×17 toggle skin, so its own label spilled out of the pill and collided with the ⋯ beside it. | It is a button again: sized like the others, label readable, `is-on` still marks the open state. |
| A poll's card was squeezed into a 165 px column because `min-width: min(320px, 100%)` resolved against a shrink-to-fit bubble. | The card has a real 300 px floor and gives way to `width: 100%` under 620 px. |
| Opening a group scrolled to the bottom *before* the composer was shown, so the last message sat 60 px below the fold. A poll arriving live pushed itself out of view as its card grew. | The thread lands on the bottom after the composer appears, and `paintPolls` restores the bottom only if the reader was already there. |
| A poll printed "Loading poll…" and stayed there. | `paintThread` is awaited before `paintPolls` — the polls are found by walking the bubbles it writes. |
| A public room's field still said "type @ to mention somebody", and typing `@` asked a group-only RPC with no group. | A room's field says "Write a message…", and the @ menu is not offered where it cannot resolve. Attach was already hidden; now the promise matches. |
| The emoji and attach popovers could open past the top of a short viewport. | `.cmp-pop` is clamped to `100dvh - 140px`, and the attach list scrolls. |

Measured at 1180, 900 and 620 px: one row in the composer, no horizontal overflow, the
emoji popover fully in view with all nine group tabs, the attach menu offering
photo/video, document, poll and audio, and every popover closable with Escape.
