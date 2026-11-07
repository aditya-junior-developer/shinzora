// ============================================================================
// Shinzora · Edge Function `payments-webhook`
// ----------------------------------------------------------------------------
// Razorpay webhook receiver. This is the ONLY automated path that can set a
// payment to 'verified', and it requires a valid HMAC signature computed over
// the raw request body with RAZORPAY_WEBHOOK_SECRET.
//
//   POST /functions/v1/payments-webhook
//   Header: x-razorpay-signature
//   Header: x-razorpay-event-id   (used as the idempotency key)
//
// Deploy with JWT verification disabled (the signature is the authority):
//   supabase functions deploy payments-webhook --no-verify-jwt
//
// Idempotency (migration 0008):
//   · every delivery is written to payment_webhook_events before it is acted on
//   · (provider, event_id) is unique, so a retry cannot be applied twice
//   · notifications carry meta.webhook_event_id, which is also unique
//   · payments.provider_payment_id is unique, so one gateway payment can only
//     ever map to one local row
// A duplicate returns 200 with { duplicate: true } — the gateway stops retrying
// and nothing is written twice.
// ============================================================================

import { fail, json } from "../_shared/http.ts";
import { admin } from "../_shared/auth.ts";
import { classify, eventKey, shouldApply } from "../_shared/webhook.ts";

const env = (key: string) => (Deno.env.get(key) ?? "").trim();
const PROVIDER = "razorpay";

async function hmacHex(secret: string, payload: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  return Array.from(new Uint8Array(signature))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/** Constant-time-ish comparison; both sides are hex of equal length. */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return fail(405, "method_not_allowed", "Use POST.");

  const secret = env("RAZORPAY_WEBHOOK_SECRET");
  if (!secret) {
    return fail(503, "webhook_unconfigured", "RAZORPAY_WEBHOOK_SECRET is not set for this function.");
  }

  const raw = await req.text();
  const signature = req.headers.get("x-razorpay-signature") ?? "";
  const expected = await hmacHex(secret, raw);

  if (!signature || !safeEqual(signature, expected)) {
    return fail(401, "invalid_signature", "Signature verification failed.");
  }

  let event: Record<string, any>;
  try {
    event = JSON.parse(raw);
  } catch {
    return fail(400, "invalid_payload", "Body is not valid JSON.");
  }

  const decision = classify(event);
  decision.eventId = await eventKey(PROVIDER, req.headers.get("x-razorpay-event-id"), event, raw);

  const supabase = admin();

  /* ---------------------------------------------------------- claim the event
     Insert first. A second delivery of the same event loses this insert to the
     unique key and leaves immediately, before any payment, subscription or
     notification is touched. */
  const claim = await supabase
    .from("payment_webhook_events")
    .insert({
      provider: PROVIDER,
      event_id: decision.eventId,
      event_type: decision.eventType,
      payment_id: decision.providerPaymentId || null,
      payload: event,
      status: "received"
    })
    .select("id")
    .single();

  if (claim.error?.code === "23505") {
    return json({ ok: true, duplicate: true, event_id: decision.eventId }, 200);
  }
  if (claim.error) {
    /* If the inbox itself is unreachable, do not guess: a 500 makes the gateway
       retry, which is exactly what should happen. */
    console.error("webhook inbox error", claim.error.message);
    return fail(500, "webhook_inbox_error", "The event could not be recorded; retry later.");
  }

  const eventRowId = claim.data.id as string;

  const settle = async (status: "processed" | "ignored" | "failed", error?: string) => {
    await supabase
      .from("payment_webhook_events")
      .update({ status, error: error ?? null, processed_at: new Date().toISOString() })
      .eq("id", eventRowId);
  };

  try {
    /* ------------------------------------------------------- find the payment */
    let payment = null;
    if (decision.receipt) {
      const { data } = await supabase.from("payments").select("*").eq("reference", decision.receipt).maybeSingle();
      payment = data;
    }
    if (!payment && decision.providerPaymentId) {
      const { data } = await supabase
        .from("payments")
        .select("*")
        .eq("provider_payment_id", decision.providerPaymentId)
        .maybeSingle();
      payment = data;
    }
    if (!payment) {
      await settle("ignored");
      return json({ ok: false, reason: "payment_not_found", event_id: decision.eventId }, 200);
    }

    if (!shouldApply(decision.kind, String(payment.status))) {
      await settle("ignored");
      return json(
        { ok: true, duplicate: true, reason: "already_" + payment.status, event_id: decision.eventId },
        200
      );
    }

    /* ---------------------------------------------------------------- apply */
    const now = new Date().toISOString();

    if (decision.kind === "verified") {
      const { error } = await supabase
        .from("payments")
        .update({
          status: "verified",
          method: "razorpay",
          provider: PROVIDER,
          provider_payment_id: decision.providerPaymentId || payment.provider_payment_id,
          paid_at: decision.occurredAt ?? now,
          verified_at: now,
          admin_note: "Confirmed by Razorpay webhook",
          updated_at: now
        })
        .eq("id", payment.id)
        .neq("status", "verified"); /* belt and braces under concurrency */

      if (error) {
        if (error.code === "23505") {
          /* another delivery captured the same gateway payment first */
          await settle("ignored", "provider payment id already recorded");
          return json({ ok: true, duplicate: true, event_id: decision.eventId }, 200);
        }
        throw new Error(error.message);
      }

      await notifyOnce(supabase, {
        userId: payment.owner_id,
        eventId: decision.eventId,
        title: "Payment verified",
        body: `Payment ${payment.reference} for ${payment.label ?? payment.purpose} is confirmed.`,
        link: "/app/?view=billing"
      });

      await settle("processed");
      return json({ ok: true, status: "verified", event_id: decision.eventId }, 200);
    }

    if (decision.kind === "failed") {
      const { error } = await supabase
        .from("payments")
        .update({
          status: "rejected",
          admin_note: decision.failureReason ?? "Provider reported a failed payment",
          provider: PROVIDER,
          provider_payment_id: decision.providerPaymentId || payment.provider_payment_id,
          updated_at: now
        })
        .eq("id", payment.id)
        .neq("status", "verified");

      if (error) throw new Error(error.message);

      await notifyOnce(supabase, {
        userId: payment.owner_id,
        eventId: decision.eventId,
        title: "Payment failed",
        body: `The payment for ${payment.label ?? payment.purpose} did not go through. No money has been recorded as received.`,
        link: "/app/?view=billing"
      });

      await settle("processed");
      return json({ ok: true, status: "rejected", event_id: decision.eventId }, 200);
    }

    if (decision.kind === "pending") {
      /* An authorised-but-uncaptured payment is not money. Record the gateway id
         so a later capture can find this row, change nothing else. */
      if (decision.providerPaymentId && !payment.provider_payment_id) {
        await supabase
          .from("payments")
          .update({ provider: PROVIDER, provider_payment_id: decision.providerPaymentId, updated_at: now })
          .eq("id", payment.id);
      }
      await settle("processed");
      return json({ ok: true, status: "pending", event_id: decision.eventId }, 200);
    }

    await settle("ignored");
    return json({ ok: true, ignored: decision.eventType, event_id: decision.eventId }, 200);
  } catch (error) {
    console.error("webhook error", (error as Error).message);
    await settle("failed", (error as Error).message);
    return fail(500, "webhook_error", "Could not process the webhook.");
  }
});

/**
 * Notify at most once per gateway event. The unique index on
 * notifications ((meta->>'webhook_event_id')) makes a second insert fail rather
 * than deliver a duplicate message; that failure is expected and swallowed.
 */
async function notifyOnce(
  supabase: ReturnType<typeof admin>,
  message: { userId: string; eventId: string; title: string; body: string; link: string }
) {
  await supabase
    .from("notifications")
    .insert({
      user_id: message.userId,
      title: message.title,
      body: message.body,
      type: "payment",
      link: message.link,
      meta: { webhook_event_id: message.eventId }
    })
    .then(
      () => undefined,
      () => undefined
    );
}
