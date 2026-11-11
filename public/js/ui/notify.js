/* ==========================================================================
   Shinzora · Notifications
   --------------------------------------------------------------------------
   Everything a member hears about a group message goes through this file:
   the in-app notice, the unread badge, the optional chime, the browser
   permission prompt, and the Web Push subscription.

   Two honest levels of delivery:

     open tab     a row arrives over Realtime → a notice appears immediately.
                  This is tested and needs no configuration.
     closed tab   a Web Push message delivered by the service worker. It only
                  works when the browser has granted permission, a subscription
                  row exists, and the `push` Edge Function has its VAPID keys.
                  `pushState()` reports exactly which of those is missing so the
                  UI never promises delivery it cannot make.

   Preferences come from the database (`notification_prefs_*`), not
   localStorage, so a group muted on a phone is muted on a laptop.
   ========================================================================== */

import { qs, esc, on, delegate } from "../lib/dom.js";
import { icon } from "../lib/icons.js";
import { sb, normalizeError } from "../lib/supabase.js";
import { env } from "../config/env.js";
import { timeAgo } from "../lib/format.js";
import { avatarMarkup } from "../lib/avatar.js";
import { toast, toastError } from "./toast.js";

async function rpc(name, args = {}) {
  if (!sb) throw new Error("Notifications are not available right now.");
  const { data, error } = await sb.rpc(name, args);
  if (error) throw normalizeError(error);
  return data;
}

/** Cached copy of the server preferences; `null` until the first read. */
let prefs = null;
let chimeContext = null;
let noticeHost = null;

/* --------------------------------------------------------------- preferences */

export async function loadPrefs(force = false) {
  if (prefs && !force) return prefs;
  prefs = await rpc("notification_prefs_get");
  return prefs;
}

export const cachedPrefs = () => prefs;

export async function savePrefs(patch) {
  const next = await rpc("notification_prefs_set", {
    p_group_messages: patch.groupMessages ?? null,
    p_group_mentions: patch.groupMentions ?? null,
    p_sounds: patch.sounds ?? null,
    p_desktop_notifications: patch.desktopNotifications ?? null,
    p_push_enabled: patch.pushEnabled ?? null
  });
  prefs = next;
  return next;
}

/* --------------------------------------------------------------------- sound */

/**
 * A two-note chime synthesised on the fly. An audio file would be one more
 * request that can fail silently, and the point of the sound is to be noticed.
 * Browsers only allow audio after a gesture, so the context is created on the
 * first interaction and reused.
 */
export function primeAudio() {
  try {
    if (!chimeContext) {
      const AudioCtor = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtor) return null;
      chimeContext = new AudioCtor();
    }
    if (chimeContext.state === "suspended") chimeContext.resume().catch(() => {});
    return chimeContext;
  } catch {
    return null;
  }
}

export function playChime() {
  const ctx = primeAudio();
  if (!ctx) return false;
  try {
    const start = ctx.currentTime;
    [
      { freq: 880, at: 0 },
      { freq: 1320, at: 0.09 }
    ].forEach((note) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = note.freq;
      gain.gain.setValueAtTime(0.0001, start + note.at);
      gain.gain.exponentialRampToValueAtTime(0.06, start + note.at + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + note.at + 0.22);
      osc.connect(gain).connect(ctx.destination);
      osc.start(start + note.at);
      osc.stop(start + note.at + 0.24);
    });
    return true;
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------- in-app notice */

/**
 * A notice that carries who sent it, which group, and a slice of the message —
 * and is visually distinct from an ordinary toast so a mention is never
 * mistaken for a "saved" confirmation.
 */
export function showNotice(row = {}) {
  if (!noticeHost || !document.body.contains(noticeHost)) {
    noticeHost = document.createElement("div");
    noticeHost.className = "notice-stack";
    noticeHost.setAttribute("role", "region");
    noticeHost.setAttribute("aria-label", "New messages");
    document.body.append(noticeHost);
  }

  const meta = row.meta || {};
  const isMention = meta.kind === "mention" || meta.kind === "everyone";
  const isEveryone = meta.kind === "everyone";
  const groupName = meta.groupName || "Group";
  const senderName = meta.senderName || row.title || "Somebody";
  const preview = String(row.body || "").slice(0, 140);

  const node = document.createElement("div");
  node.className = `notice${isMention ? " is-mention" : ""}${isEveryone ? " is-everyone" : ""}`;
  node.innerHTML = `
    <button class="notice-main" type="button">
      <span class="notice-avatar">${avatarMarkup({ name: senderName, alt: "" })}</span>
      <span class="notice-body">
        <span class="notice-top">
          <span class="notice-sender">${esc(senderName)}</span>
          <span class="notice-where">${icon("users", { size: 11 })}${esc(groupName)}</span>
        </span>
        ${isMention ? `<span class="notice-flag">${isEveryone ? "mentioned everyone" : "mentioned you"}</span>` : ""}
        <span class="notice-preview">${esc(preview || "New message")}</span>
        <span class="notice-time">${esc(timeAgo(row.created_at || new Date().toISOString()))}</span>
      </span>
    </button>
    <button class="notice-close" type="button" aria-label="Dismiss">${icon("x", { size: 13 })}</button>`;

  const dismiss = () => {
    node.classList.remove("is-in");
    setTimeout(() => node.remove(), 200);
  };

  on(qs(".notice-close", node), "click", dismiss);
  on(qs(".notice-main", node), "click", async () => {
    dismiss();
    if (row.link) {
      location.assign(row.link);
      return;
    }
    if (meta.groupId) {
      const url = new URL(location.href);
      url.searchParams.set("view", "groups");
      url.searchParams.set("group", meta.groupId);
      if (meta.messageId) url.searchParams.set("message", meta.messageId);
      location.assign(url.toString());
    }
  });

  noticeHost.append(node);
  requestAnimationFrame(() => node.classList.add("is-in"));
  setTimeout(dismiss, isMention ? 12000 : 7000);
  return node;
}

/* ------------------------------------------------------------------ Web Push */

const VAPID_PUBLIC_KEY = env.vapidPublicKey || "";

function urlBase64ToUint8Array(base64String) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) out[i] = raw.charCodeAt(i);
  return out;
}

/** What, if anything, stands between this browser and a closed-tab push. */
export function pushState() {
  if (typeof window === "undefined") return { ok: false, reason: "unsupported" };
  if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) {
    return { ok: false, reason: "unsupported" };
  }
  if (!VAPID_PUBLIC_KEY) return { ok: false, reason: "no-key" };
  if (Notification.permission === "denied") return { ok: false, reason: "denied" };
  if (Notification.permission === "default") return { ok: false, reason: "permission-required" };
  if (!window.isSecureContext) return { ok: false, reason: "insecure" };
  return { ok: true, reason: "ready" };
}

async function currentRegistration() {
  try {
    return (await navigator.serviceWorker.getRegistration()) || (await navigator.serviceWorker.ready);
  } catch {
    return null;
  }
}

/** Store this browser's subscription with the server, reviving it if needed. */
export async function syncPush() {
  const state = pushState();
  if (!state.ok) return state;
  const registration = await currentRegistration();
  if (!registration?.pushManager) return { ok: false, reason: "unsupported" };

  let subscription = await registration.pushManager.getSubscription();
  if (!subscription) return { ok: false, reason: "not-subscribed" };
  const json = subscription.toJSON();
  try {
    const result = await rpc("push_subscribe", {
      p_endpoint: json.endpoint,
      p_p256dh: json.keys?.p256dh || "",
      p_auth: json.keys?.auth || "",
      p_user_agent: navigator.userAgent
    });
    prefs = prefs ? { ...prefs, pushEnabled: true, devices: result?.devices ?? prefs.devices } : prefs;
    return { ok: true, reason: "subscribed", devices: result?.devices ?? 1 };
  } catch (error) {
    return { ok: false, reason: "server", error };
  }
}

/** Ask once, on a click, then subscribe. Never called on page load. */
export async function enablePush() {
  const state = pushState();
  if (state.reason === "no-key") {
    throw new Error("Web Push is not configured on this deployment yet, so closed-tab alerts are off.");
  }
  if (state.reason === "unsupported") {
    throw new Error(
      "This browser cannot receive closed-tab notifications. Keep the Shinzora tab open to see group messages arrive live."
    );
  }
  if (state.reason === "insecure") {
    throw new Error("Closed-tab notifications need an https address.");
  }

  const permission = await Notification.requestPermission();
  if (permission !== "granted") {
    throw new Error(
      permission === "denied"
        ? "Notifications are blocked for this site. Allow them in the browser's site settings, then try again."
        : "Permission was not granted, so closed-tab alerts stay off."
    );
  }

  const registration = await currentRegistration();
  if (!registration?.pushManager) throw new Error("The service worker is not ready. Reload and try again.");

  let subscription = await registration.pushManager.getSubscription();
  if (!subscription) {
    subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY)
    });
  }
  const json = subscription.toJSON();
  const result = await rpc("push_subscribe", {
    p_endpoint: json.endpoint,
    p_p256dh: json.keys?.p256dh || "",
    p_auth: json.keys?.auth || "",
    p_user_agent: navigator.userAgent
  });
  await savePrefs({ pushEnabled: true });
  return { devices: result?.devices ?? 1 };
}

export async function disablePush() {
  const registration = await currentRegistration();
  const subscription = await registration?.pushManager?.getSubscription();
  if (subscription) {
    const endpoint = subscription.endpoint;
    try {
      await subscription.unsubscribe();
    } catch {
      /* the browser may already have dropped it */
    }
    try {
      await rpc("push_unsubscribe", { p_endpoint: endpoint });
    } catch {
      /* the row is already gone; the local unsubscribe is what matters */
    }
  }
  await savePrefs({ pushEnabled: false });
  return { devices: 0 };
}

/* ------------------------------------------------------------ the live wire */

/**
 * Handle one `notifications` row however it reached us: from Realtime, from the
 * drawer's own list, or from a service worker message. Returns false when the
 * member's preferences say to stay quiet, so callers can tell the difference
 * between "delivered" and "suppressed".
 */
/**
 * Raise an operating-system notification while the tab is open.
 *
 * The "Desktop alerts" preference has been a switch since this file was written
 * and nothing behind it — a dead control. This is the implementation: the same
 * title, sender and link the in-app notice carries, shown by the OS so it is
 * visible when the Shinzora tab is behind another window.
 */
function showDesktopAlert(row) {
  if (!("Notification" in window) || Notification.permission !== "granted") return false;
  if (prefs && prefs.desktopNotifications === false) return false;
  try {
    const meta = row.meta || {};
    const title = row.title || meta.groupName || "Shinzora";
    const notification = new Notification(title, {
      body: row.body || "",
      tag: meta.messageId ? `shinzora-${meta.messageId}` : undefined,
      icon: "/assets/icons/icon-192.png",
      silent: prefs ? prefs.sounds === false : false,
      data: { url: row.link || "/app/?view=messages&tab=groups" }
    });
    notification.onclick = () => {
      window.focus();
      if (row.link) location.assign(row.link);
      notification.close();
    };
    /* A tab that is in front already shows the in-app notice; two identical
       popups is noise. The OS alert is for when this window is behind. */
    setTimeout(() => notification.close(), 12000);
    return true;
  } catch {
    return false;
  }
}

export function presentNotification(row, { playSound = true } = {}) {
  const meta = row?.meta || {};
  const isGroup = row?.type === "group" || Boolean(meta.groupId);

  if (isGroup) {
    const mention = meta.kind === "mention" || meta.kind === "everyone";
    if (mention && prefs && prefs.groupMentions === false) return false;
    if (!mention && prefs && prefs.groupMessages === false) return false;
    if (prefs?.mutedGroups?.includes(meta.groupId)) return false;
  }

  showNotice(row);
  if (document.hidden) showDesktopAlert(row);
  if (playSound && (!prefs || prefs.sounds !== false)) {
    try {
      localStorage.setItem("shinzora:last-notice", String(Date.now()));
    } catch {
      /* private mode */
    }
    playChime();
  }
  return true;
}

/**
 * Ask the server to create one real notification for this account, then watch
 * for it arrive.
 *
 * This is how "I am not getting notifications" becomes answerable: the row is
 * genuine (stored, counted in the badge, pushed like any other), so if it does
 * not appear the break is in the client path and not in the data. Nothing is
 * faked and nothing is seeded — the row is addressed to the caller and is
 * deleted again by the same button.
 */
export async function sendTestNotification() {
  const result = await rpc("notification_self_test");
  return result;
}

export async function clearTestNotifications() {
  return rpc("notification_self_test_clear");
}

/* ------------------------------------------------------------- preferences UI */

const TOGGLES = [
  {
    key: "groupMessages",
    label: "Group messages",
    desc: "Every message posted in a group you are in."
  },
  {
    key: "groupMentions",
    label: "Mentions of you",
    desc: "Always delivered, even when you turn group messages off."
  },
  { key: "sounds", label: "Sound", desc: "A short chime when a notice appears." },
  {
    key: "desktopNotifications",
    label: "Desktop alerts while the tab is open",
    desc: "Uses your operating system's notification centre."
  }
];

export function notificationSettingsMarkup(groupList = []) {
  const muted = (groupList || []).filter((group) => group.muted);
  const push = pushState();
  const devices = prefs?.devices ?? 0;
  const pushLabel =
    push.reason === "no-key"
      ? "Not configured on this deployment"
      : push.reason === "unsupported"
      ? "This browser cannot receive them"
      : push.reason === "denied"
      ? "Blocked in this browser's settings"
      : devices > 0
      ? `On · ${devices} device${devices === 1 ? "" : "s"}`
      : "Off";

  return `<div class="card" id="notify-card">
    <div class="card-head">
      <div>
        <div class="card-title">Groups &amp; mentions</div>
        <div class="card-sub">These apply on every device — they are stored with your account.</div>
      </div>
    </div>
    <div class="card-body">
      <div class="stack gap-3">
        ${TOGGLES.map(
          (toggle) => `<div class="row gap-3 setting-row">
            <div class="grow">
              <div style="font-size:var(--fs-sm);color:var(--text)">${esc(toggle.label)}</div>
              <div class="dim" style="font-size:var(--fs-2xs)">${esc(toggle.desc)}</div>
            </div>
            <label class="switch">
              <input type="checkbox" data-notify-pref="${toggle.key}" ${prefs?.[toggle.key] !== false ? "checked" : ""} />
              <span class="switch-track"></span>
            </label>
          </div>`
        ).join("")}

        <div class="row gap-3 setting-row">
          <div class="grow">
            <div style="font-size:var(--fs-sm);color:var(--text)">Closed-tab alerts (Web Push)</div>
            <div class="dim" style="font-size:var(--fs-2xs)">
              ${
                push.reason === "no-key"
                  ? "This deployment has no VAPID keys yet, so pushes cannot be sent. In-app notices still arrive while the tab is open."
                  : push.reason === "unsupported"
                  ? "This browser does not support Web Push. Keep a Shinzora tab open for live notices."
                  : "Delivered by the service worker, so it arrives with Shinzora closed."
              }
            </div>
          </div>
          <span class="grp-push-state" id="grp-push-state">${esc(pushLabel)}</span>
          ${
            push.reason === "no-key" || push.reason === "unsupported"
              ? ""
              : `<button class="btn btn-secondary btn-sm" type="button" id="grp-push-toggle">
                  ${devices > 0 ? "Turn off" : "Turn on"}
                </button>`
          }
        </div>

        <div class="setting-row">
          <div style="font-size:var(--fs-sm);color:var(--text);margin-bottom:6px">Muted groups</div>
          ${
            muted.length
              ? `<div class="grp-muted-list">${muted
                  .map(
                    (group) => `<button class="chip chip-muted" type="button" data-unmute="${esc(group.id)}">
                      ${esc(group.name)} ${icon("x", { size: 11 })}
                    </button>`
                  )
                  .join("")}</div>
              <div class="dim" style="font-size:var(--fs-2xs);margin-top:6px">Muting a group stops its message notices. Mentions you are allowed to receive still get through.</div>`
              : `<div class="dim" style="font-size:var(--fs-2xs)">No groups muted. Mute one from its group info panel.</div>`
          }
        </div>
      </div>

      <div class="notify-test">
        <div class="notify-test-copy">
          <div style="font-size:var(--fs-sm);color:var(--text)">Test this account</div>
          <div class="dim" style="font-size:var(--fs-2xs)">
            Creates one real notification for you and watches it arrive. Delete it again afterwards.
          </div>
        </div>
        <div class="notify-test-actions">
          <button class="btn btn-secondary btn-sm" type="button" id="notify-test-send">Send a test</button>
          <button class="btn btn-ghost btn-sm" type="button" id="notify-test-clear" hidden>Remove it</button>
        </div>
      </div>
      <div class="notify-test-result" id="notify-test-result" hidden></div>

      <div class="alert alert-info" style="margin-top:var(--s-4);font-size:var(--fs-2xs)">
        ${icon("info", { size: 14 })}
        <span>The browser permission is asked once, when you press “Turn on” — not when the page loads.</span>
      </div>
    </div>
  </div>`;
}

/** Wire the card above. `refresh` re-paints the muted list after an unmute. */
export function bindNotificationSettings(root, { refresh } = {}) {
  const card = qs("#notify-card", root);
  if (!card) return;

  delegate(card, "change", "[data-notify-pref]", async (event, node) => {
    const key = node.getAttribute("data-notify-pref");
    const value = node.checked;
    node.disabled = true;
    try {
      await savePrefs({ [key]: value });
      toast({ title: "Notification setting saved" }, { tone: "success", duration: 2000 });
    } catch (error) {
      node.checked = !value;
      toastError(error);
    } finally {
      node.disabled = false;
    }
  });

  const pushButton = qs("#grp-push-toggle", card);
  if (pushButton) {
    on(pushButton, "click", async () => {
      const label = qs("#grp-push-state", card);
      pushButton.disabled = true;
      try {
        const on_ = pushButton.textContent.trim() === "Turn off";
        const result = on_ ? await disablePush() : await enablePush();
        const count = on_ ? 0 : result.devices;
        if (label) label.textContent = count > 0 ? `On · ${count} device${count === 1 ? "" : "s"}` : "Off";
        pushButton.textContent = count > 0 ? "Turn off" : "Turn on";
        toast({ title: count > 0 ? "Closed-tab alerts are on" : "Closed-tab alerts are off" }, { tone: "success" });
      } catch (error) {
        toastError(error);
      } finally {
        pushButton.disabled = false;
      }
    });
  }

  const testBtn = qs("#notify-test-send", card);
  const clearBtn = qs("#notify-test-clear", card);
  const testOut = qs("#notify-test-result", card);

  function reportTest(lines, tone = "") {
    if (!testOut) return;
    testOut.hidden = false;
    testOut.className = `notify-test-result${tone ? ` is-${tone}` : ""}`;
    testOut.innerHTML = `<ul>${lines.map((line) => `<li>${esc(line)}</li>`).join("")}</ul>`;
  }

  if (testBtn) {
    on(testBtn, "click", async () => {
      testBtn.disabled = true;
      testBtn.textContent = "Sending…";
      try {
        await loadPrefs(true);
        const result = await sendTestNotification();
        const lines = [
          result?.inGroup
            ? `A real notification was stored for you, linked to "${result.groupName}".`
            : "A real notification was stored for you (you are not in a group, so it links to Settings).",
          "The in-app notice and the sidebar badge should update within a second or two."
        ];
        if (Notification?.permission === "granted") {
          lines.push("Browser permission is granted — with this tab behind another window you should also get a system alert.");
        } else {
          lines.push(
            `Browser permission is "${Notification?.permission || "unsupported"}", so no system alert or closed-tab alert can appear until you press “Turn on”.`
          );
        }
        lines.push(
          result?.pushDevices
            ? `${result.pushDevices} device${result.pushDevices === 1 ? "" : "s"} subscribed for closed-tab push.`
            : "No device is subscribed for closed-tab push, so nothing will arrive with Shinzora closed — that is why “Turn on” exists."
        );
        reportTest(lines, "ok");
        if (clearBtn) clearBtn.hidden = false;
        /* Wait for it to actually arrive rather than assuming it did. */
        setTimeout(() => {
          const saw = document.querySelector(".notice");
          if (!saw && testOut) {
            reportTest(
              [
                ...lines,
                "The row was stored but no notice appeared here: the Realtime stream is not reaching this tab. Reload once; if it persists, the subscription is the problem, not the data."
              ],
              "warn"
            );
          }
        }, 4000);
      } catch (error) {
        reportTest([`The server refused to create the test notification: ${error.message}`], "bad");
      } finally {
        testBtn.disabled = false;
        testBtn.textContent = "Send a test";
      }
    });
  }

  if (clearBtn) {
    on(clearBtn, "click", async () => {
      try {
        const result = await clearTestNotifications();
        if (testOut) {
          testOut.hidden = false;
          testOut.className = "notify-test-result";
          testOut.innerHTML = `<ul><li>Removed ${result?.removed ?? 0} test notification(s).</li></ul>`;
        }
        clearBtn.hidden = true;
      } catch (error) {
        toastError(error);
      }
    });
  }

  delegate(card, "click", "[data-unmute]", async (_event, chip) => {
    const groupId = chip.getAttribute("data-unmute");
    try {
      await rpc("group_set_muted", { p_group: groupId, p_muted: false });
      chip.remove();
      toast({ title: "Group unmuted" }, { tone: "success" });
      refresh?.();
    } catch (error) {
      toastError(error);
    }
  });
}

/**
 * Boot the layer once per signed-in session: prefs, audio unlock, a re-sync of
 * an existing subscription (endpoints expire, and a stale row would make the
 * settings card claim delivery that will never happen).
 */
export async function initNotifications({ onChange } = {}) {
  try {
    await loadPrefs(true);
    onChange?.(prefs);
  } catch {
    /* Signed out, or the migration is not applied — the app keeps working. */
  }

  const unlock = () => {
    primeAudio();
    document.removeEventListener("pointerdown", unlock);
    document.removeEventListener("keydown", unlock);
  };
  document.addEventListener("pointerdown", unlock, { once: true });
  document.addEventListener("keydown", unlock, { once: true });

  /* Keep our own subscription honest without prompting for anything. */
  if (prefs?.pushEnabled) syncPush().then((state) => {
    if (state?.reason === "not-subscribed") {
      /* The browser dropped it. Say so instead of pretending. */
      savePrefs({ pushEnabled: false }).catch(() => {});
    }
    onChange?.(prefs);
  }).catch(() => {});

  return prefs;
}
