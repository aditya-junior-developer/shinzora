// ============================================================================
// Shinzora · Edge Function `turn-credentials`
// ----------------------------------------------------------------------------
// A call between two networks that cannot reach each other needs a TURN relay.
// This deployment had STUN only, which is why a room could open and never carry
// a frame.
//
//   POST /functions/v1/turn-credentials      (a signed-in member, no body)
//   → 200 { relay: "cloudflare", ttl: 3600, iceServers: [{ urls, username, credential }] }
//   → 200 { relay: "none", reason: "not_configured", iceServers: [] }
//
// The TURN secret never reaches the browser. Cloudflare's Realtime TURN wants a
// key id + API token, which are server secrets; this function trades them for a
// short-lived username/credential pair and hands back only that.
//
// Any signed-in member may ask: the credentials are scoped to WebRTC relay use
// and expire. There is nothing per-user to leak, and refusing would just mean a
// call that cannot connect.
//
// Honesty contract: when the secrets are absent this answers `relay: "none"`
// and the client says so instead of spinning. It never invents a relay.
// ============================================================================

import { json, fail, preflight } from "../_shared/http.ts";

const KEY_ID = Deno.env.get("CLOUDFLARE_TURN_KEY_ID") ?? "";
const API_TOKEN = Deno.env.get("CLOUDFLARE_TURN_API_TOKEN") ?? "";
const TTL_SECONDS = Number(Deno.env.get("CLOUDFLARE_TURN_TTL") ?? "3600");

/** Cloudflare Realtime TURN: one call to mint a short-lived credential. */
async function mintCloudflare() {
  const response = await fetch(
    `https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(KEY_ID)}/credentials/generate`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${API_TOKEN}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({ ttl: Number.isFinite(TTL_SECONDS) ? TTL_SECONDS : 3600 })
    }
  );

  const body = await response.json().catch(() => null);
  if (!response.ok) {
    const detail = body?.errors?.[0]?.message || body?.error || `Cloudflare answered ${response.status}`;
    return { ok: false, detail };
  }

  /* Cloudflare returns { iceServers: { urls: [...], username, credential } }. */
  const ice = body?.iceServers ?? body?.result?.iceServers;
  if (!ice) return { ok: false, detail: "Cloudflare returned no iceServers" };

  const entries = Array.isArray(ice) ? ice : [ice];
  return {
    ok: true,
    iceServers: entries.map((entry) => ({
      urls: entry.urls,
      username: entry.username,
      credential: entry.credential
    }))
  };
}

Deno.serve(async (req) => {
  const options = preflight(req);
  if (options) return options;
  if (req.method !== "POST" && req.method !== "GET") return fail(405, "method_not_allowed", "Use POST.");

  if (!KEY_ID || !API_TOKEN) {
    /* Not an error: the app is simply not configured for relayed calls yet, and
       the client shows that sentence rather than a call that never connects. */
    return json({ relay: "none", reason: "not_configured", iceServers: [] });
  }

  try {
    const minted = await mintCloudflare();
    if (!minted.ok) {
      return json({ relay: "none", reason: "mint_failed", detail: minted.detail, iceServers: [] }, 502);
    }
    return json({ relay: "cloudflare", ttl: TTL_SECONDS, iceServers: minted.iceServers });
  } catch (error) {
    return json({ relay: "none", reason: "unreachable", detail: String(error?.message || error), iceServers: [] }, 502);
  }
});
