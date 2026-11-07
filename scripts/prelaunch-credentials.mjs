#!/usr/bin/env node
/* ==========================================================================
   Shinzora — provision the two pre-launch accounts
   --------------------------------------------------------------------------
   Writes the *hashes* of the account passwords into `.env` (server-side only,
   gitignored). Plaintext passwords never touch the repository, `public/`, or
   any file a browser can download.

     node scripts/prelaunch-credentials.mjs --init
     node scripts/prelaunch-credentials.mjs \
       --user business@business.com --user-password 'Business@dmin' \
       --admin Shinzora@admin --admin-password 'shinzora@dmin'

     node scripts/prelaunch-credentials.mjs --show     # what is configured
   ========================================================================== */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { hashPassword } from "../server/prelaunch/auth-core.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ENV_FILE = path.join(ROOT, ".env");

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith("--")) {
      out[key] = next;
      i += 1;
    } else {
      out[key] = true;
    }
  }
  return out;
}

function readEnvLines() {
  if (!fs.existsSync(ENV_FILE)) return [];
  return fs.readFileSync(ENV_FILE, "utf8").split("\n");
}

function upsert(lines, key, value) {
  const index = lines.findIndex((line) => line.startsWith(`${key}=`));
  const entry = `${key}=${value}`;
  if (index === -1) {
    if (lines.length && lines[lines.length - 1] === "") lines.splice(lines.length - 1, 0, entry);
    else lines.push(entry);
  } else {
    lines[index] = entry;
  }
}

function currentValue(lines, key) {
  const line = lines.find((entry) => entry.startsWith(`${key}=`));
  if (!line) return null;
  return line.slice(key.length + 1).replace(/^["']|["']$/g, "");
}

const args = parseArgs(process.argv.slice(2));
const lines = readEnvLines();
let changed = false;

if (args.init || !currentValue(lines, "PRELAUNCH_SESSION_SECRET")) {
  if (!currentValue(lines, "PRELAUNCH_SESSION_SECRET")) {
    upsert(lines, "PRELAUNCH_SESSION_SECRET", crypto.randomBytes(48).toString("hex"));
    changed = true;
    console.log("  ✓ generated PRELAUNCH_SESSION_SECRET (48 bytes)");
  }
}

if (args.user && args["user-password"]) {
  upsert(lines, "PRELAUNCH_USER_EMAIL", String(args.user));
  upsert(lines, "PRELAUNCH_USER_PASSWORD_HASH", hashPassword(String(args["user-password"])));
  changed = true;
  console.log(`  ✓ pre-launch user → ${args.user} (scrypt digest stored)`);
}

if (args.admin && args["admin-password"]) {
  upsert(lines, "PRELAUNCH_ADMIN_EMAIL", String(args.admin));
  upsert(lines, "PRELAUNCH_ADMIN_PASSWORD_HASH", hashPassword(String(args["admin-password"])));
  changed = true;
  console.log(`  ✓ administrator → ${args.admin} (scrypt digest stored)`);
}

if (changed) {
  if (!lines.some((line) => line.includes("pre-launch accounts"))) {
    const header = [
      "",
      "# ---------------------------------------------------------------------------",
      "# Pre-launch accounts — verified server-side (see server/prelaunch/auth-core.mjs).",
      "# Only scrypt digests are stored here. This file is gitignored and never served.",
      "# ---------------------------------------------------------------------------"
    ];
    lines.push(...header);
  }
  fs.writeFileSync(ENV_FILE, lines.join("\n").trimEnd() + "\n");
  console.log(`\n  wrote ${path.relative(ROOT, ENV_FILE)}`);
}

if (args.show || !changed) {
  const email = (key) => currentValue(lines, key) || "(not set)";
  const hashState = (key) => {
    const value = currentValue(lines, key);
    return value ? `scrypt digest, ${value.split("$")[4]?.length ?? 0}b salt` : "(not set)";
  };
  console.log("\n  Pre-launch accounts");
  console.log(`    user  : ${email("PRELAUNCH_USER_EMAIL")}   ${hashState("PRELAUNCH_USER_PASSWORD_HASH")}`);
  console.log(`    admin : ${email("PRELAUNCH_ADMIN_EMAIL")}   ${hashState("PRELAUNCH_ADMIN_PASSWORD_HASH")}`);
  console.log(`    secret: ${currentValue(lines, "PRELAUNCH_SESSION_SECRET") ? "set" : "MISSING"}`);
}
