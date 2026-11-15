/* ==========================================================================
   Shinzora · Reminders, quiet hours, categories and the permission prompt (P5)
   --------------------------------------------------------------------------
   Three things, all following the browser's own permission:

   1. The onboarding prompt. A small card on the dashboard explains what
      notifications are for, and only asks when the browser says "default"
      (never asked yet). Pressing "Allow" is the only thing that calls the
      browser's request, and it runs straight from the click. "Not now" hides
      the card for two weeks. A denied permission is never asked again, and no
      code here bypasses it: the settings card says so and shows how to change it.

   2. Reminder settings: an opt-out for four-hour reminders, quiet hours (off
      by default) with a start and an end, the member's timezone, and one switch
      per category. Everything is stored with the account (notification_settings_*
      RPCs), so a phone and a laptop agree.

   3. The category list. A category switch controls the closed-tab alert only.
      The in-app notice is always stored, so nothing is lost.

   Pure logic (`onboardingState`, `quietHourOptions`, `categoryRows`) is exported
   so it can be tested in Node without a browser.
   ========================================================================== */

import { qs, esc, on, delegate } from "../lib/dom.js";
import { sb, normalizeError } from "../lib/supabase.js";
import { toast, toastError } from "./toast.js";
import { pushState, enablePush } from "./notify.js";

export const CATEGORIES = Object.freeze([
  { key: "account", label: "Account", desc: "Sign-in, verification, and notices about your account." },
  { key: "message", label: "Direct messages", desc: "New one-to-one messages." },
  { key: "call", label: "Calls", desc: "Incoming and missed calls and meetings." },
  { key: "group", label: "Groups", desc: "Group activity you are part of." },
  { key: "payment", label: "Payments", desc: "Receipts and payment confirmations." },
  { key: "website", label: "Websites", desc: "Builds that finish or fail, and publishing." },
  { key: "team", label: "Team", desc: "Invitations and changes to your team." },
  { key: "admin", label: "Admin notices", desc: "Messages from the Shinzora team." }
]);

export const ONBOARDING_KEY = "shinzora.notify.onboarding.until";
export const ONBOARDING_SNOOZE_MS = 14 * 24 * 60 * 60 * 1000;
const ONBOARDING_DELAY_MS = 8000;

/* ------------------------------------------------------------ pure logic */

/**
 * Whether the permission card should show.
 * `reason` is pushState().reason from notify.js. Only "permission-required"
 * (the browser has never asked) can produce "ask". Everything else is "hidden":
 * a granted or denied permission, a browser or deployment that cannot do push,
 * and a card the member has snoozed.
 */
export function onboardingState({ reason, snoozedUntil = 0, now = Date.now() } = {}) {
  if (reason !== "permission-required") return "hidden";
  if (snoozedUntil && now < snoozedUntil) return "hidden";
  return "ask";
}

/** Hours 00:00 to 23:00, for the quiet-hours selects. */
export function quietHourOptions(selected) {
  return Array.from({ length: 24 }, (_, hour) => ({
    value: hour,
    label: `${String(hour).padStart(2, "0")}:00`,
    selected: hour === Number(selected)
  }));
}

/** One row per category, with its switch state. Missing keys count as on. */
export function categoryRows(categories = {}) {
  return CATEGORIES.map((category) => ({
    ...category,
    on: categories?.[category.key] !== false
  }));
}

/* ------------------------------------------------------------ settings RPCs */

let settings = null;

async function rpc(name, args = {}) {
  if (!sb) throw new Error("Notification settings are not available right now.");
  const { data, error } = await sb.rpc(name, args);
  if (error) throw normalizeError(error);
  return data;
}

export const cachedReminderSettings = () => settings;

/**
 * Read the member's reminder settings. If the browser's timezone differs from
 * the one stored, the browser's is saved, because reminders and quiet hours are
 * computed in the member's local time. A failure to save is not an error.
 */
export async function loadReminderSettings() {
  const current = await rpc("notification_settings_get");
  settings = current;
  const browserTz = browserTimezone();
  if (browserTz && current && browserTz !== current.timezone) {
    try {
      settings = await rpc("notification_settings_set", { p_patch: { timezone: browserTz } });
    } catch {
      /* keep the stored timezone; the next visit tries again */
    }
  }
  return settings;
}

export async function saveReminderSettings(patch) {
  settings = await rpc("notification_settings_set", { p_patch: patch });
  return settings;
}

export function browserTimezone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "";
  } catch {
    return "";
  }
}

/* ------------------------------------------------------------ settings card */

/** The reminder card. It sits under the existing notification card in settings. */
export function reminderSettingsMarkup(current = settings) {
  if (!current) {
    return `<div class="card" id="reminder-card"><div class="card-body">
      <p class="muted" style="font-size:var(--fs-xs)">Reminder settings could not be loaded. Reload the page to try again.</p>
    </div></div>`;
  }
  const quietOn = Boolean(current.quietHoursEnabled);
  const hours = (selected) =>
    quietHourOptions(selected)
      .map((h) => `<option value="${h.value}" ${h.selected ? "selected" : ""}>${h.label}</option>`)
      .join("");
  return `<div class="card" id="reminder-card">
    <div class="card-head">
      <div>
        <div class="card-title">Reminders and quiet hours</div>
        <div class="card-sub">Stored with your account. Times use ${esc(current.timezone || "UTC")}.</div>
      </div>
    </div>
    <div class="card-body">
      <div class="stack gap-3">
        <div class="row gap-3 setting-row">
          <div class="grow">
            <div style="font-size:var(--fs-sm);color:var(--text)">Four-hour reminders</div>
            <div class="dim" style="font-size:var(--fs-2xs)">
              If you have been away for four hours, Shinzora sends one reminder, then at most one every four hours.
              It appears in your notices and, if you allowed alerts, as a closed-tab alert.
            </div>
          </div>
          <label class="switch">
            <input type="checkbox" data-reminder="remindersEnabled" ${current.remindersEnabled ? "checked" : ""} />
            <span class="switch-track"></span>
          </label>
        </div>

        <div class="row gap-3 setting-row">
          <div class="grow">
            <div style="font-size:var(--fs-sm);color:var(--text)">Quiet hours</div>
            <div class="dim" style="font-size:var(--fs-2xs)">
              No reminders or closed-tab alerts during this window. Off unless you turn it on.
            </div>
          </div>
          <label class="switch">
            <input type="checkbox" data-reminder="quietHoursEnabled" ${quietOn ? "checked" : ""} />
            <span class="switch-track"></span>
          </label>
        </div>
        <div class="row gap-3 wrap" id="quiet-window" ${quietOn ? "" : "hidden"} style="padding-left:var(--s-3)">
          <label class="dim" style="font-size:var(--fs-2xs)">From
            <select class="input" data-reminder="quietStart" style="margin-left:6px">${hours(current.quietStart)}</select>
          </label>
          <label class="dim" style="font-size:var(--fs-2xs)">To
            <select class="input" data-reminder="quietEnd" style="margin-left:6px">${hours(current.quietEnd)}</select>
          </label>
        </div>

        <div class="setting-row">
          <div style="font-size:var(--fs-sm);color:var(--text);margin-bottom:6px">Closed-tab alerts by category</div>
          <div class="dim" style="font-size:var(--fs-2xs);margin-bottom:8px">
            A switch off here stops only the closed-tab alert. The notice still appears in your list.
          </div>
          <div class="stack gap-2">
            ${categoryRows(current.categories)
              .map(
                (row) => `<div class="row gap-3 setting-row">
                  <div class="grow">
                    <div style="font-size:var(--fs-sm);color:var(--text)">${esc(row.label)}</div>
                    <div class="dim" style="font-size:var(--fs-2xs)">${esc(row.desc)}</div>
                  </div>
                  <label class="switch">
                    <input type="checkbox" data-category="${row.key}" ${row.on ? "checked" : ""} />
                    <span class="switch-track"></span>
                  </label>
                </div>`
              )
              .join("")}
          </div>
        </div>
        <div class="dim" style="font-size:var(--fs-2xs)" id="reminder-tz-note">Timezone: ${esc(current.timezone || "UTC")}</div>
      </div>
    </div>
  </div>`;
}

/** Wire the reminder card. Each change saves on its own and reverts if refused. */
export function bindReminderSettings(root) {
  const card = qs("#reminder-card", root);
  if (!card) return;

  /* Remember a select's value before it changes, so a refused save can put it back. */
  delegate(card, "focusin", "select[data-reminder]", (event, node) => {
    node.setAttribute("data-prev", node.value);
  });

  delegate(card, "change", "[data-reminder], [data-category]", async (event, node) => {
    const isCategory = node.hasAttribute("data-category");
    const key = isCategory ? node.getAttribute("data-category") : node.getAttribute("data-reminder");
    const before = node.type === "checkbox" ? !node.checked : node.getAttribute("data-prev");
    const patch = isCategory
      ? { categories: { [key]: node.checked } }
      : { [key]: node.type === "checkbox" ? node.checked : Number(node.value) };
    if (node.tagName === "SELECT") node.setAttribute("data-prev", node.value);

    node.disabled = true;
    try {
      const next = await saveReminderSettings(patch);
      if (key === "quietHoursEnabled") {
        const window = qs("#quiet-window", card);
        if (window) window.hidden = !next.quietHoursEnabled;
      }
      toast({ title: "Notification setting saved" }, { tone: "success", duration: 2000 });
    } catch (error) {
      if (node.type === "checkbox") node.checked = Boolean(before);
      else if (before !== null) node.value = String(before);
      toastError(error);
    } finally {
      node.disabled = false;
    }
  });
}

/* ------------------------------------------------------------ onboarding card */

function snoozedUntil() {
  try {
    return Number(localStorage.getItem(ONBOARDING_KEY) || 0) || 0;
  } catch {
    return 0;
  }
}

function snooze() {
  try {
    localStorage.setItem(ONBOARDING_KEY, String(Date.now() + ONBOARDING_SNOOZE_MS));
  } catch {
    /* No storage: the card returns on the next visit. That is the honest default. */
  }
}

/**
 * Show the permission card once, after a short delay, when the browser has
 * never asked. It never runs before the member is on a dashboard page, and it
 * does nothing when a permission is already decided.
 */
export function mountNotificationOnboarding({ delayMs = ONBOARDING_DELAY_MS, root = globalThis.document } = {}) {
  if (!root?.body || root.getElementById?.("notify-onboarding")) return;
  const timer = globalThis.setTimeout?.(() => {
    const state = onboardingState({ reason: pushState().reason, snoozedUntil: snoozedUntil() });
    if (state !== "ask" || root.getElementById("notify-onboarding")) return;
    renderOnboarding(root);
  }, delayMs);
  timer?.unref?.();
}

function renderOnboarding(root) {
  const host = root.createElement("div");
  host.id = "notify-onboarding";
  host.setAttribute("role", "region");
  host.setAttribute("aria-label", "Turn on notifications");
  host.style.cssText =
    "position:fixed;right:16px;bottom:16px;z-index:60;max-width:340px;background:var(--surface,#fff);color:var(--text,#111);" +
    "border:1px solid var(--border,#ddd);border-radius:12px;padding:14px 16px;box-shadow:0 8px 30px rgba(0,0,0,.18);font-size:14px;line-height:1.5";
  host.innerHTML = `
    <div style="font-weight:600;margin-bottom:4px">Get Shinzora alerts when you are away</div>
    <div style="opacity:.8;font-size:13px">Your browser will ask you to allow notifications. We only ask if you say yes here, and you can turn it off in Settings at any time.</div>
    <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:12px">
      <button type="button" class="btn btn-ghost btn-sm" data-onboarding="later">Not now</button>
      <button type="button" class="btn btn-primary btn-sm" data-onboarding="allow">Allow notifications</button>
    </div>
    <div data-onboarding="status" role="status" style="font-size:12px;opacity:.8;margin-top:8px" hidden></div>`;
  root.body.appendChild(host);

  const status = host.querySelector('[data-onboarding="status"]');
  const say = (text) => {
    status.hidden = false;
    status.textContent = text;
  };
  const close = () => host.remove();

  on(host.querySelector('[data-onboarding="later"]'), "click", () => {
    snooze();
    close();
  });

  on(host.querySelector('[data-onboarding="allow"]'), "click", async (event) => {
    event.currentTarget.disabled = true;
    try {
      // enablePush() asks the browser from inside this click. Nothing before it
      // awaits, so the browser still counts the press as the member's choice.
      await enablePush();
      toast({ title: "Alerts are on", message: "You will hear from Shinzora when you are away." }, { tone: "success" });
      close();
    } catch (error) {
      const message = normalizeError(error)?.message || "Notifications were not turned on.";
      say(message);
      // A refusal is an answer. Do not ask again for two weeks.
      if (/blocked|not granted|denied/i.test(message)) snooze();
      event.currentTarget.disabled = false;
    }
  });
}
