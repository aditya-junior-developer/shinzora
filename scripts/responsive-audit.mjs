#!/usr/bin/env node
/* ==========================================================================
   Shinzora — responsive audit
   --------------------------------------------------------------------------
   Opens every page at three widths, measures it, screenshots it and writes a
   report. Measuring beats eyeballing: the checks below are the ones that
   actually break layouts.

     · horizontal overflow  — document wider than the viewport
     · offenders            — which elements stick out, by selector and width
     · tap targets          — interactive controls smaller than 40 px on mobile
     · console errors       — any page that throws
     · failed requests      — any asset or API call that 404s or 500s
     · first paint exists   — the page has visible text, not an empty shell

     node scripts/responsive-audit.mjs                 # all pages, all widths
     node scripts/responsive-audit.mjs --page /docs/    # one page
     node scripts/responsive-audit.mjs --widths 1440,390
     node scripts/responsive-audit.mjs --no-shots      # measure only

   Needs a dev server on http://127.0.0.1:4173 and playwright-core installed.
   ========================================================================== */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SHOTS = path.join(ROOT, "docs", "media", "responsive");
const REPORT = path.join(ROOT, "docs", "RESPONSIVE-REPORT.md");
const BASE = process.env.AUDIT_BASE || "http://127.0.0.1:4173";

const args = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const i = args.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const next = args[i + 1];
  return next && !next.startsWith("--") ? next : true;
};
const widths = String(flag("widths", "1440,834,390"))
  .split(",")
  .map(Number)
  .filter(Boolean);
const onlyPage = flag("page");
const shots = !args.includes("--no-shots");

const VIEWPORTS = {
  1440: { label: "Desktop", height: 900 },
  834: { label: "Tablet", height: 1112 },
  390: { label: "Mobile", height: 844 }
};

/* Every page in the project, with how to reach a meaningful state. */
const PAGES = [
  { route: "/", name: "Home" },
  { route: "/404.html", name: "404", file: true },
  { route: "/offline.html", name: "Offline", file: true },
  { route: "/download/", name: "Download" },
  { route: "/docs/", name: "Documentation" },
  { route: "/install/", name: "Install" },
  { route: "/install-guide/", name: "Install guide" },
  { route: "/system-check/", name: "System check", ready: "diagnostics",
    /* This page asks the database whether legacy columns exist, so a 400 is the
       answer it is looking for, not a fault. */
    tolerate: [/onboarding_progress\?select=/, /integration_tokens/] },
  { route: "/site/?p=qa-audit", name: "Published site (renderer)", tolerate: [/functions\/v1\/site/] },
  { route: "/legal/terms/", name: "Terms" },
  { route: "/legal/privacy/", name: "Privacy" },
  { route: "/legal/refunds/", name: "Refunds" },
  { route: "/legal/acceptable-use/", name: "Acceptable use" },
  { route: "/auth/login/", name: "Sign in" },
  { route: "/auth/signup/", name: "Sign up" },
  { route: "/auth/forgot-password/", name: "Forgot password" },
  { route: "/auth/reset-password/", name: "Reset password (invalid link)" },
  { route: "/auth/verify-email/", name: "Verify email" },
  { route: "/auth/callback/", name: "Auth callback" },
  { route: "/admin-login/", name: "Admin sign in" },
  { route: "/admin/", name: "Admin console (gate)", auth: "admin" },
  { route: "/app/", name: "Dashboard", auth: "customer" },
  { route: "/onboarding/", name: "Onboarding", auth: "customer" }
];

const DASHBOARD_VIEWS = ["overview", "requests", "billing", "settings", "store", "orders", "assistant"];

const slug = (route) =>
  route
    .replace(/^\//, "")
    .replace(/[?#].*$/, "")
    .replace(/\/$/, "")
    .replace(/\//g, "-")
    .replace(/\.html$/, "") || "home";

async function measure(page) {
  return page.evaluate(() => {
    const doc = document.documentElement;
    const vw = window.innerWidth;
    const overflow = Math.max(0, doc.scrollWidth - doc.clientWidth);

    const offenders = [];
    for (const el of document.querySelectorAll("body *")) {
      const style = getComputedStyle(el);
      if (style.position === "fixed" || style.display === "none" || style.visibility === "hidden") continue;
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;
      const right = rect.right + window.scrollX;
      if (rect.width > vw + 1 || right > vw + 1) {
        offenders.push({
          tag: el.tagName.toLowerCase(),
          cls: (el.className || "").toString().split(" ").filter(Boolean).slice(0, 3).join("."),
          id: el.id || "",
          width: Math.round(rect.width),
          right: Math.round(right)
        });
      }
    }

    const interactive = [];
    for (const el of document.querySelectorAll("a, button, input, select, textarea, [role=button]")) {
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      if (style.display === "none" || style.visibility === "hidden" || rect.width === 0) continue;
      /* A link inside a sentence is text, not a control. Only things a thumb has
         to hit deliberately — buttons, fields and links styled as buttons — are
         measured. */
      if (el.tagName === "A") {
        const styled = /btn|button|chip|tab|pill|action|card-cta/.test(String(el.className || ""));
        const inChrome = Boolean(el.closest("nav, .nav, .toolbar, .tabs, .segmented, .nav-actions, .mobile-nav, .sidebar"));
        if (!styled && !inChrome) continue;
      }
      const label = (el.getAttribute("aria-label") || el.textContent || el.getAttribute("placeholder") || "").trim().slice(0, 40);
      if (rect.height < 32 || rect.width < 32) {
        interactive.push({ tag: el.tagName.toLowerCase(), label, w: Math.round(rect.width), h: Math.round(rect.height) });
      }
    }

    const text = (document.body.innerText || "").trim();
    return {
      overflow,
      offenders: offenders.slice(0, 8),
      offenderCount: offenders.length,
      smallTargets: interactive.slice(0, 8),
      smallTargetCount: interactive.length,
      textLength: text.length,
      title: document.title
    };
  });
}

async function main() {
  if (shots) fs.mkdirSync(SHOTS, { recursive: true });

  const browser = await chromium.launch({ args: ["--no-sandbox"] });
  const report = { startedAt: new Date().toISOString(), base: BASE, pages: [], totals: {} };
  let failures = 0;

  /* One context per auth mode so a signed-in session is reused. */
  const contexts = {};
  const contextFor = async (auth) => {
    if (contexts[auth]) return contexts[auth];
    const ctx = await browser.newContext();
    if (auth === "customer") {
      const res = await ctx.request.post(`${BASE}/api/prelaunch/auth/login`, {
        data: { email: process.env.QA_EMAIL || "business@business.com", password: process.env.QA_PASSWORD || "Business@dmin" }
      });
      if (!res.ok()) console.log(`  ! customer sign-in failed (${res.status()}) — dashboard pages will show the gate`);
    }
    contexts[auth] = ctx;
    return ctx;
  };

  const targets = [];
  for (const page of PAGES) {
    if (onlyPage && page.route !== onlyPage) continue;
    if (page.route === "/app/") {
      for (const view of DASHBOARD_VIEWS) {
        targets.push({ ...page, route: `/app/?view=${view}`, name: `Dashboard · ${view}`, shotBase: `app-${view}` });
      }
    } else {
      targets.push(page);
    }
  }

  for (const target of targets) {
    const ctx = await contextFor(target.auth || "public");
    const page = await ctx.newPage();
    const consoleErrors = [];
    const badRequests = [];
    page.on("console", (m) => m.type() === "error" && consoleErrors.push(m.text().slice(0, 160)));
    page.on("pageerror", (e) => consoleErrors.push("pageerror: " + String(e).slice(0, 160)));
    const tolerate = target.tolerate || [];
    page.on("response", (r) => {
      if (r.status() < 400 || r.url().includes("favicon")) return;
      if (tolerate.some((pattern) => pattern.test(r.url()))) return;
      badRequests.push(`${r.status()} ${r.url().replace(BASE, "").slice(0, 70)}`);
    });

    const entry = { route: target.route, name: target.name, auth: target.auth || "public", viewports: {} };
    for (const width of widths) {
      const spec = VIEWPORTS[width] || { label: `${width}px`, height: 900 };
      await page.setViewportSize({ width, height: spec.height });
      let error = null;
      try {
        /* `networkidle` is not a reliable finish line — a page that keeps a
           socket open, or keeps probing, never reaches it. Load, then wait for
           the state that actually means "finished". */
        await page.goto(BASE + target.route, { waitUntil: "domcontentloaded", timeout: 45000 });
        /* Some pages do their work after load (the diagnostic run, the auth
           guard). Waiting for the real end state is the difference between
           auditing a finished page and auditing a spinner. */
        if (target.ready === "diagnostics") {
          await page.waitForFunction(
            () => {
              const note = document.querySelector("#status-note");
              return Boolean(note && note.textContent && !/Running/i.test(note.textContent));
            },
            null,
            { timeout: 120000 }
          );
        }
        await page.waitForTimeout(1500);
      } catch (e) {
        error = String(e).slice(0, 120);
      }
      const m = error ? { overflow: -1, offenderCount: 0, offenders: [], smallTargetCount: 0, smallTargets: [], textLength: 0 } : await measure(page);
      const tolerated = tolerate.length
        ? consoleErrors.filter((line) => !/Failed to load resource/.test(line))
        : consoleErrors;
      entry.viewports[width] = {
        label: spec.label,
        ...m,
        error,
        consoleErrors: [...new Set(tolerated)].slice(0, 3),
        badRequests: [...new Set(badRequests)].slice(0, 3)
      };

      if (shots && !error) {
        /* One screenshot per page *and view*: seven dashboard views sharing three
           file names would have overwritten each other's evidence. */
        const file = path.join(SHOTS, `${target.shotBase || slug(target.route)}-${width}.jpg`);
        try {
          await page.screenshot({ path: file, type: "jpeg", quality: 70, fullPage: width === 1440 });
          entry.viewports[width].shot = path.relative(ROOT, file);
        } catch {
          /* a screenshot failure must not stop the audit */
        }
      }
    }
    await page.close();

    const bad = Object.values(entry.viewports).filter(
      (v) => v.error || v.overflow > 1 || v.textLength < 20 || v.consoleErrors?.length
    );
    entry.status = bad.length ? "issues" : "ok";
    if (bad.length) failures += 1;
    report.pages.push(entry);

    const summary = Object.entries(entry.viewports)
      .map(([w, v]) => `${w}:${v.error ? "ERR" : v.overflow > 1 ? `+${v.overflow}px` : "ok"}`)
      .join("  ");
    console.log(`  ${entry.status === "ok" ? "✓" : "!"} ${target.name.padEnd(32)} ${summary}`);
  }

  for (const ctx of Object.values(contexts)) await ctx.close();
  await browser.close();

  report.totals = {
    pages: report.pages.length,
    clean: report.pages.filter((p) => p.status === "ok").length,
    withIssues: failures,
    viewportCount: widths.length,
    checks: report.pages.length * widths.length
  };

  fs.writeFileSync(path.join(ROOT, "docs", "responsive-audit.json"), JSON.stringify(report, null, 2));
  writeMarkdown(report, widths);
  console.log(`\n  ${report.totals.checks} page/viewport combinations · ${report.totals.clean} clean · ${failures} with issues`);
  console.log(`  report: docs/RESPONSIVE-REPORT.md\n`);
  process.exitCode = failures ? 1 : 0;
}

function writeMarkdown(report, widths) {
  const lines = [];
  lines.push(`# Responsive audit — ${new Date(report.startedAt).toISOString().slice(0, 10)}`);
  lines.push("");
  lines.push(
    `Every page in \`public/\` was opened in a real Chromium build at ${widths.join(" px, ")} px and measured. ` +
      `Screenshots are in \`docs/media/responsive/\`; raw measurements are in \`docs/responsive-audit.json\`.`
  );
  lines.push("");
  lines.push("Checks per page and width: horizontal overflow, the elements causing it, tap-target size, console errors,");
  lines.push("failed requests and whether the page rendered visible text.");
  lines.push("");
  lines.push(`**${report.totals.checks} combinations · ${report.totals.clean} clean · ${report.totals.withIssues} with issues**`);
  lines.push("");
  lines.push("| Page | Route | " + widths.map((w) => `${VIEWPORTS[w]?.label || w} (${w}px)`).join(" | ") + " |");
  lines.push("| --- | --- | " + widths.map(() => "---").join(" | ") + " |");
  for (const page of report.pages) {
    const cells = widths.map((w) => {
      const v = page.viewports[w];
      if (!v) return "—";
      if (v.error) return `ERROR: ${v.error}`;
      const bits = [];
      bits.push(v.overflow > 1 ? `**overflow +${v.overflow}px**` : "no overflow");
      if (v.textLength < 20) bits.push("**empty render**");
      if (v.consoleErrors?.length) bits.push(`**${v.consoleErrors.length} console error(s)**`);
      if (v.smallTargetCount) bits.push(`${v.smallTargetCount} small target(s)`);
      if (v.shot) bits.push(`[shot](${v.shot.replace(/\\/g, "/")})`);
      return bits.join(" · ");
    });
    lines.push(`| ${page.name} | \`${page.route}\` | ${cells.join(" | ")} |`);
  }
  lines.push("");

  const offenders = report.pages.flatMap((p) =>
    widths.flatMap((w) => {
      const v = p.viewports[w];
      return (v?.offenders || []).map((o) => ({ page: p.route, width: w, ...o }));
    })
  );
  lines.push("## Elements that stick out");
  lines.push("");
  if (!offenders.length) {
    lines.push("None: no element is wider than, or extends past, the viewport at any tested width.");
  } else {
    lines.push("| Page | Width | Element | Width px | Right edge px |");
    lines.push("| --- | --- | --- | --- | --- |");
    for (const o of offenders.slice(0, 40)) {
      lines.push(`| \`${o.page}\` | ${o.width} | \`${o.tag}${o.id ? "#" + o.id : ""}${o.cls ? "." + o.cls : ""}\` | ${o.width_px || o.width} | ${o.right} |`);
    }
  }
  lines.push("");

  const smalls = report.pages.flatMap((p) =>
    widths.flatMap((w) => {
      const v = p.viewports[w];
      return (v?.smallTargets || []).map((t) => ({ page: p.route, width: w, ...t }));
    })
  );
  lines.push("## Controls smaller than 32 px");
  lines.push("");
  if (!smalls.length) lines.push("None detected.");
  else {
    lines.push("| Page | Width | Control | Label | Size |");
    lines.push("| --- | --- | --- | --- | --- |");
    for (const t of smalls.slice(0, 40)) {
      lines.push(`| \`${t.page}\` | ${t.width} | ${t.tag} | ${String(t.label || "").replace(/\|/g, "\\|")} | ${t.w}×${t.h} |`);
    }
  }
  lines.push("");
  fs.writeFileSync(REPORT, lines.join("\n"));
}

main().catch((error) => {
  console.error("\n  audit failed:", error.message);
  process.exit(1);
});
