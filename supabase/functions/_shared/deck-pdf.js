/* ==========================================================================
   Investor deck PDF (P9)
   A small, dependency-free PDF writer for a slide deck. Each slide is one
   A4 landscape page. Text uses the standard Helvetica faces, so no font file
   is embedded and the output works in every PDF reader.

   Plain ES module with no platform imports: the Edge Function imports it under
   Deno, and tests/deck-pdf.test.mjs imports it under Node.

   Limits, enforced here as well as in the database:
     - at most 12 slides (the deck table allows no more)
     - a title and up to 6 bullets per slide, each cut to a safe length
   ========================================================================== */

export const MAX_SLIDES = 12;
export const MAX_BULLETS = 6;
const PAGE_W = 842;
const PAGE_H = 595;
const MARGIN = 56;
const ACCENT = [0.38, 0.27, 0.96]; // Shinzora violet

/* Standard PDF text is WinAnsi. Anything outside it becomes a close stand-in
   or "?", so a name with a rare glyph still produces a readable file. */
const SWAPS = {
  "\u20B9": "Rs. ",
  "\u2018": "'",
  "\u2019": "'",
  "\u201C": '"',
  "\u201D": '"',
  "\u2013": "-",
  "\u2014": "-",
  "\u2026": "...",
  "\u2022": "\u2022",
  "\u00A0": " "
};

/** Encode one string as a PDF literal string body, ASCII only. */
export function pdfText(input) {
  let out = "";
  for (const ch of String(input ?? "")) {
    const swapped = SWAPS[ch] ?? ch;
    for (const c of swapped) {
      const code = c.codePointAt(0);
      if (c === "\\" || c === "(" || c === ")") out += `\\${c}`;
      else if (code >= 0x20 && code <= 0x7e) out += c;
      else if (c === "\u2022") out += "\\225"; // WinAnsi bullet
      else if (code >= 0xa0 && code <= 0xff) out += `\\${code.toString(8).padStart(3, "0")}`;
      else if (code === 0x0a || code === 0x0d || code === 0x09) out += " ";
      else out += "?";
    }
  }
  return out;
}

/* Helvetica metrics vary by glyph; an average of 0.5 em is a safe estimate for
   wrapping and errs narrow rather than letting a line run off the page. */
const charWidth = (size) => size * 0.5;

/** Break text into lines no wider than maxWidth points at this size. */
export function wrap(text, size, maxWidth) {
  const perLine = Math.max(8, Math.floor(maxWidth / charWidth(size)));
  const words = String(text ?? "").replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
  const lines = [];
  let line = "";
  for (const word of words) {
    let rest = word;
    while (rest.length > perLine) {
      if (line) {
        lines.push(line);
        line = "";
      }
      lines.push(rest.slice(0, perLine));
      rest = rest.slice(perLine);
    }
    const candidate = line ? `${line} ${rest}` : rest;
    if (candidate.length > perLine) {
      lines.push(line);
      line = rest;
    } else {
      line = candidate;
    }
  }
  if (line) lines.push(line);
  return lines.length ? lines : [""];
}

/** Clean a slide from untrusted input. Never throws on odd shapes. */
export function normaliseSlides(slides) {
  if (!Array.isArray(slides)) return [];
  return slides.slice(0, MAX_SLIDES).map((slide) => {
    const title = String(slide?.title ?? "").slice(0, 120).trim() || "Untitled";
    const bullets = Array.isArray(slide?.bullets)
      ? slide.bullets
          .map((b) => String(b ?? "").slice(0, 220).trim())
          .filter(Boolean)
          .slice(0, MAX_BULLETS)
      : [];
    return { title, bullets };
  });
}

/** Lay out one slide as a list of drawing operations for its content stream. */
function layoutSlide(slide, index, total, cover) {
  const ops = [];
  const contentW = PAGE_W - MARGIN * 2;

  ops.push(`${ACCENT.join(" ")} rg 0 ${PAGE_H - 10} ${PAGE_W} 10 re f`);

  let y = cover ? PAGE_H * 0.58 : PAGE_H - MARGIN - 40;
  const titleSize = cover ? 40 : 28;
  const titleLines = wrap(slide.title, titleSize, contentW);
  for (const line of titleLines) {
    ops.push(`${ACCENT.join(" ")} rg BT /F2 ${titleSize} Tf ${MARGIN} ${y} Td (${pdfText(line)}) Tj ET`);
    y -= titleSize * 1.2;
  }

  // Bullet text shrinks when a slide is full, so nothing runs off the bottom.
  const lineCount = slide.bullets.reduce((n, b) => n + wrap(b, 16, contentW - 22).length, 0);
  const bodySize = lineCount > 13 ? 12 : lineCount > 10 ? 14 : 16;
  const lineHeight = bodySize * 1.45;
  y -= cover ? 16 : 22;
  for (const bullet of slide.bullets) {
    const lines = wrap(bullet, bodySize, contentW - 22);
    lines.forEach((line, i) => {
      if (y < MARGIN + 20) return;
      if (i === 0) {
        ops.push(`0.12 0.12 0.16 rg BT /F1 ${bodySize} Tf ${MARGIN} ${y} Td (\\225) Tj ET`);
      }
      ops.push(`0.12 0.12 0.16 rg BT /F1 ${bodySize} Tf ${MARGIN + 22} ${y} Td (${pdfText(line)}) Tj ET`);
      y -= lineHeight;
    });
    y -= 4;
  }

  ops.push(`0.45 0.45 0.5 rg BT /F1 9 Tf ${MARGIN} 26 Td (${pdfText(`Shinzora  -  ${index + 1} of ${total}`)}) Tj ET`);
  return ops.join("\n");
}

/**
 * Build a PDF for a deck. Returns the bytes as a Uint8Array.
 * Throws when there are no slides, so an empty deck is never exported.
 */
export function buildDeckPdf({ title, slides }) {
  const clean = normaliseSlides(slides);
  if (!clean.length) throw new Error("A deck needs at least one slide before it can be exported.");

  const pageCount = clean.length;
  // Object numbers: 1 catalog, 2 pages, 3 regular font, 4 bold font, 5 info,
  // then a page object and a content object for each slide.
  const objects = [];
  const pageIds = [];
  const FIRST_PAGE = 6;

  clean.forEach((slide, i) => {
    const pageId = FIRST_PAGE + i * 2;
    const contentId = pageId + 1;
    pageIds.push(pageId);
    const stream = layoutSlide(slide, i, pageCount, i === 0);
    objects[pageId] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${contentId} 0 R >>`;
    objects[contentId] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  });

  objects[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  objects[2] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pageCount} >>`;
  objects[3] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>";
  objects[4] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>";
  const docTitle = pdfText(String(title || "Investor deck").slice(0, 120));
  objects[5] = `<< /Title (${docTitle}) /Producer (Shinzora) >>`;

  const maxId = objects.length - 1;
  let body = "%PDF-1.4\n%\u00e2\u00e3\u00cf\u00d3\n";
  const offsets = [];
  for (let id = 1; id <= maxId; id += 1) {
    offsets[id] = body.length;
    body += `${id} 0 obj\n${objects[id]}\nendobj\n`;
  }
  const xref = body.length;
  let table = `xref\n0 ${maxId + 1}\n0000000000 65535 f \n`;
  for (let id = 1; id <= maxId; id += 1) {
    table += `${String(offsets[id]).padStart(10, "0")} 00000 n \n`;
  }
  body += table;
  body += `trailer\n<< /Size ${maxId + 1} /Root 1 0 R /Info 5 0 R >>\nstartxref\n${xref}\n%%EOF\n`;

  // The body is ASCII throughout (every string was escaped above), so one byte
  // per character is exact. The header's binary comment is the only non-ASCII
  // part and it is written as its Latin-1 bytes, which is what PDF readers expect.
  const bytes = new Uint8Array(body.length);
  for (let i = 0; i < body.length; i += 1) bytes[i] = body.charCodeAt(i) & 0xff;
  return bytes;
}
