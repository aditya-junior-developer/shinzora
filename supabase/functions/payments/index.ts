// ============================================================================
// Shinzora · Edge Function `payments`
// ----------------------------------------------------------------------------
// Manual UPI QR first, Razorpay-ready underneath.
//
//   POST /functions/v1/payments   { action, ... }
//     create        { purpose, label? }         → payment row + UPI intent
//     submit_proof  { paymentId, utr, paidAt }  → status 'awaiting_verification'
//     status        { paymentId }               → current status only
//     razorpay_order{ paymentId }               → provider order (when configured)
//
// Invariants enforced here, not in the browser:
//   • the amount is taken from a SERVER-side catalogue; a client-sent amount is
//     ignored, so a tampered request cannot buy Pro for ₹1
//   • a payment is created as 'pending'. Nothing in this function can set
//     'verified' — that requires the admin function or a signed webhook
//   • closing the payment UI has no server-side effect at all
// ============================================================================

import { clean, fail, json, preflight, readBody } from "../_shared/http.ts";
import { admin, getCaller } from "../_shared/auth.ts";

/** Prices in paise (minor units). ₹2,499 = 249900. */
const PLAN_PRICES: Record<string, number> = {
  pro: 249900,
  enterprise: 999900
};

const SERVICE_PRICES: Record<string, { amount: number; label: string }> = {
  website_setup: { amount: 499900, label: "Managed website setup" },
  brand_kit: { amount: 249900, label: "Brand kit and copywriting" },
  store_setup: { amount: 349900, label: "Store and catalogue setup" }
};

const env = (key: string) => (Deno.env.get(key) ?? "").trim();

Deno.serve(async (req) => {
  const options = preflight(req);
  if (options) return options;
  if (req.method !== "POST") return fail(405, "method_not_allowed", "Use POST.");

  const caller = await getCaller(req);
  if (!caller) return fail(401, "not_authenticated", "Sign in to continue.");

  const body = await readBody<Record<string, unknown>>(req);
  const action = clean(body.action, 40);

  try {
    switch (action) {
      case "create":
        return await createPayment(caller.user.id, body);
      case "submit_proof":
        return await submitProof(caller.user.id, body);
      case "status":
        return await paymentStatus(caller.user.id, body);
      case "razorpay_order":
        return await razorpayOrder(caller.user.id, body);
      default:
        return fail(400, "unknown_action", "Unknown payments action.");
    }
  } catch (error) {
    console.error("payments error", (error as Error).message);
    return fail(500, "payments_error", "The payment request could not be completed.");
  }
});

/* --------------------------------------------------------------- open payment */
interface OpenPayment {
  id: string;
  reference: string;
  purpose: string;
  status: string;
  amount: number;
  [key: string]: unknown;
}

/** The open payment for this customer and purpose, or null when there is none. */
async function findOpenPayment(userId: string, purpose: string): Promise<OpenPayment | null> {
  const { data } = await admin()
    .from("payments")
    .select("*")
    .eq("owner_id", userId)
    .eq("purpose", purpose)
    .in("status", ["pending", "awaiting_verification"])
    .order("status", { ascending: true }) /* awaiting_verification sorts first: a proof beats a blank */
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return (data as OpenPayment) ?? null;
}

/** Shared shape for a new payment and for a reused one. */
function paymentResponse(
  payment: OpenPayment,
  opts: { upiId: string; payee: string; razorpayReady: boolean; reused: boolean }
) {
  const rupees = (Number(payment.amount) / 100).toFixed(2);
  const intent = opts.upiId
    ? `upi://pay?pa=${encodeURIComponent(opts.upiId)}&pn=${encodeURIComponent(opts.payee)}&am=${rupees}&cu=INR&tn=${encodeURIComponent(
        payment.reference
      )}&tr=${encodeURIComponent(payment.reference)}`
    : null;

  return json({
    reused: opts.reused,
    payment,
    upi: {
      configured: Boolean(opts.upiId),
      upi_id: opts.upiId || null,
      payee_name: opts.payee,
      intent,
      amount_rupees: Number(rupees)
    },
    razorpay: { configured: opts.razorpayReady }
  });
}

/* -------------------------------------------------------------------- create */
async function createPayment(userId: string, body: Record<string, unknown>) {
  const purpose = clean(body.purpose, 80);
  if (!purpose) return fail(400, "invalid_input", "A payment purpose is required.");

  const resolved = await resolveAmount(userId, purpose);
  if (!resolved) return fail(400, "invalid_input", "That payment purpose is not recognised.");
  if (!resolved.amount || resolved.amount < 100) {
    return fail(400, "amount_unavailable", "The price for this item has to be set before a payment can be created.", {
      hint: "Domain prices come from the registrar at checkout. Create a service request instead."
    });
  }

  const upiId = env("UPI_ID");
  const payee = env("UPI_PAYEE_NAME") || "Shinzora";
  const razorpayReady = Boolean(env("RAZORPAY_KEY_ID") && env("RAZORPAY_KEY_SECRET"));

  if (!upiId && !razorpayReady) {
    return fail(503, "payments_unconfigured", "Payments are not configured on this deployment.", {
      hint: "Set UPI_ID and UPI_PAYEE_NAME (or Razorpay keys) as secrets for the payments Edge Function, then redeploy it."
    });
  }

  /* ------------------------------------------------------------ reuse first
     One open payment per customer per purpose is enforced by the partial unique
     index `payments_one_open_per_purpose` (migration 0007). The API reads the
     open record and hands it back instead of creating a second reference, so a
     double click or two tabs cannot produce two UTRs for one intent.

     The read is not the guarantee — the index is. If two requests race past the
     read, exactly one insert wins and the loser gets 23505, which is caught
     below and turned into the winner's record. */
  const open = await findOpenPayment(userId, purpose);
  if (open) return paymentResponse(open, { upiId, payee, razorpayReady, reused: true });

  let created = await admin()
    .from("payments")
    .insert({
      owner_id: userId,
      purpose,
      label: resolved.label,
      amount: resolved.amount,
      currency: "INR",
      method: upiId ? "upi_qr" : "razorpay",
      status: "pending",
      plan: resolved.plan ?? null
    })
    .select("*")
    .single();

  if (created.error?.code === "23505") {
    /* lost the race: the winner's row is the payment this customer pays */
    const winner = await findOpenPayment(userId, purpose);
    if (winner) return paymentResponse(winner, { upiId, payee, razorpayReady, reused: true });
  }
  if (created.error) {
    return fail(500, "payments_error", "Could not create the payment record.", { detail: created.error.message });
  }

  const data = created.data;

  await admin()
    .from("customer_activity")
    .insert({
      user_id: userId,
      action: "payment_created",
      entity_type: "payment",
      entity_id: data.id,
      meta: { purpose, amount: resolved.amount }
    })
    .then(() => undefined, () => undefined);

  return paymentResponse(data, { upiId, payee, razorpayReady, reused: false });
}

async function resolveAmount(userId: string, purpose: string): Promise<{ amount: number; label: string; plan?: string } | null> {
  if (purpose.startsWith("subscription:")) {
    const plan = purpose.split(":")[1];
    if (!PLAN_PRICES[plan]) return null;
    return { amount: PLAN_PRICES[plan], label: `${plan === "pro" ? "Pro" : "Enterprise"} plan`, plan };
  }

  if (purpose.startsWith("service:")) {
    const service = purpose.split(":")[1];
    const entry = SERVICE_PRICES[service];
    if (!entry) return null;
    return { amount: entry.amount, label: entry.label };
  }

  if (purpose.startsWith("domain:")) {
    const orderId = purpose.split(":")[1];
    const { data } = await admin()
      .from("domain_orders")
      .select("id, domain_name, price, owner_id, status")
      .eq("id", orderId)
      .eq("owner_id", userId)
      .maybeSingle();
    if (!data) return null;
    return { amount: Math.round(Number(data.price)), label: `Domain ${data.domain_name}` };
  }

  return null;
}

/* -------------------------------------------------------------- submit_proof */
async function submitProof(userId: string, body: Record<string, unknown>) {
  const paymentId = clean(body.paymentId, 64);
  const utr = clean(body.utr, 60).replace(/\s+/g, "");
  const note = clean(body.note, 500);
  const paidAt = clean(body.paidAt, 40);
  const payerUpi = clean(body.payerUpi, 80).toLowerCase();

  if (!paymentId) return fail(400, "invalid_input", "Missing payment reference.");
  if (payerUpi && !/^[a-z0-9._-]{2,64}@[a-z]{2,32}$/.test(payerUpi)) {
    return fail(400, "invalid_input", "Enter the UPI ID you paid from, e.g. name@bank.", {
      hint: "This is the VPA shown in your UPI app, not the transaction ID."
    });
  }
  if (utr.length < 6) return fail(400, "invalid_input", "Enter the UPI transaction ID from your payment app.", {
    hint: "It is a 12-digit number shown in the payment success screen and your UPI app history."
  });

  const { data: payment, error } = await admin()
    .from("payments")
    .select("*")
    .eq("id", paymentId)
    .eq("owner_id", userId)
    .maybeSingle();

  if (error) return fail(500, "payments_error", "Could not read the payment record.");
  if (!payment) return fail(404, "not_found", "That payment does not belong to your account.");
  if (payment.status === "verified") return fail(409, "already_verified", "This payment is already verified.");
  if (payment.status === "rejected") {
    return fail(409, "rejected", "This payment was rejected. Create a new payment request.");
  }

  const { data: updated, error: updateError } = await admin()
    .from("payments")
    .update({
      status: "awaiting_verification",
      utr,
      /* The payer's VPA is what the operator sees in the bank statement, so it
         is kept with the record. It rides in `note` (the column that already
         exists in every deployment) prefixed and machine-readable. */
      note: [payerUpi ? `Payer UPI: ${payerUpi}` : "", note].filter(Boolean).join(" · ") || payment.note,
      paid_at: paidAt || new Date().toISOString(),
      updated_at: new Date().toISOString()
    })
    .eq("id", paymentId)
    .eq("owner_id", userId)
    .select("*")
    .single();

  if (updateError) return fail(500, "payments_error", "Could not record the payment reference.", { detail: updateError.message });

  await admin()
    .from("notifications")
    .insert({
      user_id: userId,
      title: "Payment awaiting verification",
      body: "Your payment is awaiting verification. We will notify you once it is confirmed.",
      type: "payment",
      link: "/app/?view=billing"
    })
    .then(() => undefined, () => undefined);

  await admin()
    .from("customer_activity")
    .insert({
      user_id: userId,
      action: "payment_proof_submitted",
      entity_type: "payment",
      entity_id: paymentId,
      meta: { utr, amount: payment.amount, payerUpi: payerUpi || null }
    })
    .then(() => undefined, () => undefined);

  return json({
    ok: true,
    payment: updated,
    message: "Your payment is awaiting verification. We will notify you once it is confirmed."
  });
}

/* -------------------------------------------------------------------- status */
async function paymentStatus(userId: string, body: Record<string, unknown>) {
  const paymentId = clean(body.paymentId, 64);
  const { data } = await admin()
    .from("payments")
    .select("id, reference, status, amount, currency, utr, admin_note, verified_at, created_at, purpose, label")
    .eq("id", paymentId)
    .eq("owner_id", userId)
    .maybeSingle();
  if (!data) return fail(404, "not_found", "Payment not found.");
  return json({ payment: data });
}

/* ------------------------------------------------------------------ Razorpay */
async function razorpayOrder(userId: string, body: Record<string, unknown>) {
  const keyId = env("RAZORPAY_KEY_ID");
  const keySecret = env("RAZORPAY_KEY_SECRET");
  if (!keyId || !keySecret) {
    return fail(503, "razorpay_unconfigured", "Razorpay is not configured on this deployment.", {
      hint: "Add RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET as Edge Function secrets to enable card and netbanking payments."
    });
  }

  const paymentId = clean(body.paymentId, 64);
  const { data: payment } = await admin()
    .from("payments")
    .select("*")
    .eq("id", paymentId)
    .eq("owner_id", userId)
    .maybeSingle();
  if (!payment) return fail(404, "not_found", "Payment not found.");
  if (payment.status === "verified") return fail(409, "already_verified", "This payment is already verified.");

  const response = await fetch("https://api.razorpay.com/v1/orders", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Basic ${btoa(`${keyId}:${keySecret}`)}`
    },
    body: JSON.stringify({
      amount: Math.round(Number(payment.amount)),
      currency: payment.currency || "INR",
      receipt: payment.reference,
      notes: { payment_id: payment.id, purpose: payment.purpose }
    })
  });

  if (!response.ok) {
    return fail(502, "razorpay_error", "Razorpay rejected the order request.", {
      detail: (await response.text()).slice(0, 300)
    });
  }

  const order = await response.json();
  await admin()
    .from("payments")
    .update({ method: "razorpay", provider: "razorpay", provider_payment_id: order.id })
    .eq("id", payment.id);

  return json({
    order: { id: order.id, amount: order.amount, currency: order.currency },
    key_id: keyId
  });
}
