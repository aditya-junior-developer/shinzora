/* ==========================================================================
   Shinzora — local smoke test for every Edge Function
   --------------------------------------------------------------------------
   Deploying a function that boots but answers wrongly is worse than not
   deploying it. This runs each function on Deno, exactly as Supabase will, and
   asserts the contract that matters before deployment:

     config    public, unauthenticated → 200 with provider flags and no secrets
     site      public read → 200 or a clean 4xx (never a stack trace)
     ai        requires a session → 401 without one
     admin     requires a session → 401 without one
     payments  requires a session → 401 without one
     domains   requires a session → 401 without one
     integrations requires a session → 401 without one
     payments-webhook rejects a request with no provider signature

   Every response is also checked for a leaked secret value.

   Requires the Deno binary: DENO=/path/to/deno node scripts/smoke-functions.mjs
     (or `deno` on PATH)
   ========================================================================== */

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FUNCTIONS = path.join(ROOT, "supabase", "functions");
const DENO = process.env.DENO || "deno";
const PORT = 8000;

const EXPECTATIONS = {
  config: { auth: false, allow: [200] },
  site: { auth: false, allow: [200, 400, 404] },
  ai: { auth: true },
  admin: { auth: true },
  payments: { auth: true },
  domains: { auth: true },
  integrations: { auth: true },
  /* verify_jwt is off (the caller is a database trigger), so the shared secret
     in x-push-key is what authenticates it. No key ⇒ 401. */
  push: { auth: true },
  // A webhook is authenticated by an HMAC signature, not a session. With no
  // secret configured the honest answer is 503 "unconfigured", never 200.
  "payments-webhook": { auth: false, allow: [503] }
};

// Values, not names: `config` deliberately reports *which* secret name it reads
// (`key_env: "SHINZORA_AI_API_KEY"`), which is diagnostics, not a leak.
const SENTINEL_KEY = "sentinel-gemini-key-do-not-leak-0123456789";
const SENTINEL_SERVICE = "sentinel-service-role-do-not-leak";
const SECRET_MARKERS = [SENTINEL_KEY, SENTINEL_SERVICE, "sk_live_", "-----BEGIN"];

let failures = 0;
const ok = (name, pass, note = "") => {
  console.log(`  ${pass ? "✓" : "✗"} ${name}${note ? " — " + note : ""}`);
  if (!pass) failures++;
};

function waitForServer(child, logPath, timeoutMs = 20000) {
  return new Promise((resolve) => {
    const started = Date.now();
    const timer = setInterval(() => {
      const log = fs.existsSync(logPath) ? fs.readFileSync(logPath, "utf8") : "";
      if (/Listening on/.test(log)) {
        clearInterval(timer);
        resolve(true);
      } else if (Date.now() - started > timeoutMs) {
        clearInterval(timer);
        resolve(false);
      }
    }, 200);
    child.on("exit", () => clearInterval(timer));
  });
}

/* -------------------------------------------------------------------------- */
/* Remote mode                                                                */
/* -------------------------------------------------------------------------- */
/* `--remote` checks the *deployed* functions instead of local Deno. Same
   contract, different question: does the project actually answer the way the
   local run promised? It needs no Deno and no service-role key — only the
   public project URL and the publishable anon key, exactly what a browser has.
   This is the check that proves a deploy landed rather than assuming it did.  */

const REMOTE = process.argv.includes("--remote");

if (REMOTE) {
  const envFile = path.join(ROOT, ".env");
  const fileEnv = {};
  if (fs.existsSync(envFile)) {
    for (const line of fs.readFileSync(envFile, "utf8").split("\n")) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
      if (m && !line.trim().startsWith("#")) fileEnv[m[1]] = m[2].replace(/^['"]|['"]$/g, "");
    }
  }
  const read = (k) => process.env[k] || fileEnv[k] || "";
  const projectUrl =
    read("SUPABASE_URL") || read("SHINZORA_SUPABASE_URL") || read("VITE_SUPABASE_URL");
  const anonKey =
    read("SUPABASE_PUBLISHABLE_KEY") ||
    read("VITE_SUPABASE_ANON_KEY") ||
    read("VITE_SUPABASE_PUBLISHABLE_KEY") ||
    read("SHINZORA_SUPABASE_PUBLISHABLE_KEY");

  if (!projectUrl || !anonKey) {
    console.error("\n  ✗ --remote needs SUPABASE_URL and the publishable key (env or .env)\n");
    process.exit(1);
  }

  const deployedNames = fs
    .readdirSync(FUNCTIONS, { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name !== "_shared" && fs.existsSync(path.join(FUNCTIONS, e.name, "index.ts")))
    .map((e) => e.name)
    .sort();

  console.log(`\n  Checking ${deployedNames.length} deployed functions at ${projectUrl}\n`);

  for (const name of deployedNames) {
    const url = `${projectUrl}/functions/v1/${name}`;
    const expectation = EXPECTATIONS[name] || { auth: true };
    let response;
    let text = "";
    try {
      /* No token at all: a protected function must refuse, a public one must answer. */
      response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", apikey: anonKey },
        body: JSON.stringify({ action: "noop" }),
        signal: AbortSignal.timeout(20000)
      });
      text = await response.text();
    } catch (error) {
      ok(`${name} reachable`, false, error.message);
      continue;
    }

    const status = response.status;

    if (status === 404) {
      ok(`${name} is deployed`, false, "HTTP 404 — not deployed or wrong project");
      continue;
    }

    if (expectation.auth) {
      ok(`${name} refuses an unauthenticated call`, status === 401 || status === 403, `HTTP ${status}`);
    } else if (name === "payments-webhook") {
      const unconfigured = status === 503 || status === 401;
      ok(
        "payments-webhook rejects an unsigned callback",
        unconfigured,
        `HTTP ${status}`
      );
    } else {
      const allowed = (expectation.allow || [200]).includes(status);
      ok(`${name} answers a public call`, allowed, `HTTP ${status}`);
    }

    const leaks = SECRET_MARKERS.filter((marker) => text.includes(marker));
    ok(`${name} leaks no secret`, leaks.length === 0, leaks.join(", "));

    const stack = /at .*\.ts:\d+|postgres:\/\//.test(text);
    ok(`${name} hides stack traces`, !stack, stack ? text.slice(0, 80) : "");

    if (name === "config" && status === 200) {
      let json = null;
      try {
        json = JSON.parse(text);
      } catch {
        /* reported below */
      }
      const flat = JSON.stringify(json || {});
      /* The shape the dashboard actually reads: ai.configured, the payment and
         domain flags, and the subdomain root. Asserting the real fields catches
         a renamed key, which a loose regex on "ai.*true|false" did not. */
      const flags = json || {};
      const shapeOk =
        typeof flags.available === "boolean" &&
        typeof flags.ai?.configured === "boolean" &&
        typeof flags.payments?.upi_configured === "boolean" &&
        typeof flags.domains?.configured === "boolean" &&
        typeof flags.integrations?.github_configured === "boolean" &&
        typeof flags.email?.provider === "string";
      ok("config reports provider flags", shapeOk, JSON.stringify(json).slice(0, 160));
      /* A configured AI must name the model; an unconfigured one must name the
         secret to set — never both, never a key. */
      ok(
        "config describes AI honestly",
        flags.ai?.configured ? typeof flags.ai.model === "string" : flags.ai?.key_env === "SHINZORA_AI_API_KEY",
        JSON.stringify(flags.ai)
      );
      /* The AI key itself must never appear; only its *name* may. */
      ok(
        "config does not leak the AI key value",
        !/AIza[0-9A-Za-z_-]{20,}/.test(flat),
        ""
      );
    }
  }

  console.log(
    failures
      ? `\n  ${failures} problem${failures === 1 ? "" : "s"}\n`
      : "\n  Deployed functions match the local contract\n"
  );
  process.exit(failures ? 1 : 0);
}

const names = fs
  .readdirSync(FUNCTIONS, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && entry.name !== "_shared" && fs.existsSync(path.join(FUNCTIONS, entry.name, "index.ts")))
  .map((entry) => entry.name)
  .sort();

console.log(`\nSmoke-testing ${names.length} Edge Functions on ${DENO}\n`);

for (const name of names) {
  const logPath = `/tmp/shinzora-fn-${name}.log`;
  const log = fs.createWriteStream(logPath);
  const child = spawn(DENO, ["run", "--allow-all", path.join(FUNCTIONS, name, "index.ts")], {
    env: {
      ...process.env,
      SUPABASE_URL: "https://example-project.supabase.co",
      SUPABASE_ANON_KEY: "stub-anon-key",
      SUPABASE_SERVICE_ROLE_KEY: SENTINEL_SERVICE,
      SHINZORA_AI_API_KEY: SENTINEL_KEY,
      SUPABASE_DB_URL: "",
      SUPABASE_WEBHOOK_SECRET: "",
      NO_COLOR: "1"
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  child.stdout.pipe(log);
  child.stderr.pipe(log);

  const started = await waitForServer(child, logPath);
  if (!started) {
    ok(`${name} boots`, false, "no 'Listening on' within 20s");
    child.kill("SIGKILL");
    continue;
  }

  const expectation = EXPECTATIONS[name] || { auth: true };
  const body = JSON.stringify({ action: "noop" });

  let response;
  let text = "";
  try {
    response = await fetch(`http://127.0.0.1:${PORT}/`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body
    });
    text = await response.text();
  } catch (error) {
    ok(`${name} responds`, false, error.message);
    child.kill("SIGKILL");
    continue;
  }

  const status = response.status;

  if (expectation.auth) {
    const refused = status === 401 || status === 403;
    ok(`${name} refuses an unauthenticated call`, refused, `HTTP ${status}`);
  } else if (name === "payments-webhook") {
    const unconfigured = status === 503 && /unconfigured|not set/i.test(text);
    ok("payments-webhook reports an unconfigured secret instead of accepting", unconfigured, `HTTP ${status}`);
  } else {
    const allowed = (expectation.allow || [200]).includes(status);
    ok(`${name} answers a public call`, allowed, `HTTP ${status}`);
  }

  const leaks = SECRET_MARKERS.filter((marker) => text.includes(marker));
  ok(`${name} response leaks no secret`, leaks.length === 0, leaks.join(", "));

  const stackLeak = /at .*\.ts:\d+|SupabaseClient|postgres:\/\//.test(text);
  ok(`${name} response has no stack trace`, !stackLeak, stackLeak ? text.slice(0, 80) : "");

  child.kill("SIGKILL");
  await new Promise((resolve) => setTimeout(resolve, 350));
}

console.log(failures ? `\n${failures} problem${failures === 1 ? "" : "s"}\n` : "\nEvery Edge Function boots and enforces its contract\n");
process.exit(failures ? 1 : 0);
