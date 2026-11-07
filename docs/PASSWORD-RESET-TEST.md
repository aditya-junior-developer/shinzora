# Password reset — what was tested, and what is still blocked

Two kinds of work here, kept apart on purpose:

- **Tested here**, with a real browser against the live Supabase project: every failure path, every redirect, every message, and the request itself.
- **Blocked on a mailbox**: the middle of the flow — an actual email arriving, its link being opened, the new password being used to sign in. I have no mailbox and no SMTP credentials, so I will not claim a pass for it.

---

## 1. Code reviewed and changed

| File | Finding | Change |
| --- | --- | --- |
| `public/js/boot/auth-reset.js` | An expired link, an already-used link and a link opened in another browser all produced the same generic warning, and there was no way forward from it | The reason is now read from the URL (`error_code`) and named: *expired*, *already used*, *opened in a different browser*. A **Request a new link** button is always offered |
| `public/js/boot/auth-reset.js` | After a successful update the page kept the recovery fragment in the URL, so a refresh looked like a fresh link | The fragment is cleared with `history.replaceState` after success |
| `public/js/boot/forgot-password` | It already reports conditionally — "If an account exists for this address…" — and never claims delivery | Verified, unchanged |
| `public/js/modules/auth/auth-service.js` | `resetPasswordForEmail` and `updateUser` both throw on error, so the success state is only reached when the call actually succeeded | Verified, unchanged |
| `public/js/boot/auth-callback.js` | Handles both PKCE (`?code=`) and implicit (`#access_token=`) returns, and ends in a definite state | Verified, unchanged |

Redirect target used by the request: `/auth/callback/?next=/auth/reset-password/`. For the link to come back to this site rather than the project's Site URL, `https://shinzora.in/auth/callback/**` (and the preview origin) must be in Supabase → Authentication → URL Configuration → Redirect URLs. That is a dashboard setting; it cannot be changed from here.

## 2. Automated browser tests — 12/12 passing

`node scripts/scripts/reset-flow-check` equivalent, run ad hoc in this session:

| # | Test | Result |
| --- | --- | --- |
| 1 | Open `/auth/reset-password/#error=access_denied&error_code=otp_expired` | **This reset link has expired** — passes |
| 2 | Same, passed as a query string (PKCE style) | Recognised — passes |
| 3 | Open `/auth/reset-password/#error_code=access_denied` | **This reset link has already been used** — passes |
| 4 | Open `/auth/reset-password/` with no session at all | **This reset link is no longer valid** — passes |
| 5 | Success is never shown on a dead link | No success state anywhere on the page — passes |
| 6 | Form disabled on a dead link | 4 controls disabled — passes |
| 7 | A way forward exists on a dead link | `#request-new-link` present, links to `/auth/forgot-password/` — passes |
| 8 | `/auth/callback/?error=…otp_expired` | Reports failure, never "You are signed in" — passes |
| 9 | Callback offers a recovery route | Link to `/auth/forgot-password/` present — passes |
| 10 | Submit a reset request for a non-existent address | Request reached Supabase (HTTP 200) — passes |
| 11 | Response wording for that address | Stays conditional: "If an account exists…", never "sent to you" — passes |
| 12 | Page state after the request | No crash, no unhandled error — passes |

Screenshots: `docs/media/reset-forgot.png`, `docs/media/reset-callback-error.png`.

## 3. The mailbox-dependent half — not tested, and why

These steps need an address I can open. Doing them blind would be inventing a result.

| Step | Expected | Status |
| --- | --- | --- |
| Request a reset for a real address on the account | Email arrives within a minute or two | **Not tested — no mailbox** |
| Open the link | Lands on `/auth/callback/?code=…`, exchanges the session, redirects to `/auth/reset-password/` | **Not tested** |
| Set a new password | "Password updated", redirect to `/app/` | **Not tested** |
| Sign in with the new password | Works; the old password stops working | **Not tested** |
| Re-open the same link | "already been used" message | **Not tested** (UI verified with a crafted link) |
| Wait past one hour, then open | "expired" message | **Not tested** (UI verified with a crafted link) |
| Open the link in a different browser | "opened in a different browser" message | **Not tested** (UI verified) |

## 4. Five-minute manual checklist

1. Sign in as the account, open `/auth/forgot-password/`, submit the address.
2. Confirm the email arrives. Check spam; Supabase's default sender is rate-limited and often lands in spam until a custom SMTP is configured.
3. Open the link in the same browser. It should pass through `/auth/callback/` and land on "Set a new password".
4. Enter a mismatched confirmation first — the form must refuse locally, without a request.
5. Set a strong password. Expect "Password updated", then `/app/`.
6. Sign out, sign in with the new password. Expect success; the old password must fail with "Email or password is incorrect."
7. Open the same link again. Expect "This reset link has already been used" and a working **Request a new link** button.
8. Request another link, wait for a second email, and open it in a different browser. Expect the "different browser" message rather than a silent failure.

If step 3 lands on the marketing home page instead of the reset screen, the redirect URL allowlist is the cause — add `https://shinzora.in/auth/callback/**` in the Supabase dashboard.

## 5. What is not claimed

- No email was received, opened or clicked by me.
- No password was changed on any real account.
- The request *was* sent to Supabase (verified: HTTP 200 from `/auth/v1/recover`), but "Supabase accepted the request" is not the same as "the message was delivered", and the interface does not claim otherwise.
