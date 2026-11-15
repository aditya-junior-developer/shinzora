/* ==========================================================================
   Shinzora — meeting invitations and return paths (brief item 3)
   Pure helpers, no DOM. Used by login, signup, onboarding and the Meetings
   page. tests/invite-links.test.mjs covers them.
   ========================================================================== */

/* Codes are minted by public.meeting_code() (0046): nine characters from
   'abcdefghjkmnpqrstuvwxyz23456789'. Anything else cannot be a real code, so
   it is refused before a round trip. The database still decides the rest. */
export const MEETING_CODE_PATTERN = /^[a-hj-km-np-z2-9]{9}$/;

/** Normalise what a person typed or pasted into a meeting code, or return null. */
export function normaliseMeetingCode(raw) {
  const cleaned = String(raw ?? "").toLowerCase().replace(/[\s-]+/g, "");
  return MEETING_CODE_PATTERN.test(cleaned) ? cleaned : null;
}

/**
 * Accept only an in-app path. Protocol-relative (`//host`), absolute URLs,
 * backslash tricks and control characters are refused, so a `next` value can
 * never send a person off-site.
 */
export function safeNextPath(value, fallback = "") {
  if (typeof value !== "string") return fallback;
  const path = value.trim();
  if (!path.startsWith("/") || path.startsWith("//") || path.startsWith("/\\")) return fallback;
  if (/[\u0000-\u001f\u007f\\]/.test(path)) return fallback;
  return path;
}

/** The app path that opens a meeting's lobby. */
export function meetingPath(code) {
  return `/app/?view=meeting&code=${encodeURIComponent(String(code ?? ""))}`;
}

/** Where onboarding should send the person when they finish, if they came from an invite. */
export function onboardingPathWithNext(next) {
  const safe = safeNextPath(next, "");
  return safe ? `/onboarding/?next=${encodeURIComponent(safe)}` : "/onboarding/";
}
