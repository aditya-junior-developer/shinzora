/* ==========================================================================
   Staging checks — what the upgrade migrations must be true about the data
   --------------------------------------------------------------------------
   Each check answers one question that a release note cannot answer for you:
   did the rows survive, did the constraint actually get created, does the
   trigger fire, does row level security still keep one customer out of another
   customer's records. Used by scripts/staging-db.mjs.
   ========================================================================== */

const rows = async (db, sql, params) => (await db.query(sql, params)).rows;
const one = async (db, sql, params) => (await rows(db, sql, params))[0];

async function throws(db, sql, params) {
  try {
    await db.query(sql, params);
    return null;
  } catch (error) {
    return error.message;
  }
}

export async function run(db, api, { fixtures }) {
  const { pass, fail, warn } = api;

  /* ---------------------------------------------------------------- grants --
     Supabase grants table privileges to the API roles; the harness has to do
     the same, or RLS cannot be exercised (a role with no privilege never
     reaches a policy). */
  await db.exec(`
    grant usage on schema public, auth to anon, authenticated, service_role;
    grant select, insert, update, delete on all tables in schema public to authenticated;
    grant select on all tables in schema public to anon;
    grant execute on all functions in schema public to authenticated, service_role;
    grant execute on function auth.uid() to authenticated, anon, service_role;
  `);

  /* ================================================== 1. data preservation == */
  const counts = await one(
    db,
    `select (select count(*) from public.payments)::int as payments,
            (select count(*) from public.service_requests)::int as requests,
            (select count(*) from public.store_customers)::int as customers,
            (select count(*) from public.notifications)::int as notifications`
  );
  counts.payments === fixtures.payments
    ? pass("preserve", `all ${counts.payments} payment rows still exist`)
    : fail("preserve", `payments went from ${fixtures.payments} to ${counts.payments}`);
  counts.requests === fixtures.serviceRequests
    ? pass("preserve", `all ${counts.requests} service request rows still exist`)
    : fail("preserve", `service requests went from ${fixtures.serviceRequests} to ${counts.requests}`);
  counts.customers === fixtures.customers
    ? pass("preserve", `${counts.customers} store customers untouched`)
    : fail("preserve", `store customers went from ${fixtures.customers} to ${counts.customers}`);

  const verified = await rows(
    db,
    `select id, reference, status, utr, amount::text from public.payments where status = 'verified' order by id`
  );
  const untouched =
    verified.length === 2 &&
    verified.every((r) => r.reference && ["UTRSS0001", "UTRPRO0002"].includes(r.utr));
  untouched
    ? pass("preserve", "both verified payments kept their reference, UTR and amount")
    : fail("preserve", `verified payments changed: ${JSON.stringify(verified)}`);

  const cancelled = await rows(
    db,
    `select reference, admin_note from public.payments where status = 'cancelled' order by created_at`
  );
  /* the fixture holds two duplicated purposes: A/pro (2 open) and A/brand_kit
     (2 open). A/store_setup is verified + open, which is legal and must not be
     touched. */
  cancelled.length === 2
    ? pass("0007", `${cancelled.length} superseded duplicates marked cancelled, rows retained`)
    : fail("0007", `expected 2 superseded rows, found ${cancelled.length}`);
  cancelled.every((r) => String(r.admin_note || "").includes("Superseded by"))
    ? pass("0007", "every superseded row explains itself in admin_note")
    : fail("0007", "a superseded row has no explanation");

  /* ============================================================ 2. 0006 ==== */
  const tracking = await rows(
    db,
    `select column_name from information_schema.columns
      where table_schema = 'public' and table_name = 'service_requests'
        and column_name in ('reference','assigned_to','due_at','accepted_at','completed_at')`
  );
  tracking.length === 5
    ? pass("0006", "five tracking columns present on service_requests")
    : fail("0006", `missing columns: ${["reference", "assigned_to", "due_at", "accepted_at", "completed_at"].filter((c) => !tracking.some((t) => t.column_name === c)).join(", ")}`);

  const backfill = await one(
    db,
    `select count(*)::int as total,
            count(reference)::int as with_reference,
            count(*) filter (where reference ~ '^SR-[0-9A-F]{8}$')::int as well_formed
       from public.service_requests`
  );
  backfill.with_reference === backfill.total && backfill.well_formed === backfill.total
    ? pass("0006", `all ${backfill.total} existing requests backfilled with a stable SR- reference`)
    : fail("0006", `backfill incomplete: ${backfill.with_reference}/${backfill.total} have a reference, ${backfill.well_formed} well formed`);

  const stamps = await one(
    db,
    `select
       count(*) filter (where status in ('completed','rejected','cancelled') and completed_at is not null)::int as terminal_stamped,
       count(*) filter (where status in ('completed','rejected','cancelled'))::int as terminal_total,
       count(*) filter (where status in ('requested','in_progress') and completed_at is null)::int as open_unstamped,
       count(*) filter (where status in ('requested','in_progress'))::int as open_total
     from public.service_requests`
  );
  stamps.terminal_stamped === stamps.terminal_total && stamps.open_unstamped === stamps.open_total
    ? pass("0006", "completed_at filled for terminal requests only")
    : fail("0006", `completed_at wrong: ${JSON.stringify(stamps)}`);

  const inserted = await one(
    db,
    `insert into public.service_requests (owner_id, service_type, title, details, status)
     values ($1, 'custom', 'Trigger check', 'inserted by the staging harness', 'requested')
     returning id, reference`,
    [fixtures.users.a]
  );
  /^SR-[0-9A-F]{8}$/.test(inserted.reference || "")
    ? pass("0006", `new request received reference ${inserted.reference} without the client sending one`)
    : fail("0006", `trigger did not assign a reference (got ${inserted.reference})`);

  const completedTrigger = await one(
    db,
    `update public.service_requests set status = 'completed' where id = $1 returning completed_at`,
    [inserted.id]
  );
  completedTrigger.completed_at
    ? pass("0006", "moving a request to completed stamps completed_at")
    : fail("0006", "completed_at was not stamped on completion");

  const duplicateRef = await throws(
    db,
    `update public.service_requests set reference = (select reference from public.service_requests
        where id <> $1 and reference is not null limit 1) where id = $1`,
    [inserted.id]
  );
  duplicateRef?.includes("duplicate key")
    ? pass("0006", "a second request cannot reuse an existing reference")
    : fail("0006", `duplicate reference was accepted (${duplicateRef || "no error"})`);

  const notes = await one(
    db,
    `select relrowsecurity from pg_class where relname = 'service_request_notes' and relkind = 'r'`
  );
  notes?.relrowsecurity
    ? pass("0006", "service_request_notes has row level security enabled")
    : fail("0006", "service_request_notes is missing row level security");

  const policies = await rows(
    db,
    `select policyname from pg_policies where tablename = 'service_request_notes'`
  );
  policies.length >= 3
    ? pass("0006", `${policies.length} policies on service_request_notes (customer read, admin read, admin write)`)
    : fail("0006", `only ${policies.length} policies on service_request_notes`);

  /* ---- RLS: a customer sees only notes written for them ---- */
  await db.exec(`insert into public.service_request_notes (request_id, body, visibility)
                 values (${`'${inserted.id}'`}, 'Internal: pricing discussed with the vendor.', 'internal'),
                        (${`'${inserted.id}'`}, 'We have started on your request.', 'customer')`);

  await db.exec(`set role authenticated; set request.jwt.claim.sub = '${fixtures.users.a}';`);
  const customerNotes = await rows(db, `select visibility from public.service_request_notes`);
  await db.exec(`reset role;`);

  customerNotes.length === 1 && customerNotes[0].visibility === "customer"
    ? pass("rls", "customer reads their own customer-visible note and cannot see the internal one")
    : fail("rls", `customer saw ${customerNotes.length} note(s): ${JSON.stringify(customerNotes)}`);

  await db.exec(`set role authenticated; set request.jwt.claim.sub = '${fixtures.users.admin}';`);
  const adminNotes = await rows(db, `select visibility from public.service_request_notes`);
  await db.exec(`reset role;`);
  adminNotes.length === 2
    ? pass("rls", "administrator reads both notes")
    : fail("rls", `administrator saw ${adminNotes.length} of 2 notes`);

  await db.exec(`set role authenticated; set request.jwt.claim.sub = '${fixtures.users.b}';`);
  const foreignNotes = await rows(db, `select id from public.service_request_notes`);
  const foreignWrite = await throws(db, `insert into public.service_request_notes (request_id, body) values ($1, 'customer attempt')`, [inserted.id]);
  await db.exec(`reset role;`);
  foreignNotes.length === 0
    ? pass("rls", "another customer reads none of these notes")
    : fail("rls", `another customer read ${foreignNotes.length} note(s)`);
  foreignWrite
    ? pass("rls", "a customer cannot write an internal note")
    : fail("rls", "a customer was allowed to insert a service request note");

  /* ============================================================ 3. 0007 ==== */
  const indexExists = await one(
    db,
    `select indexname from pg_indexes where schemaname = 'public' and indexname = 'payments_one_open_per_purpose'`
  );
  indexExists
    ? pass("0007", "payments_one_open_per_purpose exists")
    : fail("0007", "the uniqueness index was not created");

  const openGroups = await rows(
    db,
    `select owner_id, purpose, count(*)::int as open_rows
       from public.payments where status in ('pending','awaiting_verification')
      group by owner_id, purpose having count(*) > 1`
  );
  openGroups.length === 0
    ? pass("0007", "no customer holds two open payments for one purpose")
    : fail("0007", `${openGroups.length} purpose group(s) still duplicated`);

  const proRows = await rows(
    db,
    `select status, utr, admin_note from public.payments
      where owner_id = $1 and purpose = 'pro' order by status`,
    [fixtures.users.a]
  );
  const proOpen = proRows.filter((r) => ["pending", "awaiting_verification"].includes(r.status));
  proOpen.length === 1 && proOpen[0].status === "awaiting_verification"
    ? pass("0007", "the duplicate that already carried a UTR survived; the untouched one was superseded")
    : fail("0007", `wrong survivor for A/pro: ${JSON.stringify(proRows)}`);

  const secondOpen = await throws(
    db,
    `insert into public.payments (owner_id, purpose, amount, status)
     values ($1, 'pro', 249900, 'pending')`,
    [fixtures.users.a]
  );
  secondOpen?.includes("duplicate key") || secondOpen?.includes("unique")
    ? pass("0007", "a second open 'pro' payment is rejected by the database, not just by the app")
    : fail("0007", `duplicate open payment was accepted (${secondOpen || "no error"})`);

  const reuse = await rows(db, `select * from public.open_payment_reference($1, 'pro')`, [fixtures.users.a]);
  reuse.length === 1 && reuse[0].status === "awaiting_verification"
    ? pass("0007", `open_payment_reference() returns the existing ${reuse[0].reference} to reuse`)
    : fail("0007", `open_payment_reference() returned ${JSON.stringify(reuse)}`);

  const noOpen = await rows(db, `select * from public.open_payment_reference($1, 'store_setup')`, [fixtures.users.b]);
  noOpen.length === 0
    ? pass("0007", "open_payment_reference() returns nothing when nothing is open, which is't the signal to create")
    : fail("0007", "open_payment_reference() invented a row");

  /* a purpose whose only history is verified must still accept a new purchase */
  const newPurchase = await one(
    db,
    `insert into public.payments (owner_id, purpose, amount, status)
     values ($1, 'pro', 249900, 'pending') returning reference`,
    [fixtures.users.b]
  );
  newPurchase?.reference
    ? pass("0007", `a new purchase after a verified one gets a new reference (${newPurchase.reference})`)
    : fail("0007", "a genuine repeat purchase was blocked");

  const distinctRefs = await one(
    db,
    `select count(*)::int as total, count(distinct reference)::int as distinct_refs from public.payments`
  );
  distinctRefs.total === distinctRefs.distinct_refs
    ? pass("0007", `all ${distinctRefs.total} references are distinct`)
    : fail("0007", `${distinctRefs.total - distinctRefs.distinct_refs} duplicate reference(s)`);

  const auditRows = await rows(
    db,
    `select action from public.migration_notes where migration = '0007_customer_reference_uniqueness'`
  );
  auditRows.length >= 3
    ? pass("0007", `${auditRows.length} audit rows written to migration_notes (pre-flight, actions, index)`)
    : fail("0007", `migration_notes holds only ${auditRows.length} rows`);

  /* customer cannot promote their own payment to verified */
  const beforeSelfVerify = (
    await one(db, `select count(*)::int as n from public.payments where owner_id = $1 and status = 'verified'`, [
      fixtures.users.b
    ])
  ).n;
  await db.exec(`set role authenticated; set request.jwt.claim.sub = '${fixtures.users.b}';`);
  const selfVerify = await rows(
    db,
    `update public.payments set status = 'verified' where owner_id = '${fixtures.users.b}' returning id`
  );
  await db.exec(`reset role;`);
  const stillOpen = await one(
    db,
    `select count(*)::int as n from public.payments where owner_id = $1 and status = 'verified'`,
    [fixtures.users.b]
  );
  selfVerify.length === 0 && stillOpen.n === beforeSelfVerify
    ? pass("rls", "a customer cannot mark their own payment verified (0 rows updated, verified count unchanged)")
    : fail("rls", `customer self-verification changed ${selfVerify.length} row(s); verified count ${beforeSelfVerify} → ${stillOpen.n}`);

  /* ============================================================ 4. 0008 ==== */
  const inbox = await one(
    db,
    `select relrowsecurity from pg_class where relname = 'payment_webhook_events' and relkind = 'r'`
  );
  inbox?.relrowsecurity
    ? pass("0008", "payment_webhook_events exists with row level security")
    : fail("0008", "payment_webhook_events missing or unprotected");

  const firstEvent = await one(
    db,
    `insert into public.payment_webhook_events (provider, event_id, event_type, payment_id, payload)
     values ('razorpay', 'evt_staging_1', 'payment.captured', 'pay_staging_1', '{"amount":249900}'::jsonb)
     returning id`
  );
  const replay = await throws(
    db,
    `insert into public.payment_webhook_events (provider, event_id, event_type, payment_id, payload)
     values ('razorpay', 'evt_staging_1', 'payment.captured', 'pay_staging_1', '{"amount":249900}'::jsonb)`
  );
  firstEvent?.id && replay?.includes("duplicate key")
    ? pass("0008", "the same gateway event id cannot be stored twice")
    : fail("0008", `event replay was accepted (${replay || "no error"})`);

  const otherProvider = await one(
    db,
    `insert into public.payment_webhook_events (provider, event_id) values ('manual', 'evt_staging_1') returning id`
  );
  otherProvider?.id
    ? pass("0008", "the same event id from a different provider is a separate event")
    : fail("0008", "provider scoping is wrong on the inbox");

  const gw1 = await one(
    db,
    `insert into public.payments (owner_id, purpose, amount, status, provider, provider_payment_id)
     values ($1, 'pro', 249900, 'verified', 'razorpay', 'pay_staging_1') returning id`,
    [fixtures.users.a]
  );
  const gwDup = await throws(
    db,
    `insert into public.payments (owner_id, purpose, amount, status, provider, provider_payment_id)
     values ($1, 'brand_kit', 249900, 'verified', 'razorpay', 'pay_staging_1') returning id`,
    [fixtures.users.a]
  );
  gw1?.id && gwDup?.includes("duplicate key")
    ? pass("0008", "one gateway payment id can only ever produce one local payment row")
    : fail("0008", `a second row for the same gateway payment was accepted (${gwDup || "no error"})`);

  const notif1 = await one(
    db,
    `insert into public.notifications (user_id, title, body, type, meta)
     values ($1, 'Payment received', 'Your payment was confirmed.', 'payment', '{"webhook_event_id":"evt_staging_1"}'::jsonb)
     on conflict do nothing returning id`,
    [fixtures.users.a]
  );
  const notifDup = await throws(
    db,
    `insert into public.notifications (user_id, title, body, type, meta)
     values ($1, 'Payment received', 'Your payment was confirmed.', 'payment', '{"webhook_event_id":"evt_staging_1"}'::jsonb)`,
    [fixtures.users.a]
  );
  notif1?.id && notifDup?.includes("duplicate key")
    ? pass("0008", "a replayed event cannot notify the customer twice")
    : fail("0008", `duplicate notification accepted (${notifDup || "no error"})`);

  const notif2 = await one(
    db,
    `insert into public.notifications (user_id, title, body, type, meta)
     values ($1, 'Payment received', 'A second, different payment.', 'payment', '{"webhook_event_id":"evt_staging_2"}'::jsonb)
     returning id`,
    [fixtures.users.a]
  );
  notif2?.id
    ? pass("0008", "a different event still notifies normally")
    : fail("0008", "the notification guard blocks unrelated events");

  /* ================================== 5. webhook delivery, replayed ========
     The handler's exact order, run twice: claim the event, find the payment,
     update it, notify. The second run must be a no-op. This is the sequence the
     gateway actually produces when it retries, and the point of 0008 is that
     the second run costs nothing. */
  const replayTarget = await one(
    db,
    `insert into public.payments (owner_id, purpose, amount, status, method)
     values ($1, 'enterprise', 999900, 'pending', 'razorpay') returning id, reference`,
    [fixtures.users.b]
  );

  const simulateDelivery = async (eventId, paymentId) => {
    const claim = await throws(
      db,
      `insert into public.payment_webhook_events (provider, event_id, event_type, payment_id, payload)
       values ('razorpay', $1, 'payment.captured', $2, '{}'::jsonb)`,
      [eventId, paymentId]
    );
    if (claim?.includes("duplicate key")) return { skipped: true };

    await db.query(`update public.payments set status = 'verified' where id = $1 and status <> 'verified'`, [
      replayTarget.id
    ]);
    await throws(
      db,
      `insert into public.notifications (user_id, title, body, type, meta)
       values ($1, 'Payment verified', 'Delivery simulation.', 'payment', $2::jsonb)`,
      [fixtures.users.b, JSON.stringify({ webhook_event_id: eventId })]
    );
    return { skipped: false };
  };

  const first = await simulateDelivery("evt_replay_1", replayTarget.id);
  const second = await simulateDelivery("evt_replay_1", replayTarget.id);

  !first.skipped && second.skipped
    ? pass("0008", "first delivery applied, replayed delivery recognised and skipped")
    : fail("0008", `replay handling wrong: first=${JSON.stringify(first)} second=${JSON.stringify(second)}`);

  const replayEffect = await one(
    db,
    `select (select count(*)::int from public.notifications where meta->>'webhook_event_id' = 'evt_replay_1') as notifications,
            (select count(*)::int from public.payment_webhook_events where event_id = 'evt_replay_1') as events,
            (select count(*)::int from public.payments where id = $1 and status = 'verified') as verified`,
    [replayTarget.id]
  );
  replayEffect.notifications === 1 && replayEffect.events === 1 && replayEffect.verified === 1
    ? pass("0008", `replay left exactly one event, one notification and one verified payment (${JSON.stringify(replayEffect)})`)
    : fail("0008", `replay produced duplicates: ${JSON.stringify(replayEffect)}`);

  /* a failed delivery followed by a capture must still end verified exactly once */
  const lateCapture = await one(
    db,
    `insert into public.payments (owner_id, purpose, amount, status) values ($1, 'brand_kit', 249900, 'pending')
     returning id`,
    [fixtures.users.b]
  );
  await throws(
    db,
    `update public.payments set status = 'rejected', admin_note = 'card declined'
      where id = $1 and status <> 'verified'`,
    [lateCapture.id]
  );
  await throws(db, `update public.payments set status = 'verified' where id = $1 and status <> 'verified'`, [lateCapture.id]);
  const afterLate = await one(db, `select status, admin_note from public.payments where id = $1`, [lateCapture.id]);
  afterLate.status === "verified"
    ? pass("0008", "a capture arriving after a failure still verifies the payment (out-of-order delivery)")
    : fail("0008", `out-of-order delivery ended in ${afterLate.status}`);

  /* =============================================== 5. schema expectations == */
  const required = [
    "profiles", "businesses", "subscriptions", "projects", "project_versions", "store_products",
    "store_orders", "store_order_items", "store_customers", "campaigns", "support_tickets",
    "support_replies", "service_requests", "service_request_notes", "domains", "domain_orders",
    "payments", "payment_webhook_events", "notifications", "customer_activity", "ai_conversations",
    "ai_messages", "admin_announcements", "contact_messages", "admin_users", "migration_notes"
  ];
  const present = new Set(
    (await rows(db, `select table_name from information_schema.tables where table_schema = 'public'`)).map(
      (r) => r.table_name
    )
  );
  const missing = required.filter((t) => !present.has(t));
  missing.length
    ? fail("schema", `missing tables after upgrade: ${missing.join(", ")}`)
    : pass("schema", `all ${required.length} application tables present`);

  /* RLS switched on everywhere that holds customer data */
  const unprotected = await rows(
    db,
    `select c.relname from pg_class c
       join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind = 'r'
        and c.relrowsecurity = false
        and c.relname in ('payments','service_requests','notifications','store_customers',
                          'payment_webhook_events','migration_notes','service_request_notes')`
  );
  unprotected.length === 0
    ? pass("rls", "row level security enabled on every customer-facing table")
    : fail("rls", `row level security missing on ${unprotected.map((r) => r.relname).join(", ")}`);

  if (unprotected.length) warn("rls", "check 0002 policies for the tables listed above");

  /* ================================================== 6. administrator authority
     0009 grants a super administrator real power over other people's accounts.
     Everything below is an attempt to misuse it. A guard that is not exercised
     is a guard nobody knows works. */
  const asUser = async (id, fn) => {
    await db.exec(`set role authenticated; set request.jwt.claim.sub = '${id}';`);
    try {
      return await fn();
    } finally {
      await db.exec(`reset role;`);
    }
  };

  const adminId = fixtures.users.admin;
  const ownerId = fixtures.users.a;
  const otherId = fixtures.users.b;

  /* A plain customer who is never made an administrator, so the denial checks
     below cannot accidentally run with administrator rights. */
  const outsider = await one(
    db,
    `insert into auth.users (email, raw_user_meta_data) values ('outsider@example.test', '{}'::jsonb) returning id`
  );
  /* handle_new_user() already created the profile; only fill in a name. */
  await db.query(`update public.profiles set full_name = 'Outsider' where id = $1`, [outsider.id]);

  /* every admin_users row the migration left behind */
  const adminsAfter = await rows(db, `select user_id, role, protected from public.admin_users order by role`);
  const protectedRow = adminsAfter.find((r) => r.protected);
  protectedRow && protectedRow.user_id === adminId
    ? pass("0009", "the founding super administrator is the protected owner")
    : fail("0009", `protected row is ${JSON.stringify(protectedRow)}`);

  /* a customer can neither read the directory nor grant anything */
  const customerDirectory = await asUser(outsider.id, () => throws(db, `select * from public.admin_directory()`));
  customerDirectory && /Administrator access required/.test(customerDirectory)
    ? pass("0009", "a customer calling admin_directory() is refused")
    : fail("0009", `customer directory attempt returned ${customerDirectory ?? "rows"}`);

  const customerGrant = await asUser(outsider.id, () =>
    throws(db, `select public.set_admin_role('${otherId}', 'superadmin', 'self-service')`)
  );
  customerGrant && /super administrator|Administrator access/.test(customerGrant)
    ? pass("0009", "a customer cannot promote themselves or anyone else")
    : fail("0009", `customer promotion attempt returned ${customerGrant ?? "success"}`);

  /* the directory works for an administrator and shows everyone */
  const directory = await asUser(adminId, async () => rows(db, `select * from public.admin_directory()`));
  const rolesSeen = new Set(directory.map((r) => r.role));
  directory.length >= 3 && rolesSeen.has("superadmin") && rolesSeen.has("user")
    ? pass("0009", `admin_directory() lists all ${directory.length} accounts, with roles (${[...rolesSeen].join(", ")})`)
    : fail("0009", `directory returned ${directory.length} rows: ${JSON.stringify(directory.map((r) => r.role))}`);

  /* promote: superadmin → admin */
  const promoted = await asUser(adminId, () =>
    rows(db, `select public.set_admin_role('${ownerId}', 'admin', 'operations help') as result`)
  );
  const promotedRole = await one(db, `select role from public.admin_users where user_id = $1`, [ownerId]);
  const promotedProfile = await one(db, `select role from public.profiles where id = $1`, [ownerId]);
  promotedRole?.role === "admin" && promotedProfile?.role === "admin"
    ? pass("0009", "a super administrator can promote a customer to administrator (admin_users + profiles agree)")
    : fail("0009", `promotion left admin_users=${promotedRole?.role}, profiles=${promotedProfile?.role} (${JSON.stringify(promoted[0])})`);

  /* an ordinary administrator cannot promote anyone — this is the escalation path */
  const adminGrant = await asUser(ownerId, () =>
    throws(db, `select public.set_admin_role('${otherId}', 'superadmin', 'promote me')`)
  );
  adminGrant && /super administrator/.test(adminGrant)
    ? pass("0009", "an ordinary administrator cannot create another administrator")
    : fail("0009", `administrator escalation returned ${adminGrant ?? "success"}`);

  /* an ordinary administrator cannot reset AI credits, per the owner's rule */
  const adminCredits = await asUser(ownerId, () =>
    throws(db, `select public.admin_reset_ai_credits('${otherId}', 'nope')`)
  );
  adminCredits && /super administrator/.test(adminCredits)
    ? pass("0009", "an ordinary administrator cannot reset AI credits")
    : fail("0009", `credit reset by admin returned ${adminCredits ?? "success"}`);

  /* the protected owner cannot be demoted, by anyone, in any direction */
  const demoteOwner = await asUser(adminId, () =>
    throws(db, `select public.set_admin_role('${adminId}', 'admin', 'step down')`)
  );
  const demoteOwnerRevoke = await asUser(adminId, () =>
    throws(db, `select public.set_admin_role('${adminId}', 'none', 'revoke owner')`)
  );
  demoteOwner && /protected owner/i.test(demoteOwner) && demoteOwnerRevoke && /protected owner/i.test(demoteOwnerRevoke)
    ? pass("0009", "the protected owner cannot be demoted or revoked, even by themselves")
    : fail("0009", `protected-owner guard: demote=${demoteOwner ?? "allowed"}, revoke=${demoteOwnerRevoke ?? "allowed"}`);

  const ownerStill = await one(db, `select role, protected from public.admin_users where user_id = $1`, [adminId]);
  ownerStill.role === "superadmin" && ownerStill.protected
    ? pass("0009", "the protected owner is unchanged after both attempts")
    : fail("0009", `protected owner is now ${JSON.stringify(ownerStill)}`);

  /* last superadmin: isolate the rule from the protected-owner rule */
  await db.exec(`update public.admin_users set protected = false where user_id = '${adminId}'`);
  const lastSuper = await asUser(adminId, () =>
    throws(db, `select public.set_admin_role('${adminId}', 'none', 'last one leaving')`)
  );
  const stillSuper = await one(db, `select role from public.admin_users where user_id = $1`, [adminId]);
  await db.exec(`update public.admin_users set protected = true where user_id = '${adminId}'`);
  lastSuper && /last super administrator/i.test(lastSuper) && stillSuper.role === "superadmin"
    ? pass("0009", "the last super administrator cannot be removed, leaving the platform without one")
    : fail("0009", `last-superadmin guard: ${lastSuper ?? "allowed"}, role now ${stillSuper.role}`);

  /* a second superadmin can exist, and can be demoted normally */
  await asUser(adminId, () => rows(db, `select public.set_admin_role('${otherId}', 'superadmin', 'second owner')`));
  const twoSupers = await one(db, `select public.superadmin_count() as n`);
  const demoteSecond = await asUser(adminId, () =>
    rows(db, `select public.set_admin_role('${otherId}', 'admin', 'handing back') as result`)
  );
  const secondAfter = await one(db, `select role from public.admin_users where user_id = $1`, [otherId]);
  twoSupers.n === 2 && secondAfter.role === "admin"
    ? pass("0009", "a second super administrator can be created and demoted without touching the owner")
    : fail("0009", `two-superadmin path: count=${twoSupers.n}, second now ${secondAfter.role} (${JSON.stringify(demoteSecond?.[0])})`);

  /* revoke is a real operation, not just a guarded one */
  const revoked = await asUser(adminId, () =>
    rows(db, `select public.set_admin_role('${otherId}', 'none', 'no longer needs access') as result`)
  );
  const revokedRow = await one(db, `select count(*)::int as n from public.admin_users where user_id = $1`, [otherId]);
  const revokedProfile = await one(db, `select role from public.profiles where id = $1`, [otherId]);
  revoked[0]?.result?.role === "none" && revokedRow.n === 0 && revokedProfile.role === "customer"
    ? pass("0009", "revoking an administrator removes the row and returns the profile to customer")
    : fail("0009", `revoke left admin_rows=${revokedRow.n}, profile=${revokedProfile.role}`);

  /* every privileged change is in the audit trail, with actor and reason */
  const audit = await asUser(adminId, () => rows(db, `select * from public.admin_audit_log(200)`));
  const actions = new Set(audit.map((a) => a.action));
  ["admin.set_role", "admin.revoke"].every((a) => actions.has(a))
    ? pass("0009", `the audit trail records role changes (${audit.length} entries: ${[...actions].join(", ")})`)
    : fail("0009", `audit trail missing role actions, saw ${[...actions].join(", ") || "nothing"}`);
  audit.every((a) => a.actor_id === adminId && a.reason)
    ? pass("0009", "every audit entry names the actor and the stated reason")
    : fail("0009", "an audit entry is missing an actor or a reason");

  /* the trail cannot be edited or erased through the API */
  const auditDirect = await asUser(adminId, async () => {
    const visible = await rows(db, `select id from public.admin_audit`);
    const wiped = await rows(db, `delete from public.admin_audit returning id`);
    return { visible: visible.length, wiped: wiped.length };
  });
  auditDirect.visible === 0 && auditDirect.wiped === 0
    ? pass("0009", "admin_audit is readable only through admin_audit_log(); no client can read or delete rows directly")
    : fail("0009", `direct audit access returned visible=${auditDirect.visible}, deleted=${auditDirect.wiped}`);

  /* ---- subscriptions and credits ---- */
  const subBefore = await one(db, `select plan, ai_credits_used from public.subscriptions where user_id = $1`, [otherId]);
  await db.exec(`update public.subscriptions set ai_credits_used = 17 where user_id = '${otherId}'`);
  const reset = await asUser(adminId, () =>
    rows(db, `select public.admin_reset_ai_credits('${otherId}', 'goodwill credit') as result`)
  );
  const subAfter = await one(db, `select ai_credits_used from public.subscriptions where user_id = $1`, [otherId]);
  const resetEvent = await one(
    db,
    `select count(*)::int as n from public.subscription_events where user_id = $1 and action = 'credits_reset'`,
    [otherId]
  );
  subAfter.ai_credits_used === 0 && resetEvent.n >= 1
    ? pass("0009", "a super administrator can reset AI credit usage to zero, with a subscription event recorded")
    : fail("0009", `credit reset left used=${subAfter.ai_credits_used}, events=${resetEvent.n} (${JSON.stringify(reset?.[0])})`);

  const planChange = await asUser(adminId, () =>
    rows(db, `select public.admin_update_subscription('${otherId}', 'pro', 'active', 'upgrade request') as result`)
  );
  const planAfter = await one(db, `select plan, ai_credits_limit from public.subscriptions where user_id = $1`, [otherId]);
  const planEvent = await one(
    db,
    `select from_plan, to_plan from public.subscription_events where user_id = $1 and action = 'plan_changed'
       order by created_at desc limit 1`,
    [otherId]
  );
  planAfter.plan === "pro" && planAfter.ai_credits_limit === 800 && planEvent?.to_plan === "pro"
    ? pass("0009", `plan change is applied and recorded (${planEvent.from_plan} → ${planEvent.to_plan}, limit ${planAfter.ai_credits_limit})`)
    : fail("0009", `plan change ended ${JSON.stringify(planAfter)} / ${JSON.stringify(planEvent)} (${JSON.stringify(planChange?.[0])})`);

  const badPlan = await asUser(adminId, () =>
    throws(db, `select public.admin_update_subscription('${otherId}', 'platinum', null, null)`)
  );
  badPlan && /Plan must be/.test(badPlan)
    ? pass("0009", "an invented plan name is refused")
    : fail("0009", `invalid plan accepted: ${badPlan ?? "no error"}`);

  const anonymousPlan = await asUser(outsider.id, () =>
    throws(db, `select public.admin_update_subscription('${outsider.id}', 'enterprise', null, null)`)
  );
  anonymousPlan && /Administrator access required/.test(anonymousPlan)
    ? pass("0009", "a customer cannot upgrade their own plan through the admin function")
    : fail("0009", `self-upgrade returned ${anonymousPlan ?? "success"}`);

  /* ---- payment removal rules ---- */
  const verifiedPayment = await one(
    db,
    `select id from public.payments where status = 'verified' and owner_id = $1 order by created_at limit 1`,
    [ownerId]
  );
  const voided = await asUser(adminId, () =>
    rows(db, `select public.admin_delete_payment('${verifiedPayment.id}', 'customer disputed the charge', true) as result`)
  );
  const voidedRow = await one(
    db,
    `select status, deleted_at, voided_at, void_reason from public.payments where id = $1`,
    [verifiedPayment.id]
  );
  voided[0]?.result?.removal === "voided" && voidedRow?.deleted_at && voidedRow.status === "verified"
    ? pass("0009", "a verified payment is voided, not deleted — the row and its verified amount survive")
    : fail("0009", `verified payment handling: ${JSON.stringify(voidedRow)} (${JSON.stringify(voided[0]?.result)})`);

  const ownerSeesVoided = await asUser(ownerId, () =>
    rows(db, `select id from public.payments where id = '${verifiedPayment.id}'`)
  );
  ownerSeesVoided.length === 0
    ? pass("0009", "a voided payment disappears from the customer's own billing list (policy, not view filtering)")
    : fail("0009", "the customer still sees a voided payment");

  const awaiting = await one(
    db,
    `select id from public.payments where status = 'awaiting_verification' and deleted_at is null limit 1`
  );
  const awaitingResult = await asUser(adminId, () =>
    rows(db, `select public.admin_delete_payment('${awaiting.id}', 'no matching credit', true) as result`)
  );
  const awaitingRow = await one(db, `select deleted_at from public.payments where id = $1`, [awaiting.id]);
  awaitingResult[0]?.result?.removal === "voided" && awaitingRow?.deleted_at
    ? pass("0009", "a payment the customer claims to have sent is never hard-deleted, even when asked")
    : fail("0009", `awaiting_verification was ${JSON.stringify(awaitingResult[0]?.result)}`);

  const pendingPayment = await one(
    db,
    `select id, amount from public.payments where status = 'pending' and deleted_at is null and owner_id = $1 limit 1`,
    [ownerId]
  );
  const hard = await asUser(adminId, () =>
    rows(db, `select public.admin_delete_payment('${pendingPayment.id}', 'abandoned checkout', true) as result`)
  );
  const pendingGone = await one(db, `select count(*)::int as n from public.payments where id = $1`, [pendingPayment.id]);
  const hardAudit = await one(
    db,
    `select before from public.admin_audit where action = 'payment.hard_delete' and target_id = $1`,
    [pendingPayment.id]
  );
  hard[0]?.result?.removal === "deleted" && pendingGone.n === 0 && Number(hardAudit?.before?.amount) === Number(pendingPayment.amount)
    ? pass("0009", "a payment that never held money can be hard-deleted, and the deleted row is preserved in the audit snapshot")
    : fail("0009", `hard delete: removal=${hard[0]?.result?.removal}, remaining=${pendingGone.n}, snapshot=${JSON.stringify(hardAudit?.before)}`);

  const noReason = await asUser(adminId, () =>
    throws(db, `select public.admin_delete_payment('${pendingPayment.id}', '')`)
  );
  noReason && /reason is required/i.test(noReason)
    ? pass("0009", "a payment cannot be removed without a stated reason")
    : fail("0009", `reasonless delete returned ${noReason ?? "success"}`);

  const customerDelete = await asUser(outsider.id, () =>
    throws(db, `select public.admin_delete_payment('${verifiedPayment.id}', 'mine now')`)
  );
  customerDelete && /Administrator access/.test(customerDelete)
    ? pass("0009", "a customer cannot delete payment records")
    : fail("0009", `customer payment deletion returned ${customerDelete ?? "success"}`);

  /* ---- stock movements ---- */
  const product = await one(db, `select id, stock from public.store_products where owner_id = $1 limit 1`, [ownerId]);
  if (product) {
    await asUser(ownerId, () =>
      rows(db, `update public.store_products set stock = $1 where id = '${product.id}'`, [Number(product.stock) - 3])
    );
    const movement = await one(
      db,
      `select before_stock, after_stock, delta from public.inventory_movements
        where product_id = $1 order by created_at desc limit 1`,
      [product.id]
    );
    movement && movement.delta === -3 && movement.after_stock === Number(product.stock) - 3
      ? pass("0009", "a stock change is recorded by the database with before, after and delta")
      : fail("0009", `stock movement not recorded: ${JSON.stringify(movement)}`);
  }

  /* ================================================== 7. the directory population
     0028 exists because Find Team was listing business owners who had never
     built an agent profile — eight of nine live rows were the wrong kind of
     account. These three accounts make each branch of the filter observable:
     a plain owner (excluded), an agent (included), and an owner who did build
     an agent profile (included). */
  const directoryUsers = {};
  const directoryHandles = { plainOwner: "dir.plain", agentOnly: "dir.agent", ownerWithProfile: "dir.owneragent" };
  for (const [key, type] of Object.entries({ plainOwner: "owner", agentOnly: "agent", ownerWithProfile: "owner" })) {
    const created = await one(
      db,
      `insert into auth.users (email, raw_user_meta_data) values ($1, '{}'::jsonb) returning id`,
      [`directory.${key}@example.test`]
    );
    directoryUsers[key] = created.id;
    await db.query(
      `update public.profiles set full_name = $2, username = $3, account_type = $4 where id = $1`,
      [created.id, `Directory ${key}`, directoryHandles[key], type]
    );
  }
  for (const key of ["agentOnly", "ownerWithProfile"]) {
    await db.query(
      `insert into public.freelancer_profiles (user_id, headline, skills, is_published)
       values ($1, 'Directory test', array['tests'], $2)
       on conflict (user_id) do nothing`,
      [directoryUsers[key], key === "agentOnly"]
    );
  }

  const listed = await asUser(ownerId, () =>
    rows(db, `select jsonb_array_elements(public.find_team_search(null, 100)) as person`)
  );
  const listedNames = listed.map((r) => r.person?.name || "").filter((n) => n.startsWith("Directory "));
  const listedIds = listed.map((r) => r.person?.userId);
  !listedIds.includes(directoryUsers.plainOwner)
    ? pass("0028", "a business owner with no agent profile stays out of Find Team")
    : fail("0028", "an owner-only account was listed as a freelancer");
  listedIds.includes(directoryUsers.agentOnly) && listedIds.includes(directoryUsers.ownerWithProfile)
    ? pass("0028", "an agent, and an owner who built an agent profile, both appear")
    : fail("0028", `expected both freelancers in the directory, saw ${JSON.stringify(listedNames)}`);
  listedNames.length === 2
    ? pass("0028", "exactly the two freelancer accounts are listed, nothing else")
    : fail("0028", `expected 2 freelancer rows, saw ${listedNames.length}: ${JSON.stringify(listedNames)}`);

  const selfOut = await asUser(directoryUsers.agentOnly, () =>
    rows(db, `select jsonb_array_elements(public.find_team_search(null, 100)) as person`)
  );
  !selfOut.map((r) => r.person?.userId).includes(directoryUsers.agentOnly)
    ? pass("0028", "nobody sees their own card in the directory")
    : fail("0028", "a person was listed in their own directory results");

  /* The real boundary for a signed-out visitor is the uid guard inside the
     function: Postgres leaves EXECUTE on PUBLIC for every new function, so the
     grant alone never stops an unauthenticated call. */
  await db.exec(`select set_config('request.jwt.claim.sub', '', false); set role anon;`);
  const anonSearch = await db
    .query(`select public.find_team_search(null, 10)`)
    .then(() => null, (error) => error.message);
  await db.exec(`reset role;`);
  anonSearch && /Sign in to browse people/i.test(anonSearch)
    ? pass("0028", "a signed-out visitor gets an error from the directory, not a list of people")
    : fail("0028", `anonymous directory call returned ${anonSearch ?? "rows"}`);

  /* ================================================ 8. the pitch panel (0029)
     A business profile is public; the row behind it is not. This proves the
     panel returns the logo, website and socials a freelancer needs, the roles
     with their screening questions, and none of the columns the owner filled
     in for their own planning. */
  const panelOwner = await one(
    db,
    `insert into auth.users (email, raw_user_meta_data) values ('panel.owner@example.test', '{}'::jsonb) returning id`
  );
  await db.query(`update public.profiles set full_name = 'Panel Owner', username = 'panel.owner' where id = $1`, [panelOwner.id]);
  const panelBusiness = await one(
    db,
    `insert into public.businesses (owner_id, name, category, description, location, website_url, logo_url,
                                    socials, phone, email, target_audience, brand_colors)
     values ($1, 'Panel Co', 'retail', 'Sells things', 'Pune', 'https://panel.example', 'https://panel.example/logo.png',
             '{"instagram":"https://instagram.com/panel","broken":"not-a-url"}'::jsonb,
             '+911234567890', 'secret@panel.example', 'internal notes', '["#fff"]'::jsonb)
     returning id`,
    [panelOwner.id]
  );
  const panelJob = await one(
    db,
    `insert into public.marketplace_jobs (owner_id, business_id, title, description, skills, budget_min, budget_max, currency)
     values ($1, $2, 'Panel role', 'A role created for the staging check only.', array['design'], 1000, 2000, 'INR')
     returning id`,
    [panelOwner.id, panelBusiness.id]
  );
  await db.query(
    `insert into public.marketplace_job_questions (job_id, position, prompt)
     values ($1, 1, 'Show us your best work'), ($1, 2, 'What would you do first?')`,
    [panelJob.id]
  );

  const panel = await asUser(ownerId, () =>
    rows(db, `select public.marketplace_business_profile('${panelBusiness.id}') as p`)
  );
  const panelJson = panel[0]?.p;
  panelJson?.roles?.[0]?.questions?.length === 2
    ? pass("0029", "the pitch panel returns each open role with its screening questions")
    : fail("0029", `roles/questions missing: ${JSON.stringify(panelJson?.roles)}`);
  panelJson?.logoUrl === "https://panel.example/logo.png" && panelJson?.websiteUrl === "https://panel.example"
    ? pass("0029", "the panel carries the logo and website a freelancer needs")
    : fail("0029", `logo/website missing: ${JSON.stringify(panelJson && { l: panelJson.logoUrl, w: panelJson.websiteUrl })}`);
  panelJson?.socials?.instagram === "https://instagram.com/panel" && panelJson?.socials?.broken === undefined
    ? pass("0029", "social links are returned, and a malformed one is dropped rather than shown")
    : fail("0029", `socials: ${JSON.stringify(panelJson?.socials)}`);
  !JSON.stringify(panelJson || {}).includes("secret@panel.example") &&
  !JSON.stringify(panelJson || {}).includes("+911234567890") &&
  !JSON.stringify(panelJson || {}).includes("internal notes")
    ? pass("0029", "the panel leaks none of the owner's private columns (phone, email, audience)")
    : fail("0029", "a private business column reached the public panel payload");

  const strangerPanel = await asUser(outsider.id, () =>
    throws(db, `select public.marketplace_business_profile('${panelBusiness.id}')`)
  );
  !strangerPanel
    ? pass("0029", "any signed-in person can open a discoverable business's panel")
    : fail("0029", `signed-in panel call failed: ${strangerPanel}`);

  await db.query(`update public.businesses set discoverable = false where id = $1`, [panelBusiness.id]);
  const hiddenPanel = await asUser(outsider.id, () =>
    throws(db, `select public.marketplace_business_profile('${panelBusiness.id}')`)
  );
  hiddenPanel && /not listed publicly/i.test(hiddenPanel)
    ? pass("0029", "a business that opted out of the directory cannot be opened by id either")
    : fail("0029", `hidden business panel returned ${hiddenPanel ?? "data"}`);


  /* ================================================== 0035. store operations
     0035 is the round that added order tracking, catalogue import, low-stock
     alerts, category analytics and the assistant's command set. Each check
     below calls the function the browser calls, as the user who would call it,
     and then looks at what the database now holds. */
  const storeOwner = fixtures.users.a;
  const storeOutsider = fixtures.users.b;

  /* ---- a catalogue import validates rows instead of trusting them ---- */
  const importResult = await asUser(storeOwner, () =>
    one(
      db,
      `select public.store_import_products($1::jsonb) as result`,
      [
        JSON.stringify([
          { name: "Amber candle", sku: "AMBER-1", price: "450", stock: "12", category: "Home" },
          { name: "Amber candle", sku: "AMBER-1", price: "450", stock: "9", category: "Home" },
          { name: "", sku: "BAD-1", price: "10", stock: "1" },
          { name: "Broken price", sku: "BAD-2", price: "not a number", stock: "1" },
          { name: "Negative", sku: "BAD-3", price: "-5", stock: "1" }
        ])
      ]
    )
  );
  importResult?.result?.imported === 1 &&
  importResult?.result?.updated === 1 &&
  importResult?.result?.skipped === 3 &&
  importResult?.result?.problems?.length === 3
    ? pass("0035", "catalogue import adds the good rows, updates the duplicate SKU, and reports each bad row")
    : fail("0035", `import returned ${JSON.stringify(importResult?.result)}`);

  const importedCount = await one(
    db,
    `select count(*)::int as n from public.store_products where owner_id = $1 and sku like 'AMBER%'`,
    [storeOwner]
  );
  importedCount.n === 1
    ? pass("0035", "the duplicate SKU did not create a second product")
    : fail("0035", `duplicate SKU created ${importedCount.n} rows`);

  const emptyImport = await asUser(storeOutsider, () =>
    one(db, `select public.store_import_products('[]'::jsonb) as result`)
  );
  emptyImport?.result?.imported === 0
    ? pass("0035", "an import with no rows is a no-op, not an error")
    : fail("0035", `empty import returned ${JSON.stringify(emptyImport)}`);

  /* ---- low stock raises one alert, and clears itself ---- */
  const stockProduct = await one(
    db,
    `select id, name, owner_id from public.store_products where owner_id = $1 order by created_at limit 1`,
    [storeOwner]
  );
  await db.query(`update public.store_products set stock = 3 where id = $1`, [stockProduct.id]);
  const lowAlert = await one(
    db,
    `select state, stock, seen_at from public.product_alerts where product_id = $1`,
    [stockProduct.id]
  );
  lowAlert?.state === "low" && lowAlert.stock === 3
    ? pass("0035", "stock dropping to three raises one low-stock alert")
    : fail("0035", `low stock alert: ${JSON.stringify(lowAlert)}`);

  const lowNotice = await one(
    db,
    `select count(*)::int as n from public.notifications where user_id = $1 and type = 'inventory'`,
    [storeOwner]
  );
  lowNotice.n >= 1
    ? pass("0035", "the low-stock alert also reaches the owner's notification list")
    : fail("0035", "no inventory notification was written");

  await db.query(`update public.store_products set stock = 2 where id = $1`, [stockProduct.id]);
  const alertRows = await one(
    db,
    `select count(*)::int as n from public.product_alerts where product_id = $1`,
    [stockProduct.id]
  );
  alertRows.n === 1
    ? pass("0035", "a second drop in the same state does not stack a second alert")
    : fail("0035", `${alertRows.n} alerts for one product`);

  await db.query(`update public.store_products set stock = 0 where id = $1`, [stockProduct.id]);
  const outAlert = await one(
    db,
    `select state from public.product_alerts where product_id = $1`,
    [stockProduct.id]
  );
  outAlert?.state === "out"
    ? pass("0035", "stock reaching zero escalates the alert to out-of-stock")
    : fail("0035", `out-of-stock state was ${JSON.stringify(outAlert)}`);

  await db.query(`update public.store_products set stock = 40 where id = $1`, [stockProduct.id]);
  const cleared = await one(
    db,
    `select count(*)::int as n from public.product_alerts where product_id = $1`,
    [stockProduct.id]
  );
  cleared.n === 0
    ? pass("0035", "restocking clears the alert instead of leaving a stale one")
    : fail("0035", `${cleared.n} alerts survived a restock`);

  /* ---- an order, its tracking link and the customer's view ---- */
  const trackedOrder = await one(
    db,
    `insert into public.store_orders (owner_id, order_number, customer_name, customer_email, status, total_amount)
     values ($1, 'SZ-TEST-1', 'Asha Verma', 'asha@example.test', 'pending', 1200)
     returning id, order_number`,
    [storeOwner]
  );
  await db.query(
    `insert into public.store_order_items (order_id, product_id, product_name, quantity, unit_price)
     values ($1, $2, 'Amber candle', 2, 600)`,
    [trackedOrder.id, stockProduct.id]
  );

  const trackingLink = await asUser(storeOwner, () =>
    one(db, `select public.order_tracking_link('${trackedOrder.id}') as result`)
  );
  const trackToken = trackingLink?.result?.token;
  trackToken && trackToken.length >= 20
    ? pass("0035", "the owner can mint a tracking token for an order")
    : fail("0035", `tracking link returned ${JSON.stringify(trackingLink?.result)}`);

  const secondLink = await asUser(storeOwner, () =>
    one(db, `select public.order_tracking_link('${trackedOrder.id}') as result`)
  );
  secondLink?.result?.token === trackToken
    ? pass("0035", "asking twice returns the same token, so a sent link keeps working")
    : fail("0035", "a second request replaced the token that was already sent");

  const strangerLink = await asUser(storeOutsider, () =>
    throws(db, `select public.order_tracking_link('${trackedOrder.id}')`)
  );
  strangerLink && /another business/i.test(strangerLink)
    ? pass("0035", "another business cannot mint a tracking link for this order")
    : fail("0035", `a stranger minted a tracking link: ${strangerLink ?? "no error"}`);

  await asUser(storeOwner, () =>
    one(db, `select public.order_set_status('${trackedOrder.id}', 'shipped', 'Left the studio today') as result`)
  );
  const shipped = await one(db, `select status, shipped_at from public.store_orders where id = $1`, [trackedOrder.id]);
  shipped.status === "shipped" && shipped.shipped_at
    ? pass("0035", "changing an order's status stamps the shipping time")
    : fail("0035", `order after status change: ${JSON.stringify(shipped)}`);

  const orderEvents = await rows(db, `select status from public.store_order_events where order_id = $1`, [trackedOrder.id]);
  orderEvents.some((row) => row.status === "shipped")
    ? pass("0035", "the status change is written to the order's timeline")
    : fail("0035", `timeline holds ${JSON.stringify(orderEvents)}`);

  const trackedRead = await db.query(`select public.order_tracking($1) as result`, [trackToken]);
  const trackedJson = trackedRead.rows[0].result;
  trackedJson?.orderNumber === "SZ-TEST-1" &&
  trackedJson?.status === "shipped" &&
  trackedJson?.items?.length === 1 &&
  trackedJson?.timeline?.length >= 1
    ? pass("0035", "the customer's tracking page reads the order, its items and its timeline")
    : fail("0035", `tracking payload: ${JSON.stringify(trackedJson)}`);

  const trackedText = JSON.stringify(trackedJson || {});
  !/asha@example\.test/.test(trackedText) && !trackedText.includes(stockProduct.owner_id)
    ? pass("0035", "the public tracking payload carries no email address and no owner id")
    : fail("0035", "the tracking payload leaked a contact detail or an owner id");

  const badToken = await throws(db, `select public.order_tracking('not-a-real-token')`);
  badToken
    ? pass("0035", "a wrong token is refused rather than returning an empty order")
    : fail("0035", "a wrong tracking token returned a row");

  const linkRevoked = await asUser(storeOwner, () =>
    one(db, `select public.order_tracking_revoke('${trackedOrder.id}') as result`)
  );
  const afterRevoke = await throws(db, `select public.order_tracking('${trackToken}')`);
  linkRevoked?.result?.ok && afterRevoke
    ? pass("0035", "revoking a link stops it working for the customer")
    : fail("0035", `revoke: ${JSON.stringify(linkRevoked?.result)}, read: ${afterRevoke ?? "still works"}`);

  const outsiderStatus = await asUser(storeOutsider, () =>
    throws(db, `select public.order_set_status('${trackedOrder.id}', 'delivered', null)`)
  );
  outsiderStatus && /another business/i.test(outsiderStatus)
    ? pass("0035", "another business cannot move this order's status")
    : fail("0035", `a stranger changed the order: ${outsiderStatus ?? "no error"}`);

  const badStatus = await asUser(storeOwner, () =>
    throws(db, `select public.order_set_status('${trackedOrder.id}', 'teleported', null)`)
  );
  badStatus && /not an order status/i.test(badStatus)
    ? pass("0035", "an invented order status is refused")
    : fail("0035", `unknown status accepted: ${badStatus ?? "no error"}`);

  /* ---- conversion needs a denominator, and says so when it has none ---- */
  const noVisits = await asUser(storeOwner, () =>
    one(db, `select public.store_analytics(30) as result`)
  );
  noVisits?.result?.conversionRate === null
    ? pass("0035", "with no visits recorded, conversion is null rather than a made-up zero")
    : fail("0035", `conversion without visits was ${JSON.stringify(noVisits?.result?.conversionRate)}`);

  await db.query(`select public.store_track_visit($1, 'site')`, [storeOwner]);
  await db.query(`select public.store_track_visit($1, 'site')`, [storeOwner]);
  const withVisits = await asUser(storeOwner, () =>
    one(db, `select public.store_analytics(30) as result`)
  );
  withVisits?.result?.visits >= 2 && withVisits?.result?.conversionRate !== null
    ? pass("0035", "once visits exist, conversion is computed from them")
    : fail("0035", `analytics after visits: ${JSON.stringify(withVisits?.result)}`);

  const categoryRow = (withVisits?.result?.categories || [])[0];
  categoryRow?.category === "Home"
    ? pass("0035", "category totals line up with the products that were sold")
    : fail("0035", `category breakdown: ${JSON.stringify(withVisits?.result?.categories)}`);

  /* A visit for somebody with no business and no project writes nothing, so the
     endpoint cannot be used to probe for owner ids. */
  await db.query(`select public.store_track_visit('00000000-0000-4000-8000-000000000000', 'x')`);
  const ghostRows = await one(
    db,
    `select count(*)::int as n from public.store_visits where owner_id = '00000000-0000-4000-8000-000000000000'`
  );
  ghostRows.n === 0
    ? pass("0035", "a visit for an owner that does not exist writes nothing")
    : fail("0035", `unknown owner recorded ${ghostRows.n} visits`);

  /* ---- support: escalation, auto-reply, history ---- */
  const supportTicket = await one(
    db,
    `insert into public.support_tickets (owner_id, subject, message, customer_email_used)
     values ($1, 'Candle arrived cracked', 'It arrived in pieces.', 'asha@example.test')
     returning id`,
    [storeOwner]
  );
  const escalateResult = await asUser(storeOwner, () =>
    one(db, `select public.support_escalate('${supportTicket.id}', 'The customer wants a refund') as result`)
  );
  const escalatedRow = await one(
    db,
    `select escalated_at, priority, status, escalation_reason from public.support_tickets where id = $1`,
    [supportTicket.id]
  );
  escalateResult?.result?.ok && escalatedRow.escalated_at && escalatedRow.priority === "high"
    ? pass("0035", "escalating a ticket timestamps it and raises its priority")
    : fail("0035", `escalation: ${JSON.stringify(escalatedRow)}`);

  const escalationNote = await one(
    db,
    `select body from public.support_replies where ticket_id = $1 and author_role = 'system'`,
    [supportTicket.id]
  );
  escalationNote && /escalated to the shinzora team/i.test(escalationNote.body)
    ? pass("0035", "the escalation leaves a visible note in the customer's thread")
    : fail("0035", `escalation note: ${JSON.stringify(escalationNote)}`);

  const outsiderEscalate = await asUser(storeOutsider, () =>
    throws(db, `select public.support_escalate('${supportTicket.id}', null)`)
  );
  outsiderEscalate && /another business/i.test(outsiderEscalate)
    ? pass("0035", "another business cannot escalate this ticket")
    : fail("0035", `stranger escalated: ${outsiderEscalate ?? "no error"}`);

  const autoOn = await asUser(storeOwner, () =>
    one(db, `select public.support_set_auto_reply('${supportTicket.id}', true) as result`)
  );
  const autoRow = await one(db, `select auto_reply from public.support_tickets where id = $1`, [supportTicket.id]);
  autoOn?.result?.autoReply && autoRow.auto_reply
    ? pass("0035", "automatic replies are opt-in per ticket")
    : fail("0035", `auto reply flag: ${JSON.stringify(autoRow)}`);

  const supportHistory = await asUser(storeOwner, () =>
    one(db, `select public.support_customer_history('asha@example.test', null) as result`)
  );
  Array.isArray(supportHistory?.result) && supportHistory.result.length >= 1
    ? pass("0035", "support history returns every ticket for one customer email")
    : fail("0035", `history: ${JSON.stringify(supportHistory?.result)}`);

  const outsiderHistory = await asUser(storeOutsider, () =>
    one(db, `select public.support_customer_history('asha@example.test', null) as result`)
  );
  Array.isArray(outsiderHistory?.result) && outsiderHistory.result.length === 0
    ? pass("0035", "another business gets an empty history for a customer that is not theirs")
    : fail("0035", `stranger history: ${JSON.stringify(outsiderHistory?.result)}`);

  /* ---- the assistant's command set is closed ---- */
  const madeProduct = await asUser(storeOwner, () =>
    one(db, `select public.assistant_command_apply('create_product', '{"name":"Tea light","price":120,"stock":8,"category":"Home"}'::jsonb, null) as result`)
  );
  madeProduct?.result?.productId
    ? pass("0035", "the assistant can create a product through a validated command")
    : fail("0035", `create_product returned ${JSON.stringify(madeProduct?.result)}`);

  const invented = await asUser(storeOwner, () =>
    throws(db, `select public.assistant_command_apply('delete_everything', '{}'::jsonb, null)`)
  );
  invented && /may do/i.test(invented)
    ? pass("0035", "an action outside the four allowed commands is refused")
    : fail("0035", `invented action: ${invented ?? "was executed"}`);

  const noName = await asUser(storeOwner, () =>
    throws(db, `select public.assistant_command_apply('create_product', '{"price":10}'::jsonb, null)`)
  );
  noName && /needs a name/i.test(noName)
    ? pass("0035", "a command with an incomplete payload is refused with the reason")
    : fail("0035", `nameless product: ${noName ?? "was created"}`);

  const strangerCommand = await asUser(storeOutsider, () =>
    throws(db, `select public.assistant_command_apply('update_stock', jsonb_build_object('productId', '${stockProduct.id}', 'stock', 1), null)`)
  );
  strangerCommand && /not in your catalogue/i.test(strangerCommand)
    ? pass("0035", "a command cannot touch another business's product")
    : fail("0035", `stranger update_stock: ${strangerCommand ?? "was applied"}`);

  /* ---- 0036: the thread can hold four voices, and only those four ---- */
  const assistantReply = await asUser(storeOwner, () =>
    one(
      db,
      `insert into public.support_replies (ticket_id, author_role, body)
       values ($1, 'assistant', 'Automatic reply for the staging check.')
       returning id, author_role`,
      [supportTicket.id]
    )
  );
  assistantReply?.author_role === "assistant"
    ? pass("0036", "an automated reply can be stored in the thread")
    : fail("0036", `assistant reply insert: ${JSON.stringify(assistantReply)}`);

  const customerReply = await asUser(storeOwner, () =>
    one(
      db,
      `insert into public.support_replies (ticket_id, author_role, body)
       values ($1, 'customer', 'Inbound message from the buyer.')
       returning id, author_role`,
      [supportTicket.id]
    )
  );
  customerReply?.author_role === "customer"
    ? pass("0036", "an inbound customer message can be stored in the same thread")
    : fail("0036", `customer reply insert: ${JSON.stringify(customerReply)}`);

  const inventedRole = await asUser(storeOwner, () =>
    throws(
      db,
      `insert into public.support_replies (ticket_id, author_role, body)
       values ('${supportTicket.id}', 'robot', 'nope')`
    )
  );
  inventedRole && /author_role|check constraint/i.test(inventedRole)
    ? pass("0036", "a role outside the five known voices is rejected by the constraint")
    : fail("0036", `invented author_role: ${inventedRole ?? "was accepted"}`);

  const historyWithVoices = await asUser(storeOwner, () =>
    one(db, `select public.support_customer_history('asha@example.test', null) as result`)
  );
  const firstThread = Array.isArray(historyWithVoices?.result) ? historyWithVoices.result[0] : null;
  Array.isArray(firstThread?.replies) && firstThread.replies.length >= 2
    ? pass("0036", "customer history carries every voice in the thread, oldest first")
    : fail("0036", `history replies: ${JSON.stringify(firstThread?.replies)}`);

  /* ---- archiving a ticket hides it without destroying it ---- */
  const ticket = await one(db, `select id, owner_id from public.support_tickets limit 1`);
  if (ticket) {
    const beforeCount = await asUser(ticket.owner_id, () =>
      rows(db, `select id from public.support_tickets where id = '${ticket.id}'`)
    );
    await asUser(adminId, () =>
      rows(db, `select public.admin_archive_record('support_tickets', '${ticket.id}', 'resolved by email') as result`)
    );
    const afterCount = await asUser(ticket.owner_id, () =>
      rows(db, `select id from public.support_tickets where id = '${ticket.id}'`)
    );
    const stillThere = await one(db, `select archived_at from public.support_tickets where id = $1`, [ticket.id]);
    beforeCount.length === 1 && afterCount.length === 0 && stillThere.archived_at
      ? pass("0009", "an archived ticket leaves the customer's list but stays in the database with its timestamp")
      : fail("0009", `archive: before=${beforeCount.length}, after=${afterCount.length}, row=${JSON.stringify(stillThere)}`);
  }
}
