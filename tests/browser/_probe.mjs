import { readFileSync, writeFileSync } from "node:fs";
let src = readFileSync("tests/browser/mobile-views.mjs", "utf8");
src = src.replace(/    const result = await page\.evaluate\(MEASURE\);/, `
    const probe = await page.evaluate(() => {
      const vw = document.documentElement.clientWidth;
      const out = [];
      for (const n of document.querySelectorAll("#view-root .btn, #view-root button")) {
        const b = n.getBoundingClientRect();
        if (b.right > vw + 1) out.push({ text: String(n.textContent||"").trim().slice(0,30), w: Math.round(b.width), right: Math.round(b.right), parent: n.parentElement.className.slice(0,40), pw: Math.round(n.parentElement.getBoundingClientRect().width) });
      }
      return out;
    });
    console.log("PROBE", JSON.stringify(probe));
    const result = await page.evaluate(MEASURE);`);
writeFileSync("tests/browser/_probe-run.mjs", src);
