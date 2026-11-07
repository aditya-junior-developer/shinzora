#!/usr/bin/env node
/* ==========================================================================
   Shinzora — deploy the Edge Functions to the live Supabase project
   --------------------------------------------------------------------------
   The eight functions in `supabase/functions/` are the only server-side code in
   Shinzora. They must be deployed before the dashboard's AI, domain, payment,
   admin and integration features can answer; until then the frontend shows the
   honest "not configured yet" state instead of pretending to work.

   Supabase used to need Docker to bundle a function locally. The CLI now has
   `--use-api`, which bundles on Supabase's side — this script uses that, so it
   runs on any machine with Node 20+ and an access token, no Docker required.

   Requirements
     SUPABASE_ACCESS_TOKEN   personal access token (https://supabase.com/dashboard/account/tokens)
     SUPABASE_PROJECT_REF    optional — inferred from SUPABASE_URL in .env

   Usage
     node scripts/deploy-functions.mjs                 # every function
     node scripts/deploy-functions.mjs ai admin        # just these
     node scripts/deploy-functions.mjs --dry-run       # print the plan only

   `verify_jwt` is read from supabase/config.toml, so `config`, `site` and
   `payments-webhook` are deployed with --no-verify-jwt and everything else
   keeps JWT verification on. Deploying a protected function without it would
   be a security regression, so the flags are never guessed.
   ========================================================================== */

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FUNCTIONS_DIR = path.join(ROOT, "supabase", "functions");
const CONFIG_TOML = path.join(ROOT, "supabase", "config.toml");
const CLI = "supabase@latest";

/* -------------------------------------------------------------------------- */
/* Environment                                                                */
/* -------------------------------------------------------------------------- */

const fileEnv = (() => {
  const out = {};
  const file = path.join(ROOT, ".env");
  if (!fs.existsSync(file)) return out;
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
    if (!m || line.trim().startsWith("#")) continue;
    out[m[1]] = m[2].replace(/^['"]|['"]$/g, "");
  }
  return out;
})();

const get = (key) => process.env[key] || fileEnv[key] || "";

const token = get("SUPABASE_ACCESS_TOKEN");
const siteUrl = get("SUPABASE_URL") || get("SHINZORA_SUPABASE_URL") || get("VITE_SUPABASE_URL");
const ref = get("SUPABASE_PROJECT_REF") || (siteUrl.match(/https:\/\/([a-z0-9]+)\.supabase\.co/) || [])[1];

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const only = args.filter((a) => !a.startsWith("-"));

/* -------------------------------------------------------------------------- */
/* Plan                                                                       */
/* -------------------------------------------------------------------------- */

function readVerifyJwt() {
  const map = {};
  if (!fs.existsSync(CONFIG_TOML)) return map;
  const text = fs.readFileSync(CONFIG_TOML, "utf8");
  const re = /^\[functions\.([a-z0-9-]+)\]\s*$([\s\S]*?)(?=^\[|(?![\s\S]))/gm;
  let m;
  while ((m = re.exec(text))) {
    const body = m[2];
    const value = /^\s*verify_jwt\s*=\s*(true|false)\s*$/m.exec(body);
    map[m[1]] = value ? value[1] === "true" : true;
  }
  return map;
}

const verifyJwt = readVerifyJwt();

const discovered = fs
  .readdirSync(FUNCTIONS_DIR, { withFileTypes: true })
  .filter((d) => d.isDirectory() && !d.name.startsWith("_") && d.name !== "node_modules")
  .map((d) => d.name)
  .filter((name) => fs.existsSync(path.join(FUNCTIONS_DIR, name, "index.ts")))
  .sort();

const unknown = only.filter((name) => !discovered.includes(name));
const targets = only.length ? discovered.filter((n) => only.includes(n)) : discovered;

console.log("\n  Shinzora — Edge Function deploy\n");
console.log(`  project      ${ref || "(missing: set SUPABASE_PROJECT_REF)"}`);
console.log(`  bundler      supabase CLI --use-api (no Docker)`);
console.log(`  functions    ${targets.length} of ${discovered.length}`);
console.log("");

if (unknown.length) {
  console.error(`  ✗ unknown function(s): ${unknown.join(", ")}`);
  console.error(`    available: ${discovered.join(", ")}\n`);
  process.exit(1);
}

for (const name of targets) {
  const flag = verifyJwt[name] === false ? "  (no-verify-jwt)" : "";
  console.log(`  · ${name.padEnd(18)} ${verifyJwt[name] === false ? "public" : "JWT required"}${flag}`);
}
console.log("");

if (!ref) {
  console.error("  ✗ No project ref. Put SUPABASE_URL=https://<ref>.supabase.co in .env");
  console.error("    or export SUPABASE_PROJECT_REF=<ref>.\n");
  process.exit(1);
}

if (dryRun) {
  console.log(`  access token ${token ? "present" : "MISSING (required for a real deploy)"}`);
  console.log("  --dry-run: nothing deployed.\n");
  process.exit(0);
}

if (!token) {
  console.error("  ✗ No access token. Create one at");
  console.error("    https://supabase.com/dashboard/account/tokens");
  console.error("    then:  SUPABASE_ACCESS_TOKEN=sbp_... node scripts/deploy-functions.mjs\n");
  process.exit(1);
}

/* -------------------------------------------------------------------------- */
/* Deploy                                                                     */
/* -------------------------------------------------------------------------- */

function run(command, commandArgs) {
  return new Promise((resolve) => {
    const child = spawn(command, commandArgs, {
      cwd: ROOT,
      env: { ...process.env, SUPABASE_ACCESS_TOKEN: token },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let out = "";
    child.stdout.on("data", (b) => (out += b.toString()));
    child.stderr.on("data", (b) => (out += b.toString()));
    child.on("close", (code) => resolve({ code, out }));
  });
}

/* The CLI is only fetched once; later calls reuse the npx cache. */
const results = [];
for (const name of targets) {
  /* `--yes` (twice): the first belongs to npx, the second confirms the deploy
     in the CLI — newer CLI versions refuse to run without a TTY otherwise. */
  const cliArgs = ["--yes", CLI, "functions", "deploy", name, "--use-api", `--remote=${ref}`, "--yes"];
  if (verifyJwt[name] === false) cliArgs.push("--no-verify-jwt");

  process.stdout.write(`  deploying ${name} … `);
  const started = Date.now();
  const { code, out } = await run("npx", cliArgs);
  const ms = Date.now() - started;

  /* The CLI prints a spinner, so success is decided by the exit code plus a
     negative check for known failure text — never by the spinner alone. */
  const lower = out.toLowerCase();
  const failed =
    code !== 0 ||
    /error|cannot|failed|unauthorized|denied|invalid/.test(lower) && !/deployed/i.test(lower);

  if (failed) {
    console.log("✗");
    const lines = out.split("\n").filter((l) => l.trim() && !/[|\\/-]\s*$/.test(l.trim()));
    for (const line of lines.slice(-8)) console.log(`      ${line.trim()}`);
    results.push({ name, ok: false, ms });
  } else {
    console.log(`✓ ${(ms / 1000).toFixed(1)}s`);
    results.push({ name, ok: true, ms });
  }
}

/* -------------------------------------------------------------------------- */
/* Report                                                                     */
/* -------------------------------------------------------------------------- */

const failed = results.filter((r) => !r.ok);
console.log("");
console.log(`  ${results.length - failed.length}/${results.length} deployed`);

if (failed.length) {
  console.log(`  ✗ ${failed.map((r) => r.name).join(", ")}`);
  console.log("\n  Re-run just the failures:  node scripts/deploy-functions.mjs " + failed.map((r) => r.name).join(" ") + "\n");
  process.exit(1);
}

console.log(`
  Next: prove the deployed functions answer.
    node scripts/smoke-functions.mjs --remote           # contract checks against the live project
    curl -s ${siteUrl}/functions/v1/config | head -c 400
`);

/* A public function that needs a token to even respond would break the landing
   page's capability probe; print the reminder rather than assuming. */
const publicOnes = targets.filter((n) => verifyJwt[n] === false);
if (publicOnes.length) {
  console.log(`  public (no JWT): ${publicOnes.join(", ")}\n`);
}
