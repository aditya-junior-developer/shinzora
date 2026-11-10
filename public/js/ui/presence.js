/* ==========================================================================
   Shinzora — presence
   --------------------------------------------------------------------------
   One definition of "who is around", used by the team list, the message inbox
   and the admin console. The server stores one number — `profiles.last_seen_at`,
   written by the heartbeat every minute — and everything else is arithmetic on
   that number, so the three screens can never disagree.

     active    seen in the last 90 seconds      green dot
     recent    seen in the last 3 minutes       amber dot
     offline   anything older, or never seen    crossed-out dot

   Deliberately forgiving of clock skew: a heartbeat that arrives a second in the
   future is still "active", not "in 400 years".
   ========================================================================== */

export const ACTIVE_WINDOW_MS = 90 * 1000;
export const RECENT_WINDOW_MS = 3 * 60 * 1000;

const parse = (value) => {
  if (!value) return null;
  const time = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(time) ? time : null;
};

/**
 * @param {string|Date|null} lastSeenAt
 * @param {number} [now] injectable clock, so the test does not depend on wall time
 * @returns {"active"|"recent"|"offline"}
 */
export function presenceState(lastSeenAt, now = Date.now()) {
  const seen = parse(lastSeenAt);
  if (seen === null) return "offline";
  const age = now - seen;
  if (age <= ACTIVE_WINDOW_MS) return "active";
  if (age <= RECENT_WINDOW_MS) return "recent";
  return "offline";
}

const LABEL = {
  active: "Active now",
  recent: "Active a moment ago",
  offline: "Offline"
};

export const presenceLabel = (state) => LABEL[state] || LABEL.offline;

/**
 * The dot itself. An offline member gets the crossed circle from the design
 * reference rather than a faded green dot, so "not here" is legible without
 * relying on colour — which is also what colour-blind readers need.
 *
 * @param {string|Date|null} lastSeenAt
 * @param {{size?: number, className?: string, now?: number}} [options]
 */
export function presenceDot(lastSeenAt, options = {}) {
  const { size = 10, className = "", now = Date.now() } = options;
  const state = presenceState(lastSeenAt, now);
  const label = presenceLabel(state);
  const style = `width:${size}px;height:${size}px`;
  return `<span class="presence presence-${state} ${className}" style="${style}" role="img" aria-label="${label}" title="${label}" data-presence="${state}"></span>`;
}

/**
 * A member avatar with its status dot underneath-left, as asked for: the dot
 * sits under the picture, not on the shoulder, so it never covers a face.
 */
export function avatarWithPresence({ name = "Member", avatarUrl = null, lastSeenAt = null, size = 36, now = Date.now() } = {}) {
  const initials = String(name || "Member")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0])
    .join("")
    .toUpperCase();
  const picture = avatarUrl
    ? `<img class="presence-avatar-img" src="${avatarUrl}" alt="" width="${size}" height="${size}" loading="lazy" />`
    : `<span class="presence-avatar-initials">${initials}</span>`;
  return `<span class="presence-avatar" style="width:${size}px;height:${size}px">
    ${picture}
    ${presenceDot(lastSeenAt, { size: Math.round(size / 3.6), now })}
  </span>`;
}
