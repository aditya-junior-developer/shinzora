/* ==========================================================================
   Permission prompt, reminder settings and categories (P5) — no browser
   --------------------------------------------------------------------------
   Pure logic is checked directly. The wiring is checked from the source, so the
   rules that matter most cannot quietly change:
     - the browser's permission is requested only from a click, never on load
     - a denied, granted, unsupported or unconfigured state never shows the prompt
     - "Not now" hides the prompt for two weeks
     - every category and reminder setting is saved through the server
   ========================================================================== */

import { readFileSync } from "node:fs";
import {
  CATEGORIES,
  onboardingState,
  quietHourOptions,
  categoryRows,
  ONBOARDING_SNOOZE_MS
} from "../public/js/ui/notify-reminders.js";

let pass = 0;
let fail = 0;
const check = (name, cond, extra = "") =>
  cond ? (pass++, console.log(`  ✓ ${name}`)) : (fail++, console.log(`  ✗ ${name}${extra ? ` — ${extra}` : ""}`));
const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

console.log("when the prompt shows");
const now = Date.parse("2026-11-15T12:00:00Z");
check("shows only when the browser has never been asked", onboardingState({ reason: "permission-required", now }) === "ask");
check("hidden when the permission is already granted", onboardingState({ reason: "ready", now }) === "hidden");
check("hidden when the browser denied it (never asked again)", onboardingState({ reason: "denied", now }) === "hidden");
check("hidden when the browser cannot do push", onboardingState({ reason: "unsupported", now }) === "hidden");
check("hidden when push is not configured on this deployment", onboardingState({ reason: "no-key", now }) === "hidden");
check("hidden on an insecure origin", onboardingState({ reason: "insecure", now }) === "hidden");
check("hidden during the two-week snooze after 'Not now'",
  onboardingState({ reason: "permission-required", snoozedUntil: now + ONBOARDING_SNOOZE_MS - 1, now }) === "hidden");
check("shows again once the snooze has passed",
  onboardingState({ reason: "permission-required", snoozedUntil: now - 1, now }) === "ask");
check("the snooze is two weeks", ONBOARDING_SNOOZE_MS === 14 * 24 * 60 * 60 * 1000);

console.log("quiet hours choices");
const hours = quietHourOptions(22);
check("24 choices, 00:00 to 23:00", hours.length === 24 && hours[0].label === "00:00" && hours[23].label === "23:00");
check("the saved hour is the one selected", hours.find((h) => h.selected)?.value === 22);
check("only one hour is selected", hours.filter((h) => h.selected).length === 1);

console.log("categories");
const keys = CATEGORIES.map((c) => c.key);
check("the eight existing categories, in order",
  JSON.stringify(keys) === JSON.stringify(["account", "message", "call", "group", "payment", "website", "team", "admin"]),
  keys.join(","));
const rows = categoryRows({ payment: false });
check("a category with no saved value is on", rows.find((r) => r.key === "account").on === true);
check("a category saved as off is off", rows.find((r) => r.key === "payment").on === false);
check("every category has a label and a description", CATEGORIES.every((c) => c.label && c.desc));

console.log("wiring");
const notify = read("public/js/ui/notify-reminders.js");
const shell = read("public/js/modules/dashboard/shell.js");
const settings = read("public/js/modules/dashboard/views/settings.js");
const server = read("supabase/functions/push/index.ts");
const migration = read("supabase/migrations/0053_reminders_quiet_hours_categories.sql");

const requestCalls = [...notify.matchAll(/requestPermission\(/g)].length;
check("the prompt code never calls requestPermission itself (only through enablePush, from a click)", requestCalls === 0, `found ${requestCalls}`);
check("the 'Allow' button is the only path to enablePush",
  /data-onboarding="allow"[\s\S]*?await enablePush\(\)/.test(notify) && (notify.match(/await enablePush\(\)/g) || []).length === 1);
check("the prompt is mounted by the dashboard shell, after a short delay",
  /mountNotificationOnboarding\(\)/.test(shell) && /delayMs = ONBOARDING_DELAY_MS/.test(notify) && /ONBOARDING_DELAY_MS = 8000/.test(notify));
check("the settings card loads and binds the reminder card",
  /loadReminderSettings\(\)/.test(settings) && /reminderSettingsMarkup\(reminders\)/.test(settings) && /bindReminderSettings\(slot\)/.test(settings));
check("reminder and category changes go through the server RPC",
  /rpc\("notification_settings_set"/.test(notify) && /rpc\("notification_settings_get"\)/.test(notify));
check("the browser timezone is sent only when it differs from the stored one",
  /browserTz !== current\.timezone/.test(notify));
check("the push function re-checks reminders and quiet hours on the server",
  /kind === "reminder"/.test(server) && /reminders_off/.test(server) && /quiet_hours/.test(server) && /sz_in_quiet_hours/.test(server));
check("the push function honours a category switched off",
  /categories\[row\.type\] === false/.test(server) && /category_off/.test(server));
check("the database trigger carries reminders, not only group notices",
  /coalesce\(new\.meta->>'kind', ''\)\s*<>\s*'reminder'/.test(migration));
check("reminder settings are never written to localStorage (the server owns them)",
  !/localStorage\.setItem\([^)]*(quiet|reminder|categor)/i.test(notify));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
