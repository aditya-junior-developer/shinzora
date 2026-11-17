export {};
// ============================================================================
// Shinzora · SHINZORA CONNECT — Daily.co meetings (Edge Function `daily`)
// ----------------------------------------------------------------------------
// The only place that talks to Daily's REST API. The browser never sees
// DAILY_API_KEY: it receives a per-person meeting token and the room URL, and
// nothing else from Daily.
//
// Required secrets (Supabase project secrets, never committed):
//   DAILY_API_KEY   Daily REST key
//   DAILY_DOMAIN    e.g. shinzora.daily.co  (room URLs must be on this host)
//
// Rules enforced here, on the server:
//   - a meeting's link is valid while the meeting is live or waiting, and for
//     24 hours after it ends (meetings.expires_at, set by a database trigger)
//   - an expired link cannot reopen the meeting; no token is ever minted for it
//   - a locked meeting admits only its host and managers
//   - host controls (end, lock, remove people, presence) need host, manager or
//     administrator rights, checked against the database every time
//   - a double-submitted create returns the same meeting (create_request_id)
//   - a room is created once per session; a race reuses the room that won
//   - expired rooms are deleted (sweep), so Daily keeps nothing past the window
//
// Every request needs a signed-in user's JWT (verify_jwt = true in config.toml).
// ============================================================================

/* ------------------------------------------------------------ database client
   A small PostgREST client that replaces the esm.sh supabase-js import. Remote
   imports stop the function booting when it is deployed through the connector
   (every request returns BOOT_ERROR 503), and this function only needs table
   reads and writes plus one auth lookup, so no SDK is required. The surface
   matches the calls made below: select, insert, update, upsert, delete, eq, is,
   in, lt, not, or, order, limit, maybeSingle, single. */
type DbError = { message: string; code?: string; status?: number };
type DbReply = { data: any; error: DbError | null; count: number | null };

class Db {
  constructor(readonly url: string, readonly key: string) {}
  from(table: string) {
    return new Query(this, table);
  }
}

class Query implements PromiseLike<DbReply> {
  private method = "GET";
  private params = new URLSearchParams();
  private body: unknown = undefined;
  private wantRows = false;
  private isUpsert = false;
  private countMode: "exact" | null = null;
  private headOnly = false;
  private one: "none" | "maybe" | "single" = "none";

  constructor(private db: Db, private table: string) {}

  select(cols = "*", opts: { count?: "exact"; head?: boolean } = {}) {
    this.params.set("select", cols);
    if (this.method !== "GET") this.wantRows = true;
    if (opts.count) this.countMode = opts.count;
    if (opts.head) this.headOnly = true;
    return this;
  }
  insert(rows: unknown) {
    this.method = "POST";
    this.body = rows;
    return this;
  }
  update(values: unknown) {
    this.method = "PATCH";
    this.body = values;
    return this;
  }
  upsert(rows: unknown, opts: { onConflict?: string } = {}) {
    this.method = "POST";
    this.body = rows;
    this.isUpsert = true;
    if (opts.onConflict) this.params.set("on_conflict", opts.onConflict);
    return this;
  }
  delete() {
    this.method = "DELETE";
    return this;
  }
  eq(col: string, value: unknown) {
    this.params.append(col, `eq.${value}`);
    return this;
  }
  is(col: string, value: null | boolean) {
    this.params.append(col, `is.${value === null ? "null" : value}`);
    return this;
  }
  in(col: string, values: unknown[]) {
    this.params.append(col, `in.(${values.join(",")})`);
    return this;
  }
  lt(col: string, value: unknown) {
    this.params.append(col, `lt.${value}`);
    return this;
  }
  not(col: string, op: string, value: unknown) {
    this.params.append(col, `not.${op}.${value === null ? "null" : value}`);
    return this;
  }
  or(expression: string) {
    this.params.append("or", `(${expression})`);
    return this;
  }
  order(col: string, opts: { ascending?: boolean } = {}) {
    this.params.append("order", `${col}.${opts.ascending === false ? "desc" : "asc"}`);
    return this;
  }
  limit(n: number) {
    this.params.set("limit", String(n));
    return this;
  }
  maybeSingle() {
    this.one = "maybe";
    return this;
  }
  single() {
    this.one = "single";
    return this;
  }

  private async run(): Promise<DbReply> {
    const qs = this.params.toString();
    const url = `${this.db.url}/rest/v1/${this.table}${qs ? `?${qs}` : ""}`;
    const headers: Record<string, string> = { apikey: this.db.key, Authorization: `Bearer ${this.db.key}` };
    const prefer: string[] = [];
    if (this.isUpsert) prefer.push("resolution=merge-duplicates");
    if (this.countMode) prefer.push(`count=${this.countMode}`);
    if (this.method !== "GET") prefer.push(this.wantRows ? "return=representation" : "return=minimal");
    if (prefer.length) headers.Prefer = prefer.join(",");
    if (this.body !== undefined) headers["Content-Type"] = "application/json";
    const method = this.headOnly ? "HEAD" : this.method;
    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers,
        body: this.body === undefined ? undefined : JSON.stringify(this.body)
      });
    } catch (e) {
      return { data: null, error: { message: `database unreachable: ${String(e)}` }, count: null };
    }
    const range = res.headers.get("content-range") ?? "";
    const countHeader = range.match(/\/(\d+)$/);
    const count = countHeader ? Number(countHeader[1]) : null;
    if (this.headOnly) {
      return { data: null, error: res.ok ? null : { message: res.statusText, status: res.status }, count };
    }
    const text = await res.text();
    let parsed: any = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = text || null;
    }
    if (!res.ok) {
      return {
        data: null,
        error: { message: String(parsed?.message ?? `HTTP ${res.status}`), code: parsed?.code, status: res.status },
        count: null
      };
    }
    let data = parsed;
    if (this.one !== "none" && Array.isArray(parsed)) {
      if (parsed.length === 0 && this.one === "single") {
        return { data: null, error: { message: "No rows returned", code: "PGRST116" }, count };
      }
      data = parsed[0] ?? null;
    }
    return { data, error: null, count };
  }

  then<A = DbReply, B = never>(
    onok?: ((value: DbReply) => A | PromiseLike<A>) | null,
    onerr?: ((reason: unknown) => B | PromiseLike<B>) | null
  ): Promise<A | B> {
    return this.run().then(onok, onerr);
  }
}

/** Verifies a user's access token with Supabase Auth. Returns the user id or null. */
async function userIdFromToken(token: string): Promise<string | null> {
  try {
    const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { apikey: ANON_KEY || token, Authorization: `Bearer ${token}` }
    });
    if (!res.ok) return null;
    const user = await res.json();
    return user?.id ? String(user.id) : null;
  } catch {
    return null;
  }
}

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS"
};
/** Plain date and time for messages sent to people (server clock, UTC). */
const whenPlain = (iso: string) =>
  new Date(iso).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", dateStyle: "medium", timeStyle: "short" }) + " IST";
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }
  });
const fail = (status: number, code: string, error: string, hint = "") =>
  json({ code, error, hint }, status);

/* ----------------------------------------------------------------- constants */
const EXPIRY_MS = 24 * 60 * 60 * 1000; // links live 24 h after a meeting ends
const ROOM_SAFETY_S = 48 * 60 * 60; // Daily hard stop for a room (safety valve)
const TOKEN_TTL_S = 12 * 60 * 60; // one person's token lifetime
const SCHEDULE_MIN_MS = 60 * 1000;
const SCHEDULE_MAX_MS = 366 * 24 * 60 * 60 * 1000;
const CODE_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";
const DAILY_API = "https://api.daily.co/v1";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? Deno.env.get("SUPABASE_PUBLISHABLE_KEY") ?? "";

/* ------------------------------------------------------- configuration check */
/* Validated before any Daily call. A missing or malformed value stops the
   request with a clear message; it is never sent on to Daily half-configured. */
function dailyConfig(): { apiKey: string; domain: string } | Response {
  const apiKey = (Deno.env.get("DAILY_API_KEY") ?? "").trim();
  const domain = (Deno.env.get("DAILY_DOMAIN") ?? "").trim().toLowerCase();
  if (!apiKey || apiKey.length < 20 || /\s/.test(apiKey)) {
    return fail(503, "daily_not_configured", "Video meetings are not configured yet.", "The DAILY_API_KEY secret is missing or malformed on the server.");
  }
  if (!/^[a-z0-9-]+\.daily\.co$/.test(domain)) {
    return fail(503, "daily_not_configured", "Video meetings are not configured yet.", "DAILY_DOMAIN must look like shinzora.daily.co.");
  }
  return { apiKey, domain };
}

let serviceClient: Db | null = null;
function admin(): Db {
  if (!SUPABASE_URL || !SERVICE_ROLE_KEY) throw new Error("service role is not configured");
  if (!serviceClient) serviceClient = new Db(SUPABASE_URL.replace(/\/+$/, ""), SERVICE_ROLE_KEY);
  return serviceClient;
}

/* --------------------------------------------------------------- the caller */
type Caller = { uid: string; name: string; isAdmin: boolean };

async function callerOf(req: Request): Promise<Caller | null> {
  const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
  if (!token || token === ANON_KEY) return null;
  const uid = await userIdFromToken(token);
  if (!uid) return null;
  /* Read the role table directly. The service-role client has no auth.uid(),
     so the admin check must name the user explicitly, not rely on a default. */
  const [{ data: profile }, { data: adminRow }] = await Promise.all([
    admin().from("profiles").select("full_name").eq("id", uid).maybeSingle(),
    admin().from("admin_users").select("role").eq("user_id", uid).maybeSingle()
  ]);
  const name = String(profile?.full_name ?? "").trim() || "Participant";
  const role = String(adminRow?.role ?? "");
  return { uid, name: name.slice(0, 80), isAdmin: role === "admin" || role === "superadmin" };
}

/* --------------------------------------------------------- Daily REST client */
type DailyReply = { status: number; data: any };

async function daily(apiKey: string, method: string, path: string, body?: unknown): Promise<DailyReply> {
  const res = await fetch(`${DAILY_API}${path}`, {
    method,
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await res.text();
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text.slice(0, 300) };
  }
  return { status: res.status, data };
}

/** The room URL must be on the configured Daily domain, or we refuse it. */
function roomUrlOk(url: unknown, domain: string): url is string {
  try {
    const host = new URL(String(url)).hostname.toLowerCase();
    return host === domain;
  } catch {
    return false;
  }
}

async function getRoom(cfg: { apiKey: string; domain: string }, name: string) {
  const reply = await daily(cfg.apiKey, "GET", `/rooms/${encodeURIComponent(name)}`);
  if (reply.status !== 200) return null;
  const exp = Number(reply.data?.config?.exp ?? 0);
  if (exp && exp * 1000 <= Date.now()) return null; // past its safety stop: treat as gone
  if (!roomUrlOk(reply.data?.url, cfg.domain)) return null;
  return { name, url: reply.data.url as string };
}

async function createRoom(cfg: { apiKey: string; domain: string }, name: string, kind: string) {
  const reply = await daily(cfg.apiKey, "POST", "/rooms", {
    name,
    privacy: "private",
    properties: {
      exp: Math.floor(Date.now() / 1000) + ROOM_SAFETY_S,
      eject_at_room_exp: true,
      enable_screenshare: true,
      enable_chat: false,
      /* No max_participants: Daily rejects a value above the account's plan
         cap (400 "cannot be set to that value with your current plan"), so the
         plan's own limit applies. */
      start_video_off: kind === "voice",
      start_audio_off: false
    }
  });
  if (reply.status === 200 && roomUrlOk(reply.data?.url, cfg.domain)) {
    return { name, url: reply.data.url as string };
  }
  /* A room with this name already exists: another request created it a moment
     ago. Reuse it rather than failing or making a second one. */
  const existing = await getRoom(cfg, name);
  if (existing) return existing;
  return null;
}

async function deleteRoom(cfg: { apiKey: string; domain: string }, name: string) {
  const reply = await daily(cfg.apiKey, "DELETE", `/rooms/${encodeURIComponent(name)}`);
  return reply.status === 200 || reply.status === 404;
}

async function mintToken(cfg: { apiKey: string; domain: string }, roomName: string, who: Caller, owner: boolean, kind: string) {
  const reply = await daily(cfg.apiKey, "POST", "/meeting-tokens", {
    properties: {
      room_name: roomName,
      user_id: who.uid,
      user_name: who.name,
      is_owner: owner,
      exp: Math.floor(Date.now() / 1000) + TOKEN_TTL_S,
      enable_screenshare: true,
      start_video_off: kind === "voice",
      start_audio_off: false
    }
  });
  return reply.status === 200 && typeof reply.data?.token === "string" ? (reply.data.token as string) : null;
}

/* ------------------------------------------------------------ meeting rules */
type Meeting = {
  id: string;
  code: string;
  title: string;
  kind: string;
  host_id: string;
  provider: string;
  is_locked: boolean;
  started_at: string | null;
  ended_at: string | null;
  expires_at: string | null;
  scheduled_for: string | null;
  daily_room_name: string | null;
  daily_room_url: string | null;
  session_no: number;
  created_at: string;
};

const MEETING_COLUMNS =
  "id, code, title, kind, host_id, provider, is_locked, started_at, ended_at, expires_at, scheduled_for, daily_room_name, daily_room_url, session_no, created_at";

/** The moment a meeting's link stops working, or null while it is open. */
function expiryOf(m: Meeting): number | null {
  if (!m.ended_at) return null;
  if (m.expires_at) return Date.parse(m.expires_at);
  return Date.parse(m.ended_at) + EXPIRY_MS;
}

/** A booked meeting that has not reached its time: only the host or a manager
    may start it. Guests get a clear message instead of an early room. */
function notYetOpen(m: Meeting, manager: boolean, now = Date.now()): string | null {
  if (manager || m.ended_at || m.daily_room_name || !m.scheduled_for) return null;
  const at = Date.parse(m.scheduled_for);
  return at > now ? new Date(at).toISOString() : null;
}

function statusOf(m: Meeting, now = Date.now()): "waiting" | "live" | "ended" | "expired" {
  if (m.ended_at) {
    const expiry = expiryOf(m);
    return expiry !== null && now >= expiry ? "expired" : "ended";
  }
  return m.daily_room_name ? "live" : "waiting";
}

async function meetingByCode(code: string): Promise<Meeting | null> {
  const clean = String(code ?? "").trim().toLowerCase();
  if (!/^[a-z0-9]{9}$/.test(clean)) return null;
  const { data } = await admin().from("meetings").select(MEETING_COLUMNS).eq("code", clean).maybeSingle();
  return (data as Meeting) ?? null;
}

async function managerRow(uid: string): Promise<boolean> {
  const { data } = await admin().from("meeting_managers").select("user_id").eq("user_id", uid).maybeSingle();
  return Boolean(data);
}

/** Host, manager or administrator: may run the host controls. */
async function canManage(m: Meeting, who: Caller): Promise<boolean> {
  if (m.host_id === who.uid || who.isAdmin) return true;
  return managerRow(who.uid);
}

/** Has ever been in the meeting, or hosts it: may read its chat and join it. */
async function isMember(m: Meeting, who: Caller): Promise<boolean> {
  if (m.host_id === who.uid || who.isAdmin) return true;
  const { data } = await admin()
    .from("meeting_attendees")
    .select("user_id")
    .eq("meeting_id", m.id)
    .eq("user_id", who.uid)
    .maybeSingle();
  return Boolean(data);
}

async function logEvent(meetingId: string, actorId: string | null, kind: string, detail: Record<string, unknown> = {}) {
  await admin().from("meeting_events").insert({ meeting_id: meetingId, actor_id: actorId, kind, detail });
}

async function nameOf(uid: string): Promise<string> {
  const { data } = await admin().from("profiles").select("full_name").eq("id", uid).maybeSingle();
  return String(data?.full_name ?? "").trim() || "Host";
}

function publicMeeting(m: Meeting) {
  return {
    id: m.id,
    code: m.code,
    title: m.title,
    kind: m.kind,
    provider: m.provider,
    status: statusOf(m),
    locked: m.is_locked,
    hostId: m.host_id,
    scheduledFor: m.scheduled_for,
    startedAt: m.started_at,
    endedAt: m.ended_at,
    expiresAt: expiryOf(m) === null ? null : new Date(expiryOf(m)!).toISOString(),
    createdAt: m.created_at
  };
}

/* ------------------------------------------------- sessions (rooms, tokens) */
/** Make sure the meeting has a live room and return it. A room is created at
    most once per session: the session number is bumped with a compare-and-set,
    so two people joining at the same moment end up in the same room. */
async function ensureSession(cfg: { apiKey: string; domain: string }, meeting: Meeting, actorId: string) {
  let row = meeting;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (!row.ended_at && row.daily_room_name) {
      const live = await getRoom(cfg, row.daily_room_name);
      if (live) return { room: live, meeting: row };
    }
    const nextSession = row.session_no + 1;
    const name = `shz${row.code}s${nextSession}`;
    const room = await createRoom(cfg, name, row.kind);
    if (!room) {
      throw Object.assign(new Error("room"), { response: fail(502, "daily_unavailable", "The video service did not start the room. Try again in a moment.") });
    }
    const { data, error } = await admin()
      .from("meetings")
      .update({
        daily_room_name: room.name,
        daily_room_url: room.url,
        session_no: nextSession,
        ended_at: null,
        started_at: row.started_at ?? new Date().toISOString()
      })
      .eq("id", row.id)
      .eq("session_no", row.session_no)
      .select(MEETING_COLUMNS)
      .maybeSingle();
    if (error) throw error;
    if (data) {
      await logEvent(row.id, actorId, "session_started", { session: nextSession });
      return { room, meeting: data as Meeting };
    }
    const { data: fresh } = await admin().from("meetings").select(MEETING_COLUMNS).eq("id", row.id).maybeSingle();
    if (!fresh) break;
    row = fresh as Meeting;
  }
  throw Object.assign(new Error("busy"), { response: fail(409, "session_busy", "The meeting is being set up by someone else. Try again in a moment.") });
}

/** Delete rooms whose 24-hour window has passed. Bounded per call. */
async function sweepExpiredRooms(cfg: { apiKey: string; domain: string }, limit = 25) {
  const { data } = await admin()
    .from("meetings")
    .select("id, daily_room_name")
    .not("daily_room_name", "is", null)
    .not("ended_at", "is", null)
    .lt("expires_at", new Date().toISOString())
    .limit(limit);
  let cleaned = 0;
  for (const row of data ?? []) {
    const gone = await deleteRoom(cfg, row.daily_room_name);
    if (!gone) continue;
    await admin().from("meetings").update({ daily_room_name: null, daily_room_url: null }).eq("id", row.id);
    await logEvent(row.id, null, "room_cleaned", { room: row.daily_room_name });
    cleaned++;
  }
  return cleaned;
}

/* -------------------------------------------------------------- the actions */
type Body = Record<string, any>;
type Handler = (who: Caller, body: Body, cfg: { apiKey: string; domain: string }) => Promise<Response>;

const handlers: Record<string, Handler> = {
  /* Start a meeting. "instant" also opens its room and returns the join. */
  async create(who, body, cfg) {
    const title = String(body.title ?? "").trim().slice(0, 120) || "Meeting";
    const kind = body.kind === "voice" ? "voice" : "video";
    const requestId = String(body.requestId ?? "");
    if (!/^[0-9a-f-]{36}$/i.test(requestId)) {
      return fail(400, "invalid_input", "This request is missing its identity. Reload the page and try again.");
    }
    let scheduledFor: string | null = null;
    if (body.scheduledFor) {
      const at = Date.parse(String(body.scheduledFor));
      const delta = at - Date.now();
      if (Number.isNaN(at) || delta < SCHEDULE_MIN_MS) {
        return fail(400, "invalid_input", "Choose a time at least a minute from now.");
      }
      if (delta > SCHEDULE_MAX_MS) return fail(400, "invalid_input", "Choose a time within the next year.");
      scheduledFor = new Date(at).toISOString();
    }

    /* Same request twice: the same meeting comes back. */
    const { data: existing } = await admin()
      .from("meetings")
      .select(MEETING_COLUMNS)
      .eq("host_id", who.uid)
      .eq("create_request_id", requestId)
      .maybeSingle();
    let meeting = existing as Meeting | null;

    if (!meeting) {
      let inserted: Meeting | null = null;
      for (let attempt = 0; attempt < 5 && !inserted; attempt++) {
        const code = Array.from(crypto.getRandomValues(new Uint8Array(9)), (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join("");
        const { data, error } = await admin()
          .from("meetings")
          .insert({
            code,
            title,
            kind,
            host_id: who.uid,
            provider: "daily",
            scheduled_for: scheduledFor,
            create_request_id: requestId
          })
          .select(MEETING_COLUMNS)
          .single();
        if (data) inserted = data as Meeting;
        else if (error?.code === "23505" && String(error.message).includes("create_request")) {
          const { data: again } = await admin()
            .from("meetings")
            .select(MEETING_COLUMNS)
            .eq("host_id", who.uid)
            .eq("create_request_id", requestId)
            .maybeSingle();
          if (again) return json({ ok: true, meeting: publicMeeting(again as Meeting) });
        } else if (error?.code !== "23505") {
          throw error;
        }
      }
      if (!inserted) return fail(503, "busy", "Could not create the meeting. Try again.");
      meeting = inserted;
      await logEvent(meeting.id, who.uid, "created", { kind, scheduled: Boolean(scheduledFor) });
    }

    if (body.instant && statusOf(meeting) === "waiting") {
      return joinMeeting(who, meeting, cfg, { created: true });
    }
    await sweepExpiredRooms(cfg);
    return json({ ok: true, meeting: publicMeeting(meeting) });
  },

  /* What a link shows before anyone presses Join. Never mints a token. */
  async open(who, body, cfg) {
    const meeting = await meetingByCode(body.code);
    if (!meeting) return fail(404, "not_found", "No meeting has that code.", "Codes are nine characters. Ask the host to send the link again.");
    if (meeting.provider !== "daily") return json({ ok: true, provider: "mesh" });

    const status = statusOf(meeting);
    const manager = await canManage(meeting, who);
    const expiry = expiryOf(meeting);
    let canJoin = true;
    let reason = "";
    if (status === "expired") {
      canJoin = false;
      reason = "This meeting ended more than 24 hours ago, so its link has expired. Ask the host for a new meeting.";
    } else if (meeting.is_locked && !manager) {
      canJoin = false;
      reason = "The host has locked this meeting. Ask them to unlock it, then open the link again.";
    } else if (notYetOpen(meeting, manager)) {
      canJoin = false;
      reason = `This meeting is booked for ${whenPlain(notYetOpen(meeting, manager)!)}. The link opens then.`;
    }

    let liveCount = 0;
    if (status === "live" && meeting.daily_room_name) {
      const presence = await daily(cfg.apiKey, "GET", `/rooms/${encodeURIComponent(meeting.daily_room_name)}/presence`);
      if (presence.status === 200 && Array.isArray(presence.data?.data)) liveCount = presence.data.data.length;
    }
    const hostName = await nameOf(meeting.host_id);
    return json({
      ok: true,
      provider: "daily",
      meeting: publicMeeting(meeting),
      hostName,
      youAreHost: meeting.host_id === who.uid,
      canManage: manager,
      canJoin,
      reason,
      expiresAt: expiry === null ? null : new Date(expiry).toISOString(),
      liveCount,
      /* "Return to call": only when the link is still valid after the end. */
      canReturn: status === "ended" && canJoin
    });
  },

  async join(who, body, cfg) {
    const meeting = await meetingByCode(body.code);
    if (!meeting) return fail(404, "not_found", "No meeting has that code.");
    if (meeting.provider !== "daily") return fail(409, "not_daily", "This meeting uses the older call screen. Open it from the meetings page.");
    const status = statusOf(meeting);
    const manager = await canManage(meeting, who);
    if (status === "expired") {
      await logEvent(meeting.id, who.uid, "refused", { reason: "expired" });
      return fail(410, "meeting_expired", "This meeting ended more than 24 hours ago, so its link has expired.", "Ask the host for a new meeting link.");
    }
    if (meeting.is_locked && !manager) {
      await logEvent(meeting.id, who.uid, "refused", { reason: "locked" });
      return fail(423, "meeting_locked", "The host has locked this meeting.", "Ask them to unlock it, then open the link again.");
    }
    const early = notYetOpen(meeting, manager);
    if (early) {
      return fail(423, "meeting_not_started", `This meeting is booked for ${whenPlain(early)}. The link opens then.`);
    }
    return joinMeeting(who, meeting, cfg, {});
  },

  /* Leave: closes this person's attendance. The room itself stays open. */
  async leave(who, body) {
    const meeting = await meetingByCode(body.code);
    if (!meeting) return json({ ok: true });
    await admin()
      .from("meeting_attendees")
      .update({ left_at: new Date().toISOString() })
      .eq("meeting_id", meeting.id)
      .eq("user_id", who.uid)
      .is("left_at", null);
    await logEvent(meeting.id, who.uid, "left", {});
    return json({ ok: true });
  },

  /* End for everyone. Host, manager or administrator. Removes everyone at
     once, and the link stays valid for 24 hours. */
  async end(who, body, cfg) {
    const meeting = await meetingByCode(body.code);
    if (!meeting) return fail(404, "not_found", "No meeting has that code.");
    if (!(await canManage(meeting, who))) return fail(403, "forbidden", "Only the host can end this meeting.");
    if (statusOf(meeting) !== "live") return fail(409, "not_live", "This meeting is not running, so there is nothing to end.");
    if (meeting.daily_room_name) {
      const gone = await deleteRoom(cfg, meeting.daily_room_name);
      if (!gone) return fail(502, "daily_unavailable", "The video service did not close the room. Try again.");
    }
    const endedAt = new Date().toISOString();
    const { data, error } = await admin()
      .from("meetings")
      .update({ ended_at: endedAt })
      .eq("id", meeting.id)
      .is("ended_at", null)
      .select(MEETING_COLUMNS)
      .maybeSingle();
    if (error) throw error;
    await admin().from("meeting_attendees").update({ left_at: endedAt }).eq("meeting_id", meeting.id).is("left_at", null);
    await logEvent(meeting.id, who.uid, "ended", {});
    return json({ ok: true, meeting: publicMeeting((data as Meeting) ?? { ...meeting, ended_at: endedAt }) });
  },

  async lock(who, body) {
    const meeting = await meetingByCode(body.code);
    if (!meeting) return fail(404, "not_found", "No meeting has that code.");
    if (!(await canManage(meeting, who))) return fail(403, "forbidden", "Only the host can lock this meeting.");
    const locked = body.locked === true;
    await admin().from("meetings").update({ is_locked: locked }).eq("id", meeting.id);
    await logEvent(meeting.id, who.uid, locked ? "locked" : "unlocked", {});
    return json({ ok: true, locked });
  },

  /* Remove one person from the live room. Optionally bar them from rejoining. */
  async remove(who, body, cfg) {
    const meeting = await meetingByCode(body.code);
    if (!meeting) return fail(404, "not_found", "No meeting has that code.");
    if (!(await canManage(meeting, who))) return fail(403, "forbidden", "Only the host can remove people.");
    if (statusOf(meeting) !== "live" || !meeting.daily_room_name) return fail(409, "not_live", "This meeting is not running.");
    const target = String(body.userId ?? "");
    if (!/^[0-9a-f-]{36}$/i.test(target)) return fail(400, "invalid_input", "Choose a person to remove.");
    if (target === meeting.host_id) return fail(400, "invalid_input", "The host cannot be removed.");
    const ban = body.ban === true;
    const reply = await daily(cfg.apiKey, "POST", `/rooms/${encodeURIComponent(meeting.daily_room_name)}/eject`, {
      user_ids: [target],
      ban
    });
    if (reply.status !== 200) return fail(502, "daily_unavailable", "The person could not be removed. Try again.");
    await admin().from("meeting_attendees").update({ left_at: new Date().toISOString() }).eq("meeting_id", meeting.id).eq("user_id", target).is("left_at", null);
    await logEvent(meeting.id, who.uid, "removed", { target, ban });
    return json({ ok: true, ejected: reply.data?.ejectedIds ?? [] });
  },

  /* Who is in the live room right now, from Daily's own presence list. */
  async presence(who, body, cfg) {
    const meeting = await meetingByCode(body.code);
    if (!meeting) return fail(404, "not_found", "No meeting has that code.");
    if (!(await canManage(meeting, who))) return fail(403, "forbidden", "Only the host can see the participant list.");
    if (statusOf(meeting) !== "live" || !meeting.daily_room_name) return json({ ok: true, participants: [] });
    const reply = await daily(cfg.apiKey, "GET", `/rooms/${encodeURIComponent(meeting.daily_room_name)}/presence`);
    if (reply.status !== 200) return fail(502, "daily_unavailable", "The participant list is not available right now.");
    const participants = (Array.isArray(reply.data?.data) ? reply.data.data : []).map((row: any) => ({
      userId: String(row.userId ?? ""),
      userName: String(row.userName ?? "Participant").slice(0, 80),
      joinTime: row.joinTime ?? null,
      duration: Number(row.duration) || 0
    }));
    return json({ ok: true, participants });
  },

  async chat_list(who, body) {
    const meeting = await meetingByCode(body.code);
    if (!meeting) return fail(404, "not_found", "No meeting has that code.");
    if (!(await isMember(meeting, who))) return fail(403, "forbidden", "Join the meeting to see its chat.");
    const { data } = await admin()
      .from("meeting_chat_messages")
      .select("id, author_id, author_name, body, session_no, created_at")
      .eq("meeting_id", meeting.id)
      .order("created_at", { ascending: true })
      .limit(200);
    return json({ ok: true, messages: data ?? [] });
  },

  async chat_send(who, body) {
    const meeting = await meetingByCode(body.code);
    if (!meeting) return fail(404, "not_found", "No meeting has that code.");
    if (!(await isMember(meeting, who))) return fail(403, "forbidden", "Join the meeting to send a message.");
    if (statusOf(meeting) !== "live") return fail(409, "not_live", "Chat is open while the meeting is running.");
    const text = String(body.body ?? "").trim();
    if (!text) return fail(400, "invalid_input", "Type a message first.");
    if (text.length > 2000) return fail(400, "invalid_input", "Keep messages under 2000 characters.");
    const { data, error } = await admin()
      .from("meeting_chat_messages")
      .insert({ meeting_id: meeting.id, session_no: meeting.session_no, author_id: who.uid, author_name: who.name, body: text })
      .select("id, author_id, author_name, body, session_no, created_at")
      .single();
    if (error) throw error;
    return json({ ok: true, message: data });
  },

  /* Screen share start and stop, recorded for the activity log. */
  async activity(who, body) {
    const meeting = await meetingByCode(body.code);
    if (!meeting) return fail(404, "not_found", "No meeting has that code.");
    if (!(await isMember(meeting, who))) return fail(403, "forbidden", "Join the meeting first.");
    const kind = body.kind === "screen_share_stopped" ? "screen_share_stopped" : "screen_share_started";
    await logEvent(meeting.id, who.uid, kind, {});
    return json({ ok: true });
  },

  async activity_list(who, body) {
    const meeting = await meetingByCode(body.code);
    if (!meeting) return fail(404, "not_found", "No meeting has that code.");
    if (!(await canManage(meeting, who))) return fail(403, "forbidden", "Only the host can see activity.");
    const { data } = await admin()
      .from("meeting_events")
      .select("kind, actor_id, detail, created_at")
      .eq("meeting_id", meeting.id)
      .order("created_at", { ascending: false })
      .limit(100);
    return json({ ok: true, events: data ?? [] });
  },

  /* Meetings this person hosts or has joined. Status is computed here. */
  async history(who) {
    const { data: attended } = await admin().from("meeting_attendees").select("meeting_id").eq("user_id", who.uid).limit(200);
    const ids = (attended ?? []).map((row: any) => row.meeting_id);
    let query = admin().from("meetings").select(MEETING_COLUMNS).order("created_at", { ascending: false }).limit(50);
    query = ids.length ? query.or(`host_id.eq.${who.uid},id.in.(${ids.join(",")})`) : query.eq("host_id", who.uid);
    const { data, error } = await query;
    if (error) throw error;
    return json({
      ok: true,
      meetings: (data ?? []).map((m: any) => ({ ...publicMeeting(m as Meeting), youAreHost: m.host_id === who.uid }))
    });
  },

  /* Administrator: every Daily meeting, the managers, and recent activity. */
  async admin_overview(who) {
    if (!who.isAdmin) return fail(403, "forbidden", "Administrators only.");
    const { data: rows } = await admin()
      .from("meetings")
      .select(MEETING_COLUMNS)
      .eq("provider", "daily")
      .order("created_at", { ascending: false })
      .limit(100);
    const meetings = await Promise.all(
      (rows ?? []).map(async (m: any) => {
        const { count } = await admin()
          .from("meeting_attendees")
          .select("user_id", { count: "exact", head: true })
          .eq("meeting_id", m.id)
          .is("left_at", null);
        return { ...publicMeeting(m as Meeting), hostName: await nameOf(m.host_id), attendeesNow: count ?? 0 };
      })
    );
    const { data: managers } = await admin().from("meeting_managers").select("user_id, granted_at").limit(200);
    const managerList = await Promise.all(
      (managers ?? []).map(async (row: any) => ({ userId: row.user_id, name: await nameOf(row.user_id), grantedAt: row.granted_at }))
    );
    const { data: events } = await admin()
      .from("meeting_events")
      .select("meeting_id, kind, actor_id, created_at")
      .order("created_at", { ascending: false })
      .limit(40);
    return json({ ok: true, meetings, managers: managerList, events: events ?? [] });
  },

  async admin_manager(who, body) {
    if (!who.isAdmin) return fail(403, "forbidden", "Administrators only.");
    const target = String(body.userId ?? "");
    if (!/^[0-9a-f-]{36}$/i.test(target)) return fail(400, "invalid_input", "Choose a person.");
    if (body.grant === true) {
      const { error } = await admin().from("meeting_managers").upsert({ user_id: target, granted_by: who.uid });
      if (error) throw error;
    } else {
      await admin().from("meeting_managers").delete().eq("user_id", target);
    }
    return json({ ok: true, granted: body.grant === true });
  },

  async cleanup(who, _body, cfg) {
    if (!who.isAdmin) return fail(403, "forbidden", "Administrators only.");
    return json({ ok: true, cleaned: await sweepExpiredRooms(cfg, 100) });
  }
};

/** Mint this person's token for the meeting's current room, opening a new
    session first if the meeting is waiting or has ended within its window. */
async function joinMeeting(who: Caller, meeting: Meeting, cfg: { apiKey: string; domain: string }, opts: { created?: boolean }) {
  const reopening = Boolean(meeting.ended_at);
  const manager = await canManage(meeting, who);
  const session = await ensureSession(cfg, meeting, who.uid);
  const token = await mintToken(cfg, session.room.name, who, manager || meeting.host_id === who.uid, meeting.kind);
  if (!token) return fail(502, "daily_unavailable", "The video service did not issue your place in the room. Try again.");

  await admin()
    .from("meeting_attendees")
    .upsert(
      {
        meeting_id: meeting.id,
        user_id: who.uid,
        role: meeting.host_id === who.uid ? "host" : "guest",
        left_at: null
      },
      { onConflict: "meeting_id,user_id" }
    );
  await logEvent(meeting.id, who.uid, "joined", { reopened: reopening, created: Boolean(opts.created) });

  const fresh = session.meeting;
  return json({
    ok: true,
    provider: "daily",
    url: session.room.url,
    token,
    meeting: publicMeeting(fresh),
    youAreHost: fresh.host_id === who.uid,
    canManage: manager,
    reopened: reopening,
    user: { id: who.uid, name: who.name }
  });
}

/* ------------------------------------------------------------------ entry */
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST") return fail(405, "method_not_allowed", "Use POST.");

  const cfg = dailyConfig();
  if (cfg instanceof Response) return cfg;

  let body: Body;
  try {
    body = await req.json();
  } catch {
    return fail(400, "invalid_input", "The request body is not valid JSON.");
  }
  const action = String(body?.action ?? "");
  const handler = Object.prototype.hasOwnProperty.call(handlers, action) ? handlers[action] : null;
  if (!handler) return fail(400, "unknown_action", "That action is not available.");

  const who = await callerOf(req);
  if (!who) return fail(401, "not_authenticated", "Sign in to continue.");

  try {
    return await handler(who, body, cfg);
  } catch (error: any) {
    if (error?.response) return error.response as Response;
    console.error("daily:", action, String(error?.message ?? error).slice(0, 300));
    return fail(500, "server_error", "Something went wrong on our side. Try again.");
  }
});
