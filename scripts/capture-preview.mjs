/* Quick visual capture of the running site for review. */
import { chromium } from "playwright-core";
import fs from "node:fs";

const BASE = process.env.BASE || "http://127.0.0.1:4173";
const OUT = "/home/user/preview";
fs.mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });

async function shot(name, path, width, height, fullPage = true) {
  const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  try {
    await page.goto(BASE + path, { waitUntil: "networkidle", timeout: 30000 });
  } catch {
    await page.waitForTimeout(1500);
  }
  await page.waitForTimeout(1200);
  await page.screenshot({ path: `${OUT}/${name}.png`, fullPage });
  console.log(`  ✓ ${name}.png  ${path}  ${width}x${height}`);
  await ctx.close();
}

await shot("01-landing-desktop", "/", 1440, 900);
await shot("02-landing-mobile", "/", 390, 844);
await shot("03-pricing", "/#pricing", 1440, 900, false);
await shot("04-login", "/auth/login/", 1440, 900, false);
await shot("05-signup", "/auth/signup/", 1440, 900, false);
await shot("06-dashboard-redirect", "/app/", 1440, 900, false);
await shot("07-system-check", "/system-check/", 1440, 1000);

await browser.close();
