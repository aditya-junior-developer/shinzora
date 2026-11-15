/* ==========================================================================
   Shinzora — compare two measure.mjs result files
   --------------------------------------------------------------------------
     node tests/perf/compare.mjs pre-opt-full p1-full-a
     node tests/perf/compare.mjs pre-opt-full p1-full-a --markdown > report.md

   Reads tests/perf/results/<label>.json for both labels and prints, per page,
   the median values before and after, and the change. Only pages present in
   both files are compared, so partial runs stay honest.
   ========================================================================== */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const [a, b] = process.argv.slice(2).filter((arg) => !arg.startsWith("--"));
const markdown = process.argv.includes("--markdown");

if (!a || !b) {
  console.error("usage: node tests/perf/compare.mjs <before-label> <after-label> [--markdown]");
  process.exit(1);
}

const load = (label) => JSON.parse(fs.readFileSync(path.join(here, "results", `${label}.json`), "utf8"));
const before = load(a);
const after = load(b);

const METRICS = [
  { key: "ready", label: "ready", unit: "ms" },
  { key: "fcp", label: "FCP", unit: "ms" },
  { key: "tbt", label: "TBT", unit: "ms" },
  { key: "bytes", label: "bytes", unit: "kb" },
  { key: "requests", label: "requests", unit: "n" }
];

const fmt = (value, unit) => {
  if (value == null) return "—";
  if (unit === "kb") return `${(value / 1024).toFixed(1)} KB`;
  if (unit === "n") return String(value);
  return `${Math.round(value)} ms`;
};

const delta = (x, y) => {
  if (x == null || y == null || x === 0) return "—";
  const pct = ((y - x) / x) * 100;
  return `${pct > 0 ? "+" : ""}${pct.toFixed(0)}%`;
};

const pages = Object.keys(after.results).filter((id) => before.results[id]);
const rows = [];

for (const id of pages) {
  for (const phase of ["cold", "repeat"]) {
    const x = before.results[id][phase];
    const y = after.results[id][phase];
    for (const metric of METRICS) {
      rows.push({
        page: id,
        phase,
        metric: metric.label,
        before: fmt(x[metric.key], metric.unit),
        after: fmt(y[metric.key], metric.unit),
        change: delta(x[metric.key], y[metric.key])
      });
    }
  }
}

const missing = Object.keys(after.results).filter((id) => !before.results[id]);
const only = Object.keys(before.results).filter((id) => !after.results[id]);

if (markdown) {
  console.log(`# ${a} → ${b}\n`);
  console.log(`Before: ${before.base}, ${before.runs} runs (${before.measuredAt})  `);
  console.log(`After: ${after.base}, ${after.runs} runs (${after.measuredAt})\n`);
  console.log("| page | phase | metric | before | after | change |");
  console.log("|---|---|---|---|---|---|");
  for (const r of rows) console.log(`| ${r.page} | ${r.phase} | ${r.metric} | ${r.before} | ${r.after} | ${r.change} |`);
} else {
  console.log(`${a} → ${b}  (${pages.length} pages in both)\n`);
  for (const r of rows) {
    console.log(
      `${r.page.padEnd(18)}${r.phase.padEnd(8)}${r.metric.padEnd(10)}${r.before.padStart(12)} →${r.after.padStart(12)}  ${r.change.padStart(6)}`
    );
  }
}

if (missing.length) console.error(`\nonly in ${b}: ${missing.join(", ")}`);
if (only.length) console.error(`\nonly in ${a}: ${only.join(", ")}`);
