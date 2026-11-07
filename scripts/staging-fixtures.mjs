/* ==========================================================================
   Staging fixtures — the shape of a live database, not a demo
   --------------------------------------------------------------------------
   These rows exist so the upgrade migrations have something real to be safe
   with: payments that are already duplicated, service requests written before
   the tracking columns existed, a verified purchase that must not be disturbed.
   This file is used only by scripts/staging-db.mjs.
   ========================================================================== */

export async function seed(db) {
  const q = (sql, params) => db.query(sql, params);

  /* ---- accounts ---- */
  const users = {};
  for (const [key, email] of Object.entries({
    a: "owner.a@example.test",
    b: "owner.b@example.test",
    admin: "mext.aditya@gmail.com"
  })) {
    /* 0004 may already have registered the administrator by the time the
       fixture runs, so this is an upsert rather than an insert. */
    const { rows } = await q(
      `insert into auth.users (email, raw_user_meta_data) values ($1, '{}'::jsonb)
       on conflict (email) do update set raw_user_meta_data = excluded.raw_user_meta_data
       returning id`,
      [email]
    );
    users[key] = rows[0].id;
    await q(
      `insert into public.profiles (id, full_name, email) values ($1, $2, $3)
       on conflict (id) do nothing`,
      [users[key], key === "admin" ? "Shinzora Owner" : `Owner ${key.toUpperCase()}`, email]
    );
  }

  /* ---- businesses ---- */
  for (const key of ["a", "b"]) {
    await q(
      `insert into public.businesses (owner_id, name, category, stage)
       values ($1, $2, 'retail', 'launched')`,
      [users[key], `Business ${key.toUpperCase()}`]
    );
  }

  /* ---- payments ------------------------------------------------------------
     Deliberate situations:
       A / pro        → two OPEN rows (a plain duplicate; the awaiting_verification
                        one must survive because a proof was already submitted)
       A / brand_kit  → two OPEN pending rows (newest survives)
       A / store_setup→ one verified (history) + one open (a second purchase of a
                        purpose that is no longer open — must be legal)
       B / pro        → one verified only
     -------------------------------------------------------------------------- */
  const payments = [
    { owner: "a", purpose: "pro",         status: "pending",              amount: 249900, utr: null },
    { owner: "a", purpose: "pro",         status: "awaiting_verification", amount: 249900, utr: "UTRPRO0001" },
    { owner: "a", purpose: "brand_kit",   status: "pending",              amount: 249900, utr: null },
    { owner: "a", purpose: "brand_kit",   status: "pending",              amount: 249900, utr: null },
    { owner: "a", purpose: "store_setup", status: "verified",             amount: 349900, utr: "UTRSS0001" },
    { owner: "a", purpose: "store_setup", status: "pending",              amount: 349900, utr: null },
    { owner: "b", purpose: "pro",         status: "verified",             amount: 249900, utr: "UTRPRO0002" }
  ];
  const paymentIds = [];
  const paymentRefs = [];
  for (const p of payments) {
    const { rows } = await q(
      `insert into public.payments (owner_id, purpose, label, amount, status, utr, paid_at)
       values ($1, $2, $3, $4, $5, $6, $7) returning id, reference`,
      [
        users[p.owner], p.purpose, `Plan ${p.purpose}`, p.amount, p.status, p.utr,
        p.status === "verified" ? new Date().toISOString() : null
      ]
    );
    paymentIds.push(rows[0].id);
    paymentRefs.push(rows[0].reference);
  }

  /* ---- service requests written before the tracking columns existed ------- */
  const serviceRequests = [
    { owner: "a", type: "website_setup", title: "Managed website setup", status: "in_progress", note: "Kick-off done." },
    { owner: "a", type: "google_listing", title: "Get listed on Google", status: "requested", note: null },
    { owner: "b", type: "brand_kit", title: "Brand kit", status: "completed", note: "Delivered." },
    { owner: "b", type: "custom", title: "Something else", status: "rejected", note: "Out of scope." }
  ];
  for (const s of serviceRequests) {
    await q(
      `insert into public.service_requests (owner_id, service_type, title, details, status, admin_note, created_at, updated_at)
       values ($1, $2, $3, 'Details supplied by the customer.', $4, $5, now() - interval '9 days', now() - interval '4 days')`,
      [users[s.owner], s.type, s.title, s.status, s.note]
    );
  }

  /* ---- store customers ---- */
  for (let i = 1; i <= 6; i += 1) {
    await q(
      `insert into public.store_customers (owner_id, name, email, city)
       values ($1, $2, $3, $4)`,
      [users.a, `Customer ${i}`, `customer${i}@example.test`, "Delhi"]
    );
  }

  /* ---- a notification already in the inbox ---- */
  await q(
    `insert into public.notifications (user_id, title, body, type)
     values ($1, 'Welcome to Shinzora', 'Your workspace is ready.', 'account')`,
    [users.a]
  );

  return {
    users,
    payments: payments.length,
    paymentIds,
    paymentRefs,
    serviceRequests: serviceRequests.length,
    customers: 6
  };
}
