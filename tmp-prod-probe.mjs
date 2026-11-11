import { chromium } from "playwright-core";
const b = await chromium.launch({ args: ["--no-sandbox"] });
const pages = ["/", "/community", "/app/", "/login", "/settings"];
const out = [];
for (const p of pages) {
  for (const w of [1180, 390]) {
    const pg = await b.newPage({ viewport: { width: w, height: 820 } });
    const errs = [], bad = [];
    pg.on("pageerror", (e) => errs.push(String(e).slice(0, 160)));
    pg.on("response", (r) => { if (r.status() >= 400) bad.push(r.status() + " " + r.url().slice(0, 90)); });
    let status = 0;
    try {
      const resp = await pg.goto("https://shinzora.vercel.app" + p, { waitUntil: "networkidle", timeout: 45000 });
      status = resp?.status();
      await pg.waitForTimeout(1200);
    } catch (e) { errs.push("goto: " + String(e).slice(0, 80)); }
    const info = await pg.evaluate(() => ({
      title: document.title,
      h1: document.querySelector("h1")?.textContent.trim().slice(0, 60) || null,
      bodyText: (document.body.innerText || "").replace(/\s+/g, " ").slice(0, 120),
      overflow: document.documentElement.scrollWidth - window.innerWidth,
    }));
    out.push({ path: p, w, status, ...info, errs: errs.slice(0, 3), bad: bad.slice(0, 3) });
    await pg.close();
  }
}
await b.close();
console.log(JSON.stringify(out, null, 1));
