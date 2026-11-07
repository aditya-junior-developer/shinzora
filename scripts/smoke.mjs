#!/usr/bin/env node
/**
 * Shinzora — smoke test
 * ---------------------------------------------------------------------------
 * Starts the dev server on a spare port and requests every public route,
 * asserting the response status and a marker that proves the real page was
 * served (not the 404 fallback). Then checks that the security headers and the
 * generated runtime config are present.
 *
 * This is a hosting/route test, not a substitute for the manual walkthrough in
 * docs/TESTING.md — authenticated flows need a browser and a real session.
 *
 * Usage:  node scripts/smoke.mjs [--keep]
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 4199;
const BASE = `http://127.0.0.1:${PORT}`;

const ROUTES = [
  ["/", "Your business. Built, powered", "landing page"],
  ["/auth/login/", "Sign in", "login"],
  ["/auth/signup/", "Create", "signup"],
  ["/auth/verify-email/", "erif", "email verification"],
  ["/auth/forgot-password/", "assword", "password recovery"],
  ["/auth/reset-password/", "assword", "password reset"],
  ["/auth/callback/", "Shinzora", "oauth callback"],
  ["/onboarding/", "onboarding", "wizard"],
  ["/app/", "Shinzora", "dashboard shell"],
  ["/admin/", "Operations console", "admin console"],
  ["/install/", "Install Shinzora", "install page"],
  ["/install-guide/", "Install Shinzora on your device", "setup guide"],
  ["/system-check/", "Deployment verification", "system check"],
  ["/legal/terms/", "Terms of service", "terms"],
  ["/legal/privacy/", "Privacy policy", "privacy"],
  ["/legal/refunds/", "Refund and cancellation", "refunds"],
  ["/legal/acceptable-use/", "Acceptable use policy", "acceptable use"],
  ["/site/", "Loading published site", "published site renderer"],
  ["/manifest.webmanifest", "\"name\"", "PWA manifest"],
  ["/sw.js", "addEventListener", "service worker"],
  ["/css/tokens.css", "--", "design tokens"],
  ["/js/config/env.js", "PLANS", "runtime env module"],
  ["/js/config/runtime.js", "__SHINZORA_ENV__", "generated runtime config"]
];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForServer(timeoutMs = 15000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(`${BASE}/api/health`);
      if (response.ok) return true;
    } catch {
      /* not up yet */
    }
    await sleep(250);
  }
  return false;
}

async function main() {
  const server = spawn(process.execPath, [path.join(ROOT, "scripts", "dev-server.mjs"), "--port", String(PORT)], {
    cwd: ROOT,
    stdio: ["ignore", "pipe", "pipe"]
  });

  let serverLog = "";
  server.stdout.on("data", (chunk) => {
    serverLog += chunk.toString();
  });
  server.stderr.on("data", (chunk) => {
    serverLog += chunk.toString();
  });

  const cleanup = () => {
    if (!server.killed) server.kill("SIGTERM");
  };
  process.on("exit", cleanup);

  const ready = await waitForServer();
  if (!ready) {
    console.error("✕ The dev server did not start.\n");
    console.error(serverLog);
    cleanup();
    process.exit(1);
  }

  const failures = [];
  console.log("\n  Route checks\n");

  for (const [route, marker, label] of ROUTES) {
    try {
      const response = await fetch(`${BASE}${route}`, { redirect: "manual" });
      const body = await response.text();
      const okStatus = response.status === 200;
      const okMarker = body.toLowerCase().includes(String(marker).toLowerCase());
      if (!okStatus || !okMarker) {
        failures.push(`${route} → HTTP ${response.status}${okMarker ? "" : ", marker missing"} (${label})`);
        console.log(`  ✕ ${route.padEnd(28)} HTTP ${response.status}`);
      } else {
        console.log(`  ✓ ${route.padEnd(28)} ${label}`);
      }
    } catch (error) {
      failures.push(`${route} → ${error.message}`);
      console.log(`  ✕ ${route} → ${error.message}`);
    }
  }

  /* Headers on the dashboard and the admin console. */
  for (const route of ["/app/", "/admin/"]) {
    const response = await fetch(`${BASE}${route}`);
    const csp = response.headers.get("content-security-policy") || "";
    const nosniff = response.headers.get("x-content-type-options") || "";
    if (!csp.includes("default-src")) failures.push(`${route} is missing a Content-Security-Policy`);
    if (nosniff !== "nosniff") failures.push(`${route} is missing X-Content-Type-Options: nosniff`);
  }

  /* A missing page must serve the branded 404, not a crash. */
  const notFound = await fetch(`${BASE}/this-route-does-not-exist`);
  if (notFound.status !== 404) failures.push(`Unknown routes return ${notFound.status} instead of 404`);

  /* The admin console must never be indexable. */
  const adminHtml = await (await fetch(`${BASE}/admin/`)).text();
  if (!/noindex/.test(adminHtml)) failures.push("/admin/ is missing a noindex robots directive");

  console.log("");
  if (failures.length) {
    console.log(`  ✕ ${failures.length} smoke failure${failures.length === 1 ? "" : "s"}`);
    failures.forEach((item) => console.log(`    - ${item}`));
    console.log("");
    cleanup();
    process.exit(1);
  }

  console.log(`  ✓ ${ROUTES.length} routes and ${4} header checks passed\n`);
  cleanup();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
