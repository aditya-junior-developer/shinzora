/* ==========================================================================
   Shinzora — build notifications
   --------------------------------------------------------------------------
   A site build takes a minute or more. The owner should be able to close the
   tab and be told when the work is finished, so this module asks for the
   browser notification permission at the moment it becomes useful (the start of
   a build, never on page load) and stays honest about the answer:

     granted   → a system notification when the build finishes or fails
     denied    → nothing is asked again; the in-app toast and the notification
                 list carry the same message
     unsupported → same as denied

   The server also writes a row to `notifications`, so the message survives a
   closed tab either way.
   ========================================================================== */

const ASKED_KEY = "shinzora.notify.asked";

export function notificationState() {
  if (typeof window === "undefined" || !("Notification" in window)) return "unsupported";
  return window.Notification.permission; // "default" | "granted" | "denied"
}

/**
 * Ask once, and only when a build is actually starting.
 * Resolves with the permission that is in force afterwards; it never throws.
 */
export async function askNotificationPermission() {
  if (notificationState() !== "default") return notificationState();
  try {
    if (localStorage.getItem(ASKED_KEY) === "1") return notificationState();
  } catch {
    /* The browser's permission state remains the source of truth. */
  }
  try {
    // Remember before opening the prompt: dismissing it must not cause another
    // prompt on the next build.
    try { localStorage.setItem(ASKED_KEY, "1"); } catch { /* browser permission still persists */ }
    return await window.Notification.requestPermission();
  } catch {
    return notificationState();
  }
}

/**
 * Show a system notification for a finished build.
 * Returns true when it was actually shown, so callers can fall back to a toast.
 */
export function notifyBuildResult({ title, body, link, tag }) {
  if (notificationState() !== "granted") return false;
  try {
    const notification = new window.Notification(title, {
      body,
      tag: tag || "shinzora-build",
      icon: "/assets/icons/icon-192.png",
      badge: "/assets/icons/icon-192.png",
      silent: false
    });
    notification.onclick = () => {
      window.focus();
      if (link) window.location.href = link;
      notification.close();
    };
    return true;
  } catch {
    return false;
  }
}

export default { notificationState, askNotificationPermission, notifyBuildResult };
