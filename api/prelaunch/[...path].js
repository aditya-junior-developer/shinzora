/* ==========================================================================
   Vercel serverless entry point — /api/prelaunch/*
   --------------------------------------------------------------------------
   The same router the local dev server uses, so a hosted deployment can sign in
   the two pre-launch accounts with identical behaviour:

     /api/prelaunch/auth/login | logout | session
     /api/prelaunch/identity
     /api/prelaunch/rest/v1/<table>       (and /rest/v1/rpc/<fn>)
     /api/prelaunch/storage/v1/...
     /api/prelaunch/fn/<name>
     /api/prelaunch/monitor | monitor/read | events | reset
     /api/prelaunch/health

   Required environment variables (Project → Settings → Environment Variables):
     PRELAUNCH_USER_EMAIL, PRELAUNCH_USER_PASSWORD_HASH
     PRELAUNCH_ADMIN_EMAIL, PRELAUNCH_ADMIN_PASSWORD_HASH
     PRELAUNCH_SESSION_SECRET   (32+ characters)
     SHINZORA_AI_API_KEY        (optional — enables the real AI actions)

   Do not type the passwords here. Generate the digests locally with
   `node scripts/prelaunch-credentials.mjs --show` after provisioning, and paste
   the PRELAUNCH_* lines it prints into the Vercel dashboard. Vercel's filesystem
   is read-only apart from /tmp, so the sandbox store is pointed at /tmp: the
   accounts keep working across deployments, while sandbox rows reseed whenever a
   new function instance starts. Point PRELAUNCH_DATA_DIR at a writable, mounted
   path (or run the Node server) if you need the seeded rows to persist.
   ========================================================================== */

import path from "node:path";
import os from "node:os";
import { handlePrelaunchRequest, bootMonitor } from "../../server/prelaunch/router.mjs";

const PREFIX = "/api/prelaunch";
const ROOT = process.cwd();

/* Vercel only allows writes under /tmp. */
if (!process.env.PRELAUNCH_DATA_DIR) {
  process.env.PRELAUNCH_DATA_DIR = path.join(os.tmpdir(), "shinzora-prelaunch");
}

let booted = false;

export default async function handler(req, res) {
  const url = new URL(req.url, `https://${req.headers.host || "localhost"}`);
  if (!url.pathname.startsWith(PREFIX)) {
    /* The rewrite should always arrive with the prefix present; if a proxy strips
       it, put it back so the router can match. */
    url.pathname = `${PREFIX}${url.pathname}`;
  }

  if (!booted) {
    booted = true;
    try {
      bootMonitor(ROOT);
    } catch (error) {
      console.warn("[prelaunch] monitor boot failed:", error?.message);
    }
  }

  /* Node's IncomingMessage is a stream here, which is exactly what the router
     expects — no adapter layer needed. */
  const handled = await handlePrelaunchRequest(req, res, { root: ROOT, url });
  if (!handled) {
    res.statusCode = 404;
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.end(JSON.stringify({ error: "Unknown pre-launch route.", code: "not_found" }));
  }
}

export const config = {
  api: {
    /* Storage uploads are binary; the router reads the raw stream itself. */
    bodyParser: false
  }
};
