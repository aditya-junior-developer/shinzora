import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");
const [data, notifView, shell, adminUi, adminFn, idempotency, teamSql, teamUi, settings, messagesView] = await Promise.all([
  read("../public/js/modules/dashboard/data.js"),
  read("../public/js/modules/dashboard/views/notifications.js"),
  read("../public/js/modules/dashboard/shell.js"),
  read("../public/js/modules/admin/views/messaging.js"),
  read("../supabase/functions/admin/index.ts"),
  read("../supabase/migrations/0017_announcement_delivery_idempotency.sql"),
  read("../supabase/migrations/0018_team_invites_and_chat.sql"),
  read("../public/js/modules/messaging/team-chat.js"),
  read("../public/js/modules/dashboard/views/settings.js"),
  read("../public/js/modules/dashboard/views/messages.js")
]);

assert.match(data, /\.eq\("user_id", uid\(\)\)[\s\S]*?\.select\("id"\)/, "read updates are explicitly scoped and acknowledged");
assert.match(data, /markAllNotificationsRead[\s\S]*?\.eq\("user_id", uid\(\)\)[\s\S]*?\.is\("read_at", null\)/, "bulk read writes only this user's unread rows");
assert.match(notifView, /button\.disabled = true[\s\S]*?await markAllNotificationsRead[\s\S]*?finally[\s\S]*?button\.disabled = false/, "notification page prevents repeated bulk actions");
assert.match(shell, /await markAllNotificationsRead[\s\S]*?notificationRows\.forEach/, "drawer updates local read state after the write");
assert.match(adminUi, /sendingAnnouncement[\s\S]*?crypto\.randomUUID\(\)[\s\S]*?requestKey: pendingRequestKey/, "announcement submit is locked and idempotent");
assert.match(adminFn, /admin\(\)\.rpc\("admin_create_announcement"/, "announcement delivery is delegated to the atomic database RPC");
assert.match(idempotency, /create unique index[\s\S]*?request_key[\s\S]*?select distinct[\s\S]*?public\.notifications/, "one request creates one announcement and a distinct-recipient fan-out");
assert.match(teamSql, /team_search_by_email[\s\S]*?lower\(p\.email\) = normalized/, "email lookup is exact-match only");
assert.match(teamSql, /team_accept_invite[\s\S]*?invite_email_normalized = mail/, "invite acceptance requires the signed-in email to match");
assert.match(teamSql, /team_chat_start[\s\S]*?is_business_team_member/, "conversation creation validates team membership");
assert.match(teamSql, /values \('team-chat-files',[\s\S]*?false, 20971520/, "message attachments use private storage");
assert.match(teamUi, /https:\/\/mail\.google\.com\/mail\//, "email invitations open Gmail for the user to send");
assert.match(teamUi, /ALLOWED_FILES = new Set\(\["image\/jpeg"[\s\S]*?"application\/pdf"\]/, "team chat supports image and PDF attachments");
assert.match(teamUi, /rpc\("team_chat_send"/, "messages are sent through the secure team-chat RPC");
assert.match(teamUi, /QUICK_EMOJI[\s\S]*?linkify\(/, "team chat supports emoji and safe clickable links");
assert.match(settings, /name="member_type"[\s\S]*?Freelancer[\s\S]*?Agent/, "users can edit their profile role");
assert.match(messagesView, /Team chat[\s\S]*?Shinzora support/, "team chat keeps the existing support channel available");
assert.match(messagesView, /!params\.has\("channel"\) && params\.has\("c"\)/, "legacy support links with only a conversation ID still open support");
assert.match(messagesView, /url\.searchParams\.delete\("c"\)[\s\S]*?params\.delete\("c"\)/, "switching message tabs clears stale conversation IDs");

console.log("  ✓ notifications, idempotent announcements, Gmail invitations and secure team chat contracts");
