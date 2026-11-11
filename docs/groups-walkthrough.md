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
