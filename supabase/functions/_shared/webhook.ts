// ============================================================================
// Shinzora · shared webhook helpers
// ----------------------------------------------------------------------------
// Everything the payment webhook needs to decide *whether* an event has already
// happened, kept separate from the HTTP handler so it can be reasoned about —
// and tested — on its own.
//
// The idempotency key is the whole game. A gateway retries a delivery when it
// does not like the response; the retry carries the same event, so the second
// copy must be recognised and dropped. Two sources, in order:
//
//   1. X-Razorpay-Event-Id — the gateway's own delivery id. Best case.
//   2. A digest of the fields that make the event unique, for gateways (or
//      proxies that strip headers) that do not send one. Same event in, same
//      key out; a genuinely new event gets a new key.
//
// Keys are scoped by provider, so two gateways reusing the string "evt_1" never
// collide.
// ============================================================================

export type WebhookKind = "verified" | "failed" | "pending" | "ignored";

export interface WebhookDecision {
  /** Stable identity of this delivery, used as the inbox key. */
  eventId: string;
  /** What the event is asking us to do. */
  kind: WebhookKind;
  /** Gateway's own event name, kept for the audit row. */
  eventType: string;
  /** Gateway payment id, when the payload carries one. */
  providerPaymentId: string;
  /** Our own payment reference (Razorpay `receipt`), when present. */
  receipt: string;
  /** Amount in minor units, when present. */
  amount: number | null;
  /** Human-readable failure reason, for `payment.failed`. */
  failureReason: string | null;
  /** Provider timestamp in ISO form, when present. */
  occurredAt: string | null;
}

const text = (value: unknown): string =>
  typeof value === "string" ? value.trim() : typeof value === "number" ? String(value) : "";

/** Deterministic, collision-resistant key for a delivery. */
export async function eventKey(
  provider: string,
  headerId: string | null,
  event: Record<string, unknown>,
  raw: string
): Promise<string> {
  if (headerId && headerId.trim()) return `${provider}:${headerId.trim()}`;

  const entity =
    (event?.payload as Record<string, any>)?.payment?.entity ??
    (event?.payload as Record<string, any>)?.order?.entity ??
    {};

  const fingerprint = [
    provider,
    text(event?.event),
    text(entity?.id),
    text(entity?.order_id),
    text(entity?.status),
    text(entity?.amount),
    text(event?.created_at ?? entity?.created_at)
  ].join("|");

  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(fingerprint || raw));
  const hex = Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `${provider}:digest:${hex.slice(0, 40)}`;
}

/** Read an event and say what it means, without touching the database. */
export function classify(event: Record<string, any>): WebhookDecision {
  const entity = event?.payload?.payment?.entity ?? {};
  const eventType = text(event?.event);
  const providerPaymentId = text(entity?.id);
  const receipt = text(entity?.receipt ?? entity?.notes?.payment_id);
  const amount = Number.isFinite(Number(entity?.amount)) && entity?.amount !== undefined ? Number(entity.amount) : null;
  const occurredAt =
    typeof entity?.created_at === "number" ? new Date(entity.created_at * 1000).toISOString() : null;

  let kind: WebhookKind = "ignored";
  if (eventType === "payment.captured" || eventType === "order.paid") kind = "verified";
  else if (eventType === "payment.failed") kind = "failed";
  else if (eventType === "payment.authorized" || eventType === "payment.pending" || eventType === "order.created") kind = "pending";

  return {
    eventId: "",
    kind,
    eventType,
    providerPaymentId,
    receipt,
    amount,
    failureReason: kind === "failed" ? text(entity?.error_description ?? entity?.error_code) || "Provider reported a failed payment" : null,
    occurredAt
  };
}

/**
 * Whether an event should change the stored payment.
 * A repeated capture on an already-verified payment is a no-op: the money did
 * not arrive twice, so nothing may be written twice.
 */
export function shouldApply(kind: WebhookKind, currentStatus: string): boolean {
  if (kind === "verified") return currentStatus !== "verified" && currentStatus !== "refunded";
  if (kind === "failed") return currentStatus !== "verified" && currentStatus !== "refunded" && currentStatus !== "rejected";
  if (kind === "pending") return currentStatus === "pending";
  return false;
}
