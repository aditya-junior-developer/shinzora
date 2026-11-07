#!/usr/bin/env node
/* ==========================================================================
   Shinzora — brand logo ingest
   --------------------------------------------------------------------------
   The product ships with an SVG mark so it renders with zero requests. When
   the official `logo.png` is supplied, this script turns it into every asset
   the platform needs and points the UI at it — without touching page markup by
   hand and without a single dependency.

     node scripts/brand.mjs            apply (idempotent)
     node scripts/brand.mjs --check    report what is in place, change nothing
     node scripts/brand.mjs --revert   remove every generated asset

   What "apply" does
     · reads logo.png from the repo root, public/assets/brand/, or ../
     · writes optimised derivatives: favicon 16/32, apple-touch 180,
       PWA 192/512, plus a 2x display copy for the in-page mark
     · keeps the aspect ratio, never crops, never stretches: each derivative is
       letterboxed onto a transparent square with a safety margin
     · writes public/css/brand.css, which swaps the SVG mark for the image
     · adds <link rel="stylesheet" href="/css/brand.css"> to every page that
       already loads the component stylesheet (once — re-running is safe)

   PNG support is implemented here rather than pulled in as a dependency: the
   project has no build tooling and should not grow any for this. 8-bit
   RGB/RGBA/greyscale/palette, non-interlaced — which is what a designer's
   export is. Anything else fails loudly with instructions instead of producing
   a broken icon.
   ========================================================================== */

import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PUBLIC = path.join(ROOT, "public");
const BRAND_DIR = path.join(PUBLIC, "assets", "brand");
const ICON_DIR = path.join(PUBLIC, "assets", "icons");
const BRAND_CSS = path.join(PUBLIC, "css", "brand.css");
/* The shipped PNG icons are overwritten in place so the manifest, favicon and
   apple-touch links keep working without touching any HTML. `--revert` has to
   be able to put them back, so the originals are kept here on first apply. */
const BACKUP_DIR = path.join(ICON_DIR, "_original");

const MODE = process.argv.includes("--revert")
  ? "revert"
  : process.argv.includes("--check")
    ? "check"
    : "apply";

/* -------------------------------------------------------------------------- */
/* Minimal PNG codec                                                          */
/* -------------------------------------------------------------------------- */

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([length, body, crc]);
}

function decodePng(buffer) {
  if (!buffer.subarray(0, 8).equals(PNG_SIG)) throw new Error("Not a PNG file.");

  let offset = 8;
  let ihdr = null;
  let palette = null;
  let transparency = null;
  const idat = [];

  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString("ascii", offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      ihdr = {
        width: data.readUInt32BE(0),
        height: data.readUInt32BE(4),
        depth: data[8],
        colorType: data[9],
        interlace: data[12]
      };
    } else if (type === "PLTE") palette = Buffer.from(data);
    else if (type === "tRNS") transparency = Buffer.from(data);
    else if (type === "IDAT") idat.push(Buffer.from(data));
    else if (type === "IEND") break;
    offset += 12 + length;
  }

  if (!ihdr) throw new Error("PNG has no IHDR chunk.");
  if (ihdr.depth !== 8) throw new Error(`PNG bit depth ${ihdr.depth} is not supported — export at 8 bits per channel.`);
  if (ihdr.interlace !== 0) throw new Error("Interlaced PNGs are not supported — re-export without interlacing.");

  const channelsByType = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
  const channels = channelsByType[ihdr.colorType];
  if (!channels) throw new Error(`PNG colour type ${ihdr.colorType} is not supported.`);

  const raw = zlib.inflateSync(Buffer.concat(idat));
  const { width, height } = ihdr;
  const stride = width * channels;
  const out = Buffer.alloc(width * height * 4);

  let pos = 0;
  let prev = Buffer.alloc(stride);

  for (let y = 0; y < height; y += 1) {
    const filter = raw[pos];
    pos += 1;
    const line = Buffer.from(raw.subarray(pos, pos + stride));
    pos += stride;

    for (let i = 0; i < stride; i += 1) {
      const a = i >= channels ? line[i - channels] : 0;
      const b = prev[i];
      const c = i >= channels ? prev[i - channels] : 0;
      switch (filter) {
        case 0: break;
        case 1: line[i] = (line[i] + a) & 0xff; break;
        case 2: line[i] = (line[i] + b) & 0xff; break;
        case 3: line[i] = (line[i] + ((a + b) >> 1)) & 0xff; break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a);
          const pb = Math.abs(p - b);
          const pc = Math.abs(p - c);
          const pred = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
          line[i] = (line[i] + pred) & 0xff;
          break;
        }
        default: throw new Error(`Unknown PNG filter ${filter} on row ${y}.`);
      }
    }
    prev = line;

    for (let x = 0; x < width; x += 1) {
      const s = x * channels;
      const d = (y * width + x) * 4;
      if (ihdr.colorType === 0) {
        out[d] = line[s];
        out[d + 1] = line[s];
        out[d + 2] = line[s];
        out[d + 3] = 255;
      } else if (ihdr.colorType === 4) {
        out[d] = line[s];
        out[d + 1] = line[s];
        out[d + 2] = line[s];
        out[d + 3] = line[s + 1];
      } else if (ihdr.colorType === 3) {
        const idx = line[s] * 3;
        out[d] = palette[idx];
        out[d + 1] = palette[idx + 1];
        out[d + 2] = palette[idx + 2];
        out[d + 3] = transparency && transparency[line[s]] !== undefined ? transparency[line[s]] : 255;
      } else if (ihdr.colorType === 2) {
        out[d] = line[s];
        out[d + 1] = line[s + 1];
        out[d + 2] = line[s + 2];
        out[d + 3] = 255;
      } else {
        out[d] = line[s];
        out[d + 1] = line[s + 1];
        out[d + 2] = line[s + 2];
        out[d + 3] = line[s + 3];
      }
    }
  }

  return { width, height, data: out };
}

function encodePng(image) {
  const { width, height, data } = image;
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);

  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0; // filter: none
    data.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  return Buffer.concat([
    PNG_SIG,
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0))
  ]);
}

/* -------------------------------------------------------------------------- */
/* Resampling                                                                 */
/* -------------------------------------------------------------------------- */

/** Bilinear sample with premultiplied alpha, so transparent edges don't darken. */
function sampleBilinear(image, fx, fy) {
  const { width, height, data } = image;
  const x0 = Math.min(width - 1, Math.max(0, Math.floor(fx)));
  const y0 = Math.min(height - 1, Math.max(0, Math.floor(fy)));
  const x1 = Math.min(width - 1, x0 + 1);
  const y1 = Math.min(height - 1, y0 + 1);
  const tx = fx - x0;
  const ty = fy - y0;

  const at = (x, y) => {
    const i = (y * width + x) * 4;
    const a = data[i + 3] / 255;
    return [data[i] * a, data[i + 1] * a, data[i + 2] * a, a];
  };

  const p00 = at(x0, y0);
  const p10 = at(x1, y0);
  const p01 = at(x0, y1);
  const p11 = at(x1, y1);

  const mix = (a, b, t) => a + (b - a) * t;
  const r = mix(mix(p00[0], p10[0], tx), mix(p01[0], p11[0], tx), ty);
  const g = mix(mix(p00[1], p10[1], tx), mix(p01[1], p11[1], tx), ty);
  const b = mix(mix(p00[2], p10[2], tx), mix(p01[2], p11[2], tx), ty);
  const a = mix(mix(p00[3], p10[3], tx), mix(p01[3], p11[3], tx), ty);

  if (a <= 0) return [0, 0, 0, 0];
  return [r / a, g / a, b / a, a];
}

/**
 * Fit the logo inside a square of `size` px with `padding` (fraction) of safe
 * space. Aspect ratio is preserved; nothing is cropped or stretched.
 */
function fitSquare(image, size, padding = 0.08) {
  const out = Buffer.alloc(size * size * 4);
  const usable = size * (1 - padding * 2);
  const scale = Math.min(usable / image.width, usable / image.height);
  const drawW = image.width * scale;
  const drawH = image.height * scale;
  const offsetX = (size - drawW) / 2;
  const offsetY = (size - drawH) / 2;

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const sx = (x - offsetX) / scale;
      const sy = (y - offsetY) / scale;
      const d = (y * size + x) * 4;
      if (sx < 0 || sy < 0 || sx >= image.width || sy >= image.height) continue;
      const [r, g, b, a] = sampleBilinear(image, sx, sy);
      out[d] = Math.round(r);
      out[d + 1] = Math.round(g);
      out[d + 2] = Math.round(b);
      out[d + 3] = Math.round(a * 255);
    }
  }

  return { width: size, height: size, data: out };
}

/* -------------------------------------------------------------------------- */
/* Locating the source                                                        */
/* -------------------------------------------------------------------------- */

const CANDIDATES = [
  path.join(ROOT, "logo.png"),
  path.join(BRAND_DIR, "logo.png"),
  path.join(ROOT, "..", "logo.png"),
  path.join(ROOT, "brand", "logo.png")
];

function findSource() {
  for (const candidate of CANDIDATES) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

/* -------------------------------------------------------------------------- */
/* Applying                                                                   */
/* -------------------------------------------------------------------------- */

const DERIVATIVES = [
  { file: path.join(ICON_DIR, "favicon-16.png"), size: 16, padding: 0.04 },
  { file: path.join(ICON_DIR, "favicon-32.png"), size: 32, padding: 0.04 },
  { file: path.join(ICON_DIR, "apple-touch-icon.png"), size: 180, padding: 0.14 },
  { file: path.join(ICON_DIR, "icon-192.png"), size: 192, padding: 0.14 },
  { file: path.join(ICON_DIR, "icon-512.png"), size: 512, padding: 0.14 },
  { file: path.join(BRAND_DIR, "mark-64.png"), size: 64, padding: 0.06 },
  { file: path.join(BRAND_DIR, "mark-128.png"), size: 128, padding: 0.06 }
];

const BRAND_CSS_BODY = `/* Generated by scripts/brand.mjs — do not edit by hand.
   Replaces the built-in SVG mark with the official logo image. Removing this
   file (or running \`node scripts/brand.mjs --revert\`) restores the SVG. */

.brand-mark {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  background: url("/assets/brand/mark-64.png") center / contain no-repeat;
}

/* The inline SVG stays in the DOM as a fallback for the moment before the
   image loads; hide it only once the image is available. */
.brand-mark > svg {
  width: 100%;
  height: 100%;
  opacity: 0;
}

.brand-mark--lg {
  width: 52px;
  height: 52px;
}

/* Header/footer wordmarks keep their existing type; only the mark changes. */
.admin-brand .brand-mark,
.admin-login-card .brand-mark {
  width: 26px;
  height: 26px;
}

@media (max-width: 560px) {
  .brand-mark { width: 26px; height: 26px; }
}
`;

function findPages(dir = PUBLIC, acc = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "vendor" || entry.name === "assets") continue;
      findPages(full, acc);
    } else if (entry.name.endsWith(".html")) {
      acc.push(full);
    }
  }
  return acc;
}

const LINK_TAG = '<link rel="stylesheet" href="/css/brand.css" />';

function apply() {
  const source = findSource();
  if (!source) {
    console.error("\n  ✗ No logo.png found.\n");
    console.error("    Put the official logo at one of:");
    for (const candidate of CANDIDATES) console.error(`      ${path.relative(ROOT, candidate) || candidate}`);
    console.error("\n    Then run:  node scripts/brand.mjs\n");
    process.exit(1);
  }

  const image = decodePng(fs.readFileSync(source));
  console.log(`\n  Source  ${path.relative(ROOT, source)}  ${image.width}×${image.height}px`);

  fs.mkdirSync(BRAND_DIR, { recursive: true });
  fs.mkdirSync(ICON_DIR, { recursive: true });

  /* First apply only: keep the icons that ship with the product. */
  const existing = DERIVATIVES.filter((d) => path.dirname(d.file) === ICON_DIR && fs.existsSync(d.file));
  if (existing.length && !fs.existsSync(BACKUP_DIR)) {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    for (const derivative of existing) {
      fs.copyFileSync(derivative.file, path.join(BACKUP_DIR, path.basename(derivative.file)));
    }
    console.log(`  · backed up ${existing.length} shipped icon(s) to ${path.relative(ROOT, BACKUP_DIR)}`);
  }

  fs.copyFileSync(source, path.join(BRAND_DIR, "logo.png"));

  for (const derivative of DERIVATIVES) {
    const resized = fitSquare(image, derivative.size, derivative.padding);
    fs.writeFileSync(derivative.file, encodePng(resized));
    console.log(`  · ${path.relative(ROOT, derivative.file)}  ${derivative.size}×${derivative.size}`);
  }

  fs.writeFileSync(BRAND_CSS, BRAND_CSS_BODY);
  console.log(`  · ${path.relative(ROOT, BRAND_CSS)}`);

  let patched = 0;
  for (const page of findPages()) {
    const html = fs.readFileSync(page, "utf8");
    if (html.includes("/css/brand.css")) continue;
    /* Insert after the design tokens so the override always wins. */
    const anchor = /<link rel="stylesheet" href="\/css\/tokens\.css"[^>]*>/;
    if (!anchor.test(html)) continue;
    fs.writeFileSync(page, html.replace(anchor, (m) => `${m}\n  ${LINK_TAG}`));
    patched += 1;
  }
  console.log(`  · ${patched} page(s) linked to brand.css`);

  console.log("\n  ✓ Logo applied. The SVG mark remains as the pre-load fallback.\n");
}

function revert() {
  const removed = [];

  if (fs.existsSync(BRAND_CSS)) {
    fs.unlinkSync(BRAND_CSS);
    removed.push(path.relative(ROOT, BRAND_CSS));
  }

  /* Restore the icons that shipped with the product, then remove anything this
     script generated that had no original. */
  if (fs.existsSync(BACKUP_DIR)) {
    for (const name of fs.readdirSync(BACKUP_DIR)) {
      fs.copyFileSync(path.join(BACKUP_DIR, name), path.join(ICON_DIR, name));
      removed.push(`restored ${name}`);
    }
    fs.rmSync(BACKUP_DIR, { recursive: true, force: true });
  }

  for (const derivative of DERIVATIVES) {
    if (!fs.existsSync(derivative.file)) continue;
    const restored = fs.readdirSync(ICON_DIR).includes(path.basename(derivative.file)) &&
      removed.some((entry) => entry === `restored ${path.basename(derivative.file)}`);
    if (!restored) {
      fs.unlinkSync(derivative.file);
      removed.push(path.relative(ROOT, derivative.file));
    }
  }

  if (fs.existsSync(BRAND_DIR)) fs.rmSync(BRAND_DIR, { recursive: true, force: true });

  let unlinked = 0;
  for (const page of findPages()) {
    const html = fs.readFileSync(page, "utf8");
    if (!html.includes("/css/brand.css")) continue;
    fs.writeFileSync(page, html.replace(/[ \t]*<link rel="stylesheet" href="\/css\/brand\.css" \/>\n?/g, ""));
    unlinked += 1;
  }

  console.log(`\n  Reverted: ${removed.length} file change(s) undone, ${unlinked} page(s) unlinked.`);
  console.log("  The shipped SVG mark and the original PNG icons are back in place.\n");
}

function check() {
  const source = findSource();
  const present = DERIVATIVES.filter((d) => fs.existsSync(d.file)).length;
  const pages = findPages();
  const linked = pages.filter((p) => fs.readFileSync(p, "utf8").includes("/css/brand.css")).length;

  console.log("\n  Brand assets\n");
  console.log(`  source logo.png    ${source ? path.relative(ROOT, source) : "not found"}`);
  console.log(`  derivatives        ${present}/${DERIVATIVES.length}`);
  console.log(`  pages on brand.css ${linked}/${pages.length}`);
  console.log(
    source && present === DERIVATIVES.length
      ? "\n  ✓ The official logo is applied.\n"
      : "\n  · Still using the built-in SVG mark.\n"
  );
}

if (MODE === "apply") apply();
else if (MODE === "revert") revert();
else check();
