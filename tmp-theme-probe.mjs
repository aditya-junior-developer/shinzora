import { chromium } from "playwright-core";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";

const REPO = "/home/user/shinzora";
const PUB = path.join(REPO, "public");
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml" };

const probe = `<!doctype html><html data-theme="midnight" data-tone="dark"><head><meta charset="utf-8">
<link rel="stylesheet" href="/css/tokens.css"><link rel="stylesheet" href="/css/components.css">
<link rel="stylesheet" href="/css/app.css"><link rel="stylesheet" href="/css/views.css">
<link rel="stylesheet" href="/css/theme-light.css"></head><body>
<div class="rail-tip is-visible">Domains</div>
<div class="chat-shell"></div>
<div class="drawer is-open"></div>
<div class="sidebar-link">Community</div>
</body></html>`;

const server = http.createServer((req, res) => {
  const url = req.url.split("?")[0];
  if (url === "/themes.html") {
    res.writeHead(200, { "content-type": "text/html" });
    return res.end(probe);
  }
  for (const file of [path.join(PUB, url), path.join(REPO, url)]) {
    if (fs.existsSync(file) && fs.statSync(file).isFile()) {
      res.writeHead(200, { "content-type": MIME[path.extname(file)] || "application/octet-stream" });
      return res.end(fs.readFileSync(file));
    }
  }
  res.writeHead(404);
  res.end("no");
}).listen(4207, "0.0.0.0");

const browser = await chromium.launch({ args: ["--no-sandbox"] });
const page = await browser.newPage({ viewport: { width: 1180, height: 800 } });
await page.goto("http://127.0.0.1:4207/themes.html");

const out = await page.evaluate(async () => {
  const { THEMES, toneOf } = await import("/js/ui/theme.js");
  const parse = (c) => c.match(/[\d.]+/g).slice(0, 3).map(Number);
  const lum = (rgb) => {
    const [r, g, b] = rgb.map((v) => {
      v /= 255;
      return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const ratio = (a, b) => {
    const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
    return +((x + 0.05) / (y + 0.05)).toFixed(2);
  };
  const rows = [];
  for (const theme of THEMES) {
    document.documentElement.dataset.theme = theme.id;
    document.documentElement.dataset.tone = toneOf(theme.id);
    const tip = document.querySelector(".rail-tip");
    const cs = getComputedStyle(tip);
    const tipBg = parse(cs.backgroundColor);
    const tipFg = parse(cs.color);
    const shell = getComputedStyle(document.querySelector(".chat-shell")).backgroundColor;
    const drawer = getComputedStyle(document.querySelector(".drawer")).backgroundColor;
    const body = parse(getComputedStyle(document.body).backgroundColor);
    rows.push({
      theme: theme.id,
      tone: toneOf(theme.id),
      tipContrast: ratio(tipFg, tipBg),
      tipBackgroundIsDark: lum(tipBg) < 0.2,
      shellContrast: ratio(parse(shell), body),
      drawerContrast: ratio(parse(drawer), body)
    });
  }
  return rows;
});

await browser.close();
server.close();
console.log(JSON.stringify(out, null, 1));
