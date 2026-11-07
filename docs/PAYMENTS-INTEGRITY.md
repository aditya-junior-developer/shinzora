# Payment integrity — one reference per intent, one event per delivery

Two guarantees, both enforced by the database first and the API second. If the
application logic were wrong tomorrow, the constraints would still hold.

---

## 1. One open reference per customer per purpose (0007)

**Rule.** A customer has at most one *open* payment (status `pending` or
`awaiting_verification`) per purpose. Asking to pay again for the same purpose
returns the existing record and its `SZ-…` reference. A new reference is issued
only when the purpose changes — or when the previous one has finished, because a
customer may legitimately buy the same plan twice.

**Database.** Partial unique index:

```sql
create unique index payments_one_open_per_purpose
  on public.payments (owner_id, purpose)
  where status in ('pending', 'awaiting_verification');
```

Verified, rejected, refunded and cancelled rows are outside the index: they are
history and may repeat a purpose freely.

**API — `supabase/functions/payments/index.ts`.**

1. `findOpenPayment(userId, purpose)` reads the open row and returns it with
   `reused: true`.
2. Otherwise it inserts. If two requests raced past the read, exactly one insert
   wins; the loser receives PostgreSQL `23505`, catches it, re-reads and returns
   the winner. The unique index — not the read — is what makes this safe.

**Sandbox mirror — `server/prelaunch/functions.mjs`.** Same rule, same response
shape, so the two behave identically in testing.

**Tested.**

| Test | Result |
| --- | --- |
| 6 simultaneous `create` calls for `subscription:pro` | 1 reference (`SZ-K3GIFB`), 5 responses with `reused: true` |
| 4 simultaneous calls across different purposes | 4 distinct references |
| `create` again after a proof was submitted | Same reference returned, `reused: true` |
| Stored rows afterwards | 5 payments, exactly one open per purpose, 0 duplicates |
| Database, staging: insert a second open row for the same purpose | Rejected by the index, not by the app |
| Database, staging: new purchase after a verified one | Allowed, new reference |

## 2. One event, one delivery (0008)

**Rule.** A gateway event is applied once. The same delivery arriving twice,
three times, or twice at the same second changes nothing after the first time.

**Database.**

| Object | Guarantee |
| --- | --- |
| `payment_webhook_events` with `unique (provider, event_id)` | A retried delivery cannot be recorded twice, so it is never acted on twice |
| `payments_provider_payment_unique` on `(provider, provider_payment_id)` | One gateway payment can only ever map to one local payment row |
| `notifications_one_per_webhook_event` on `(meta->>'webhook_event_id')` | A replayed event cannot notify the customer twice |

**Code — `supabase/functions/_shared/webhook.ts` + `payments-webhook/index.ts`.**

1. Signature verified with HMAC over the raw body (unchanged, and still the only
   automated path that can set `verified`).
2. The event is *claimed* first: inserted into the inbox. A duplicate loses that
   insert and returns `200 {duplicate: true}` before any payment, subscription or
   notification is touched. If the inbox itself is unreachable the function
   returns 500 on purpose, so the gateway retries rather than the event being
   lost.
3. `classify()` maps the event to `verified` / `failed` / `pending` / `ignored`.
4. `shouldApply(kind, currentStatus)` decides whether the stored payment should
   move at all — a capture on an already-verified payment is a no-op.
5. Notification inserts carry `meta.webhook_event_id`, and a duplicate insert is
   swallowed because it is expected.
6. The inbox row is closed as `processed`, `ignored` or `failed` with the error.

**Idempotency key.** `X-Razorpay-Event-Id` when the gateway sends it; otherwise a
SHA-256 digest of `provider | event | payment id | order id | status | amount |
created_at`. Same event in, same key out; a genuinely new event gets a new key.
Keys are scoped by provider, so two gateways reusing `evt_1` never collide.

**Tested.**

| Test | Result |
| --- | --- |
| Pure logic suite (`_shared/webhook.ts` compiled and run in Node) | 18/18 — key stability, key uniqueness across event/payment/provider, classification of captured/failed/authorized/unknown, and `shouldApply` for all status pairs |
| Staging DB: first delivery, then replay | First applied; replay recognised and skipped |
| Staging DB: effects after replay | exactly 1 event row, 1 notification, 1 verified payment |
| Staging DB: replayed event cannot notify twice | Unique violation, as designed |
| Staging DB: same gateway payment id twice | Rejected by the index |
| Staging DB: out-of-order delivery (failure, then capture) | Ends `verified`, once |
| Staging DB: same event id from a different provider | Treated as a separate event |

## 3. What stays true for money

- Nothing in a browser can set `verified`. The staging run asserts it: a customer
  updating their own payment updates 0 rows.
- Closing the payment window never marks a payment successful — that logic lives
  in `billing.js`, unchanged.
- No financial row is ever deleted. A superseded duplicate becomes `cancelled`
  with an explanation; a rejected payment stays rejected; replayed events add an
  audit row rather than removing one.
- `migration_notes` records, permanently, what 0007 changed and what it found.
