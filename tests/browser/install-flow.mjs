/* ==========================================================================
   Shinzora — browser harness: install-flow.mjs
   --------------------------------------------------------------------------
   End-to-end checks for the Get App download centre and the setup guide.
   Everything here is behavioural: the tests drive the real modal, the real
   links and the real network, then assert what actually happened.

   Covered:
     • the three screens (device → family → platform) and both families
     • Back, Escape and backdrop close, in the right order
     • the exact guide sentence, and that "link" opens the guide in a NEW page
       (a popup, not a same-tab navigation, not an iframe inside the modal)
     • the guide page loads standalone with all five platform sections, renders
       its platform marks, and animates its aurora
     • honest availability: with an empty build registry there is no download
       button anywhere, and no false "installed" message
     • with a build registry seeded over the network, a Download button appears,
       streams real bytes and reports the real size
     • a registry entry whose file 404s is never offered as a download
     • responsive: 390 / 768 / 1440, no horizontal overflow, modal on screen
     • reduced motion: transitions collapse to ~0 ms and the flow still works

     BASE=http://127.0.0.1:4173 node tests/browser/install-flow.mjs

   Screenshots go to $SHOTS (default /tmp/shinzora-shots/install).
   ========================================================================== */

import { chromium } from "playwright-core";
import fs from "node:fs";

const BASE = process.env.BASE || "http://127.0.0.1:4173";
const SHOTS = process.env.SHOTS || "/tmp/shinzora-shots/install";
fs.mkdirSync(SHOTS, { recursive: true });

const browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
let bad = 0;
const ok = (name, condition, note = "") => {
  console.log(`  ${condition ? "✓" : "✗"} ${name}${note ? ` — ${note}` : ""}`);
  if (!condition) bad++;
};

const IGNORE = /Failed to load resource|CORS policy|net::ERR/;

async function open(width = 1440, height = 900, options = {}) {
  const ctx = await browser.newContext({
    viewport: { width, height },
    deviceScaleFactor: 1,
    ...options
  });
  const p = await ctx.newPage();
  const errors = [];
  p.on("console", (m) => {
    if (m.type() === "error" && !IGNORE.test(m.text())) errors.push(m.text());
  });
  p.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  return { ctx, p, errors };
}

/** Opens the modal from whichever trigger is visible at this width. */
async function openPanel(p) {
  const direct = p.locator(".site-nav [data-install-open]");
  if (await direct.isVisible().catch(() => false)) {
    await direct.click();
  } else {
    await p.click("[data-nav-toggle]");
    await p.waitForTimeout(300);
    await p.click("#mobile-menu [data-install-open]");
  }
  await p.waitForSelector(".ip-backdrop.is-open");
  await p.waitForTimeout(450);
}

/* --------------------------------------------------- 1. default registry */
{
  const { ctx, p, errors } = await open();
  await p.goto(BASE + "/", { waitUntil: "networkidle" });
  await openPanel(p);

  const cover = await p.evaluate(() => {
    const panel = document.querySelector(".ip-panel");
    const rect = panel.getBoundingClientRect();
    return {
      role: panel.getAttribute("role"),
      modal: panel.getAttribute("aria-modal"),
      /* Scoped to the modal: the page also carries a bottom install banner
         that reuses the .ip-title class for its own heading. */
      title: panel.querySelector(".ip-title")?.textContent.trim(),
      sub: panel.querySelector(".ip-sub")?.textContent.trim(),
      lede: panel.querySelector(".ip-lede")?.textContent.trim(),
      devices: [...document.querySelectorAll(".ip-device")].map((b) => ({
        name: b.querySelector(".ip-device-name").textContent.trim(),
        meta: b.querySelector(".ip-device-meta").textContent.trim(),
        desc: b.querySelector(".ip-device-desc").textContent.trim(),
        icon: !!b.querySelector(".ip-device-icon svg")
      })),
      mark: !!panel.querySelector(".ip-mark img"),
      onScreen: rect.top >= 0 && rect.bottom <= innerHeight + 1,
      bodyLocked: document.body.classList.contains("ip-open"),
      focusInside: panel.contains(document.activeElement)
    };
  });

  ok("modal is a labelled dialog", cover.role === "dialog" && cover.modal === "true" && cover.title === "Get Shinzora");
  ok("logo mark present", cover.mark);
  ok("subtitle exact", cover.sub === "Your business ecosystem. Everywhere.", cover.sub);
  ok("description exact", cover.lede === "Choose your device to get the right application.", cover.lede);
  ok("two device buttons", cover.devices.length === 2);
  ok(
    "PHONE copy",
    cover.devices[0]?.name === "Phone" &&
      cover.devices[0]?.meta === "Android & iOS" &&
      cover.devices[0]?.desc === "Get Shinzora on your phone."
  );
  ok(
    "COMPUTER copy",
    cover.devices[1]?.name === "Computer" &&
      cover.devices[1]?.meta === "Windows, macOS & Linux" &&
      cover.devices[1]?.desc === "Get Shinzora on your computer."
  );
  ok("device icons drawn", cover.devices.every((d) => d.icon));
  ok("modal fits the viewport", cover.onScreen);
  ok("scroll locked behind the modal", cover.bodyLocked);
  ok("focus moved into the modal", cover.focusInside);
  ok("no console/page errors", errors.length === 0, errors.slice(0, 2).join(" | "));
  await p.screenshot({ path: `${SHOTS}/01-device.png` });

  /* ---- phone panel ---- */
  await p.click('[data-ip-family="phone"]');
  await p.waitForTimeout(520);
  const phone = await p.evaluate(() => ({
    title: document.querySelector(".ip-step-title")?.textContent.trim(),
    options: [...document.querySelectorAll(".ip-option")].map((b) => ({
      platform: b.getAttribute("data-ip-platform"),
      name: b.querySelector(".ip-option-name").textContent.replace("this device", "").trim(),
      desc: b.querySelector(".ip-option-desc").textContent.trim(),
      brandIcon: !!b.querySelector(".ip-option-mark svg")
    })),
    guide: document.querySelector(".ip-guide")?.textContent.replace(/\s+/g, " ").trim(),
    guideLinks: [...document.querySelectorAll(".ip-guide a")].map((a) => ({
      text: a.textContent,
      href: a.getAttribute("href"),
      target: a.getAttribute("target"),
      rel: a.getAttribute("rel")
    })),
    back: !!document.querySelector("[data-ip-back]"),
    downloads: document.querySelectorAll("[data-ip-download]").length
  }));

  ok("phone heading", phone.title === "Choose Your Mobile Platform", phone.title);
  ok("android + ios listed", phone.options.map((o) => o.platform).join(",") === "android,ios");
  ok("android label", phone.options[0]?.desc === "Download Shinzora for Android.");
  ok("ios label", phone.options[1]?.desc === "Get Shinzora on your iPhone.");
  ok("official platform marks drawn", phone.options.every((o) => o.brandIcon));
  ok(
    "guide sentence exact",
    phone.guide === "For setup guide, please check this link.",
    JSON.stringify(phone.guide)
  );
  ok("only the word 'link' is clickable", phone.guideLinks.length === 1 && phone.guideLinks[0].text === "link");
  ok(
    "guide link is a new tab",
    phone.guideLinks[0]?.href === "/install-guide/" &&
      phone.guideLinks[0]?.target === "_blank" &&
      /noopener/.test(phone.guideLinks[0]?.rel || "")
  );
  ok("Back control present", phone.back);
  ok("no fake download button on the list screen", phone.downloads === 0);
  await p.screenshot({ path: `${SHOTS}/02-phone.png` });

  /* ---- android detail (no build published) ---- */
  await p.click('[data-ip-platform="android"]');
  await p.waitForTimeout(520);
  const android = await p.evaluate(() => ({
    downloads: document.querySelectorAll("[data-ip-download]").length,
    prompts: document.querySelectorAll("[data-ip-prompt]").length,
    head: document.querySelector(".ip-action-head")?.textContent.replace(/\s+/g, " ").trim(),
    steps: [...document.querySelectorAll(".ip-steps li")].map((li) => li.textContent.trim()),
    guide: !!document.querySelector(".ip-guide"),
    back: !!document.querySelector("[data-ip-back]"),
    status: document.querySelector("[data-ip-status]")?.textContent.trim()
  }));
  ok("no download button without a build", android.downloads === 0);
  ok("states the truth about the APK", /No standalone APK build is published yet/.test(android.head || ""), android.head);
  ok("browser-install steps shown", android.steps.length >= 3, `${android.steps.length} steps`);
  ok("guide line also on the detail screen", android.guide);
  ok("back control on the detail screen", android.back);
  ok("no false success message", android.status === "", JSON.stringify(android.status));
  await p.screenshot({ path: `${SHOTS}/03-android.png` });

  /* ---- guide opens in a real new tab ---- */
  const [guidePage] = await Promise.all([
    p.context().waitForEvent("page"),
    p.click(".ip-guide a")
  ]);
  await guidePage.waitForLoadState("domcontentloaded");
  const guideUrl = new URL(guidePage.url());
  ok("guide opened in a new page", guidePage !== p && guideUrl.pathname === "/install-guide/", guidePage.url());
  const stillOpen = await p.evaluate(() => !!document.querySelector(".ip-backdrop"));
  ok("modal stayed put when the guide opened", stillOpen);

  await guidePage.waitForTimeout(900);
  const guide = await guidePage.evaluate(() => ({
    h1: document.querySelector("h1")?.textContent.trim(),
    sections: ["android", "ios", "windows", "macos", "linux"].map((id) => !!document.getElementById(id)),
    marks: document.querySelectorAll(".guide-platform svg").length,
    steps: document.querySelectorAll(".guide-steps li").length,
    canvas: document.querySelectorAll("canvas[data-aurora]").length,
    auroraMounted: document.querySelector("canvas[data-aurora]")?.dataset.auroraMounted === "true",
    overflowX: document.documentElement.scrollWidth - innerWidth,
    jump: document.querySelectorAll(".guide-jump a").length
  }));
  ok("guide has a heading", /Install Shinzora/.test(guide.h1 || ""), guide.h1);
  ok("guide covers all five platforms", guide.sections.every(Boolean), guide.sections.join(","));
  ok("guide renders platform marks", guide.marks >= 5, `${guide.marks} marks`);
  ok("guide has numbered steps", guide.steps >= 15, `${guide.steps} steps`);
  ok("guide mounts the aurora", guide.canvas === 1 && guide.auroraMounted);
  ok("guide does not overflow", guide.overflowX <= 0, `${guide.overflowX}px`);
  ok("guide nav jumps present", guide.jump >= 5);
  await guidePage.screenshot({ path: `${SHOTS}/04-guide.png`, fullPage: false });
  await guidePage.close();

  /* ---- back navigation ---- */
  await p.click("[data-ip-back]");
  await p.waitForTimeout(500);
  ok("Back returns to the phone list", (await p.locator(".ip-option").count()) === 2);
  await p.click("[data-ip-back]");
  await p.waitForTimeout(500);
  ok("Back returns to the device screen", (await p.locator(".ip-device").count()) === 2);

  /* ---- computer panel ---- */
  await p.click('[data-ip-family="computer"]');
  await p.waitForTimeout(520);
  const computer = await p.evaluate(() => ({
    title: document.querySelector(".ip-step-title")?.textContent.trim(),
    platforms: [...document.querySelectorAll(".ip-option")].map((b) => b.getAttribute("data-ip-platform")),
    descs: [...document.querySelectorAll(".ip-option-desc")].map((d) => d.textContent.trim())
  }));
  ok("computer heading", computer.title === "Choose Your Desktop Platform", computer.title);
  ok("three desktop platforms", computer.platforms.join(",") === "windows,macos,linux");
  ok("macOS and Linux named correctly", /Mac/.test(computer.descs[1]) && /Linux/.test(computer.descs[2]));
  await p.screenshot({ path: `${SHOTS}/05-computer.png` });

  for (const key of ["windows", "macos", "linux"]) {
    await p.click(`[data-ip-platform="${key}"]`);
    await p.waitForTimeout(500);
    const detail = await p.evaluate(() => ({
      downloads: document.querySelectorAll("[data-ip-download]").length,
      formats: document.querySelector(".ip-action-head")?.textContent || "",
      steps: document.querySelectorAll(".ip-steps li").length,
      guide: !!document.querySelector(".ip-guide")
    }));
    const expected = { windows: "EXE", macos: "DMG", linux: "AppImage" }[key];
    ok(`${key}: no fabricated installer`, detail.downloads === 0);
    ok(`${key}: names the missing ${expected} honestly`, detail.formats.includes(expected), detail.formats.replace(/\s+/g, " ").trim());
    ok(`${key}: steps + guide line`, detail.steps >= 3 && detail.guide);
    await p.click("[data-ip-back]");
    await p.waitForTimeout(450);
  }

  /* ---- escape closes from the top ---- */
  await p.click("[data-ip-back]");
  await p.waitForTimeout(450);
  await p.keyboard.press("Escape");
  await p.waitForTimeout(500);
  ok("Escape closes the modal at the top level", (await p.locator(".ip-backdrop").count()) === 0);
  ok("scroll lock released", !(await p.evaluate(() => document.body.classList.contains("ip-open"))));

  await ctx.close();
}

/* ------------------------------------------------------ 2. seeded registry */
{
  const { ctx, p, errors } = await open();
  const bytes = Buffer.alloc(64 * 1024, 7);
  const seen = [];

  await p.route("**/downloads/manifest.json", (route) => {
    seen.push("manifest");
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        builds: {
          android: { file: "shinzora-test.apk", url: "/downloads/test-build.bin", format: "APK", size: bytes.length },
          windows: { file: "missing.exe", url: "/downloads/does-not-exist.bin", format: "EXE", size: 1024 }
        }
      })
    });
  });
  await p.route("**/downloads/test-build.bin", (route) => {
    if (route.request().method() === "HEAD") {
      return route.fulfill({
        status: 200,
        headers: { "content-length": String(bytes.length), "content-type": "application/vnd.android.package-archive" }
      });
    }
    seen.push("download");
    return route.fulfill({
      status: 200,
      headers: { "content-length": String(bytes.length), "content-type": "application/vnd.android.package-archive" },
      body: bytes
    });
  });
  await p.route("**/downloads/does-not-exist.bin", (route) => route.fulfill({ status: 404, body: "not found" }));

  await p.goto(BASE + "/", { waitUntil: "networkidle" });
  await openPanel(p);

  await p.click('[data-ip-family="phone"]');
  await p.waitForTimeout(700);
  const chips = await p.evaluate(() =>
    [...document.querySelectorAll(".ip-option")].map((b) => ({
      key: b.getAttribute("data-ip-platform"),
      chip: b.querySelector(".ip-chip")?.textContent.replace(/\s+/g, " ").trim(),
      ready: !!b.querySelector(".ip-chip.is-ready")
    }))
  );
  ok("published build is advertised for android", chips[0]?.ready === true, JSON.stringify(chips[0]?.chip));
  ok("iOS still shows the browser route", chips[1]?.ready === false, JSON.stringify(chips[1]?.chip));

  await p.click('[data-ip-platform="android"]');
  await p.waitForTimeout(600);
  const realButton = await p.locator("[data-ip-download]").count();
  ok("a real build produces a real download button", realButton === 1);
  ok("the button names the file size", /64 KB/.test(await p.locator(".ip-action-size").innerText()), await p.locator(".ip-action-size").innerText());
  await p.screenshot({ path: `${SHOTS}/06-download-available.png` });

  await p.click("[data-ip-download]");
  await p.waitForTimeout(1200);
  const after = await p.evaluate(() => ({
    status: document.querySelector(".ip-status")?.textContent.trim(),
    tone: document.querySelector(".ip-status")?.className,
    progressHidden: document.querySelector("[data-ip-progress]")?.hidden,
    label: document.querySelector("[data-ip-download-label]")?.textContent.trim()
  }));
  ok("download actually streamed through the panel", seen.includes("download"), seen.join(","));
  ok("success message reports real bytes", /Downloaded 64 KB/.test(after.status || ""), after.status);
  ok("success message is styled as success", /is-ok/.test(after.tone || ""));
  ok("progress bar was shown", after.progressHidden === false);
  ok("button becomes 'Download again'", after.label === "Download again", after.label);
  ok("no console/page errors with a seeded registry", errors.length === 0, errors.slice(0, 2).join(" | "));

  /* the 404 entry must never surface as a button */
  await p.click("[data-ip-back]");
  await p.waitForTimeout(450);
  await p.click("[data-ip-back]");
  await p.waitForTimeout(450);
  await p.click('[data-ip-family="computer"]');
  await p.waitForTimeout(700);
  await p.click('[data-ip-platform="windows"]');
  await p.waitForTimeout(600);
  const win = await p.evaluate(() => ({
    downloads: document.querySelectorAll("[data-ip-download]").length,
    head: document.querySelector(".ip-action-head")?.textContent.replace(/\s+/g, " ").trim()
  }));
  ok("a registry entry whose file 404s is not offered", win.downloads === 0);
  ok("...and the panel says no build is published", /No standalone EXE build/.test(win.head || ""), win.head);

  await ctx.close();
}

/* ----------------------------------------------------- 3. responsive sweep */
for (const [w, h, label] of [[390, 844, "mobile"], [768, 1024, "tablet"], [1440, 900, "desktop"]]) {
  const { ctx, p } = await open(w, h, { isMobile: w < 500, hasTouch: w < 500 });
  await p.goto(BASE + "/", { waitUntil: "networkidle" });
  await openPanel(p);

  const check = async (name) => {
    const state = await p.evaluate(() => {
      const panel = document.querySelector(".ip-panel");
      const rect = panel.getBoundingClientRect();
      const clipped = [...panel.querySelectorAll("button, a")].filter((el) => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && (r.left < rect.left - 1 || r.right > rect.right + 1);
      }).length;
      return {
        overflowX: document.documentElement.scrollWidth - innerWidth,
        insideViewport: rect.top >= -1 && rect.bottom <= innerHeight + 1 && rect.left >= -1,
        width: Math.round(rect.width),
        clipped,
        scrollable: panel.scrollHeight <= panel.clientHeight + 2
      };
    });
    ok(`${label}/${name}: no horizontal overflow`, state.overflowX <= 0, `${state.overflowX}px`);
    ok(`${label}/${name}: modal inside the viewport`, state.insideViewport, `${state.width}px wide`);
    ok(`${label}/${name}: controls not clipped`, state.clipped === 0, `${state.clipped} clipped`);
  };

  await check("device");
  await p.screenshot({ path: `${SHOTS}/07-${label}-device.png` });
  await p.click('[data-ip-family="phone"]');
  await p.waitForTimeout(500);
  await check("phone");
  await p.click('[data-ip-platform="ios"]');
  await p.waitForTimeout(500);
  await check("ios");
  await p.screenshot({ path: `${SHOTS}/08-${label}-ios.png` });
  await ctx.close();
}

/* ------------------------------------------------------- 4. reduced motion */
{
  const { ctx, p } = await open(1440, 900, { reducedMotion: "reduce" });
  await p.goto(BASE + "/", { waitUntil: "networkidle" });
  await openPanel(p);

  const duration = await p.evaluate(() => {
    const view = document.querySelector(".ip-view");
    return getComputedStyle(view).transitionDuration;
  });
  ok("reduced motion collapses the transition", duration.split(",").every((d) => parseFloat(d) < 0.02), duration);

  await p.click('[data-ip-family="computer"]');
  await p.waitForTimeout(120);
  const instant = await p.locator(".ip-option").count();
  ok("reduced motion: screen swaps immediately", instant === 3, `${instant} options after 120 ms`);

  await p.click('[data-ip-platform="linux"]');
  await p.waitForTimeout(120);
  ok("reduced motion: detail screen renders", (await p.locator(".ip-steps li").count()) >= 3);
  await ctx.close();
}

await browser.close();
console.log(bad === 0 ? "\n✓ install flow: all checks passed" : `\n✗ install flow: ${bad} check(s) failed`);
process.exit(bad === 0 ? 0 : 1);
