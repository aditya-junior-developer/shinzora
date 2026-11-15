/* ==========================================================================
   Investor deck PDF writer (P9) — pure, no browser or database
     - the file is a real PDF: header, cross-reference table, trailer, EOF
     - every cross-reference offset points at the object it names
     - one page per slide, capped at twelve
     - text is escaped, non-WinAnsi characters are replaced, Rs. replaces the
       rupee sign, and long text wraps inside the page
     - an empty deck is refused rather than exported
   ========================================================================== */

import { buildDeckPdf, pdfText, wrap, normaliseSlides, MAX_SLIDES, MAX_BULLETS } from "../supabase/functions/_shared/deck-pdf.js";
import { mkdirSync, writeFileSync } from "node:fs";

let pass = 0;
let fail = 0;
const check = (name, cond, extra = "") =>
  cond ? (pass++, console.log(`  ✓ ${name}`)) : (fail++, console.log(`  ✗ ${name}${extra ? ` — ${extra}` : ""}`));

const decode = (bytes) => Buffer.from(bytes).toString("latin1");

const SLIDES = [
  { title: "Olive Roasters", bullets: ["Small batch coffee for offices", "Founded in Faridabad"] },
  { title: "The problem", bullets: ["Office coffee is stale", "Teams pay too much for it"] },
  { title: "The ask", bullets: ["Raise to open a second roastery"] }
];

console.log("the file is a PDF");
const pdf = buildDeckPdf({ title: "Seed round", slides: SLIDES });
const text = decode(pdf);
check("starts with the PDF header", text.startsWith("%PDF-1.4\n"));
check("ends with the end-of-file marker", /%%EOF\n$/.test(text));
check("one page per slide", (text.match(/\/Type \/Page /g) || []).length === SLIDES.length, `pages: ${(text.match(/\/Type \/Page /g) || []).length}`);
check("the page tree counts the pages", text.includes(`/Count ${SLIDES.length}`));

const startxref = Number(text.match(/startxref\n(\d+)\n%%EOF/)?.[1]);
check("startxref points at the xref table", text.slice(startxref, startxref + 4) === "xref");

const xrefBlock = text.slice(startxref).split("\n");
const entries = xrefBlock.filter((line) => / [nf] $/.test(line));
let offsetsOk = entries.length > 0;
let badEntry = "";
entries.forEach((line, id) => {
  if (id === 0 || !line.endsWith(" n ")) return;
  const offset = Number(line.slice(0, 10));
  const head = text.slice(offset, offset + 12);
  if (!head.startsWith(`${id} 0 obj`)) {
    offsetsOk = false;
    badEntry = `object ${id} at ${offset} starts "${head}"`;
  }
});
check("every cross-reference offset points at its object", offsetsOk, badEntry);

console.log("text");
check("the rupee sign is written as Rs.", decode(buildDeckPdf({ title: "T", slides: [{ title: "Price", bullets: ["\u20B920 per export"] }] })).includes("Rs. 20 per export"));
check("brackets and backslashes are escaped", pdfText("a (b) \\ c") === "a \\(b\\) \\\\ c", pdfText("a (b) \\ c"));
check("a Latin-1 accent is encoded in WinAnsi octal", pdfText("Café") === "Caf\\351", pdfText("Café"));
check("a character with no WinAnsi form becomes a question mark", pdfText("A\u4E2D") === "A?", pdfText("A\u4E2D"));
check("curly quotes and dashes become plain ASCII", pdfText("\u201Cnote\u201D \u2013 done") === '"note" - done', pdfText("\u201Cnote\u201D \u2013 done"));

const long = "This is a long sentence about the business that must wrap across more than one line on the slide so it stays inside the page margins. ".repeat(3);
const lines = wrap(long, 16, 700);
check("long text wraps into several lines", lines.length > 2, `lines: ${lines.length}`);
check("no wrapped line is longer than the width allows", lines.every((line) => line.length * 8 <= 700 + 8));

const positions = [...decode(buildDeckPdf({ title: "Wrap", slides: [{ title: "Long", bullets: [long, long] }] })).matchAll(/ (\d+(?:\.\d+)?) Td/g)].map((m) => Number(m[1]));
check("every line sits above the bottom margin and inside the page", positions.length > 0 && positions.every((y) => y >= 20 && y <= 595), `min y ${Math.min(...positions)}`);

console.log("limits");
const many = Array.from({ length: 20 }, (_, i) => ({ title: `Slide ${i + 1}`, bullets: ["x"] }));
const capped = decode(buildDeckPdf({ title: "Many", slides: many }));
check(`a deck is capped at ${MAX_SLIDES} pages`, (capped.match(/\/Type \/Page /g) || []).length === MAX_SLIDES);
const bulletsCut = normaliseSlides([{ title: "B", bullets: Array.from({ length: 12 }, (_, i) => `point ${i}`) }]);
check(`a slide keeps at most ${MAX_BULLETS} bullets`, bulletsCut[0].bullets.length === MAX_BULLETS);
check("a missing title becomes Untitled", normaliseSlides([{ bullets: [] }])[0].title === "Untitled");
check("an empty deck is refused", (() => { try { buildDeckPdf({ title: "Empty", slides: [] }); return false; } catch { return true; } })());
check("a deck that is not a list is refused", (() => { try { buildDeckPdf({ title: "Bad", slides: "nope" }); return false; } catch { return true; } })());
check("the same deck always gives the same bytes", Buffer.compare(Buffer.from(buildDeckPdf({ title: "Seed round", slides: SLIDES })), Buffer.from(pdf)) === 0);

// A sample for an independent reader to open; kept out of the repo.
mkdirSync("/tmp/deck-check", { recursive: true });
writeFileSync("/tmp/deck-check/sample.pdf", Buffer.from(pdf));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
