/* ==========================================================================
   Shinzora — formatting helpers
   Locale-aware money, dates, relative time and number compaction for the
   dashboard. Currency defaults to INR because the payment workflow is built
   around UPI/Razorpay, but every helper accepts an explicit currency.
   ========================================================================== */

const INR = "INR";

export function money(minorUnits = 0, currency = INR, opts = {}) {
  const amount = Number(minorUnits || 0) / 100;
  try {
    return new Intl.NumberFormat("en-IN", {
      style: "currency",
      currency,
      /* Paise are shown to the paisa ("₹36.80", not "₹36.8"); whole rupees stay
         clean ("₹2,499"). */
      maximumFractionDigits: amount % 1 === 0 ? 0 : 2,
      minimumFractionDigits: amount % 1 === 0 ? 0 : 2,
      ...opts
    }).format(amount);
  } catch {
    return `${currency} ${amount.toFixed(2)}`;
  }
}

/** Plain number with Indian grouping. */
export function num(value, opts = {}) {
  return new Intl.NumberFormat("en-IN", { maximumFractionDigits: 1, ...opts }).format(Number(value || 0));
}

/** 12_400 → "12.4K". */
export function compact(value) {
  return new Intl.NumberFormat("en-IN", { notation: "compact", maximumFractionDigits: 1 }).format(Number(value || 0));
}

export function percent(value, digits = 0) {
  return `${Number(value || 0).toFixed(digits)}%`;
}

export function date(value, opts = {}) {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric", ...opts });
}

export function dateTime(value) {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "—";
  return `${d.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" })}, ${d.toLocaleTimeString(
    "en-IN",
    { hour: "2-digit", minute: "2-digit" }
  )}`;
}

const RELATIVE = [
  [60, "second", 1000],
  [3600, "minute", 60],
  [86400, "hour", 3600],
  [604800, "day", 86400],
  [2629800, "week", 604800],
  [31557600, "month", 2629800],
  [Infinity, "year", 31557600]
];

export function timeAgo(value) {
  if (!value) return "—";
  const then = new Date(value).getTime();
  if (Number.isNaN(then)) return "—";
  const diff = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (diff < 45) return "just now";
  const rtf = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
  for (const [limit, unit, divisor] of RELATIVE) {
    if (diff < limit) return rtf.format(-Math.floor(diff / divisor), unit);
  }
  return date(value);
}

/** "3m 12s" style duration for job timers. */
export function duration(ms) {
  const total = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return m ? `${m}m ${s}s` : `${s}s`;
}

export function initials(nameOrEmail = "") {
  const source = String(nameOrEmail).trim();
  if (!source) return "SZ";
  if (source.includes("@")) return source.slice(0, 2).toUpperCase();
  const parts = source.split(/\s+/).filter(Boolean);
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

export function titleCase(value = "") {
  return String(value)
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Short, human label for a status enum. */
export function statusLabel(status = "") {
  const map = {
    awaiting_verification: "Awaiting verification",
    awaiting_payment: "Awaiting payment",
    pending: "Pending",
    in_review: "In review",
    verified: "Verified",
    rejected: "Rejected",
    active: "Active",
    draft: "Draft",
    generating: "Generating",
    ready: "Ready",
    published: "Published",
    archived: "Archived",
    failed: "Failed",
    trialing: "Trial",
    past_due: "Past due",
    cancelled: "Cancelled",
    paid: "Paid",
    refunded: "Refunded",
    delivered: "Delivered",
    shipped: "Shipped",
    processing: "Processing",
    fulfilled: "Fulfilled",
    open: "Open",
    closed: "Closed",
    resolved: "Resolved",
    approved: "Approved",
    registered: "Registered",
    live: "Live",
    queued: "Queued",
    building: "Building",
    error: "Error",
    /* marketing requests */
    submitted: "Submitted",
    under_review: "Under review",
    more_information_required: "More information required",
    in_progress: "In progress",
    completed: "Completed",
    revoked: "Revoked",
    /* app conversion jobs */
    awaiting_toolchain: "Awaiting toolchain",
    built: "Built",
    expired: "Expired"
  };
  return map[status] || titleCase(status || "unknown");
}

/** Map any status to a badge modifier class. */
export function statusTone(status = "") {
  const ok = [
    "verified", "active", "published", "ready", "paid", "delivered", "fulfilled", "resolved", "approved", "registered", "live", "closed",
    "completed", "built"
  ];
  const warn = [
    "pending", "awaiting_verification", "awaiting_payment", "in_review", "processing", "queued", "building", "trialing", "draft",
    "submitted", "under_review", "more_information_required", "awaiting_toolchain"
  ];
  const bad = ["rejected", "failed", "cancelled", "past_due", "error", "refunded", "revoked", "expired"];
  if (ok.includes(status)) return "ok";
  if (warn.includes(status)) return "warn";
  if (bad.includes(status)) return "danger";
  if (["shipped", "generating", "in_progress"].includes(status)) return "info";
  return "neutral";
}

export function truncate(value, max = 120) {
  const s = String(value ?? "");
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** Slug safe for Shinzora subdomains: "Riya's Studio" → "riyas-studio" */
export function slugify(value = "") {
  return String(value)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

export function bytes(size = 0) {
  const units = ["B", "KB", "MB", "GB"];
  let value = Number(size) || 0;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i += 1;
  }
  return `${value.toFixed(i ? 1 : 0)} ${units[i]}`;
}
