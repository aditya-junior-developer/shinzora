#!/usr/bin/env node
/**
 * Shinzora — package the source project
 * ---------------------------------------------------------------------------
 * Produces a ZIP of the complete source (frontend, migrations, functions,
 * docs, config) while excluding anything that should never ship: local
 * environment files, generated runtime config, node_modules, editor state and
 * previous archives.
 *
 * No external dependencies beyond `zip`. Usage:  node scripts/package.mjs [output]
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
const NAME = `shinzora-${pkg.version}`;
const OUTPUT = path.resolve(process.argv[2] || path.join(path.dirname(ROOT), `${NAME}.zip`));

/* `.backups` holds real customer data and provider credentials from db-backup.mjs.
   It must never be packaged, whatever the working copy looks like. */
const SKIP_DIRS = new Set(["node_modules", ".git", "coverage", "test-results", "dist", "build", ".cache", ".vercel", ".tmp", ".backups", ".prelaunch"]);
const SKIP_FILES = new Set([".DS_Store", "Thumbs.db", "public/js/config/runtime.js", "public/js/runtime.js"]);

function shouldSkip(source) {
  const relative = path.relative(ROOT, source);
  if (!relative) return false;
  const base = path.basename(source);
  if (SKIP_DIRS.has(base)) return true;
  if (SKIP_FILES.has(relative.split(path.sep).join("/"))) return true;
  if (relative === ".env" || /^\.env\.(?!example$)/.test(relative)) return true;
  if (relative.endsWith(".zip") || relative.endsWith(".log")) return true;
  if (relative.startsWith("supabase/.temp") || relative.startsWith("supabase/.branches")) return true;
  /* Pre-launch sandbox data: seeded test rows, uploads and the monitor log.
     It is generated on first run, not shipped. */
  if (relative.split(path.sep).join("/").startsWith(".prelaunch")) return true;
  return false;
}

const stageRoot = fs.mkdtempSync(path.join(ROOT, "..", ".shinzora-package-"));
const staged = path.join(stageRoot, NAME);

try {
  // `filter` returns true to INCLUDE an entry, so the predicate is inverted here.
  fs.cpSync(ROOT, staged, { recursive: true, filter: (source) => !shouldSkip(source) });

  if (fs.existsSync(OUTPUT)) fs.rmSync(OUTPUT, { force: true });

  execFileSync("zip", ["-r", "-q", OUTPUT, NAME], { cwd: stageRoot, stdio: "inherit" });

  const stats = fs.statSync(OUTPUT);
  const listing = execFileSync("unzip", ["-l", OUTPUT], { encoding: "utf8" }).trim().split("\n");
  const summary = listing[listing.length - 2] || "";

  const counts = {
    modules: countFiles(staged, (file) => file.endsWith(".js")),
    pages: countFiles(staged, (file) => file.endsWith(".html")),
    styles: countFiles(staged, (file) => file.endsWith(".css")),
    sql: countFiles(staged, (file) => file.endsWith(".sql")),
    functions: fs.readdirSync(path.join(staged, "supabase", "functions"), { withFileTypes: true }).filter((entry) => entry.isDirectory()).length
  };

  console.log("");
  console.log(`  ✓ ${path.basename(OUTPUT)}  (${(stats.size / 1024 / 1024).toFixed(2)} MB)`);
  console.log(`    ${summary.trim()}`);
  console.log(
    `    ${counts.pages} pages · ${counts.modules} JS modules · ${counts.styles} stylesheets · ${counts.sql} migrations · ${counts.functions} edge function dirs`
  );
  console.log(`    ${OUTPUT}`);
  console.log("");
} finally {
  fs.rmSync(stageRoot, { recursive: true, force: true });
}

function countFiles(dir, predicate) {
  let total = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules") continue;
      total += countFiles(full, predicate);
    } else if (predicate(full)) {
      total += 1;
    }
  }
  return total;
}
