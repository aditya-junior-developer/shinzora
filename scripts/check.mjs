#!/usr/bin/env node
/**
 * Shinzora — static integrity check
 * ---------------------------------------------------------------------------
 * Runs without dependencies and answers the questions that actually break a
 * hand-written ES-module frontend:
 *
 *   1. does every .js file parse?
 *   2. does every relative import resolve to a file that exists?
 *   3. does every named import exist as an export in the target module?
 *   4. does every <link href> and <script src> in HTML resolve on disk?
 *   5. is there any secret-looking string in public/?
 *   6. do the CSS files referenced by pages exist, and is the cascade order
 *      the documented one?
 *
 * Exit code 1 on failure so it can gate a build.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PUBLIC = path.join(ROOT, "public");

const problems = [];
const notes = [];
const fail = (message) => problems.push(message);

/* --------------------------------------------------------------- file walk */
function walk(dir, filter) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (["node_modules", ".git", "vendor"].includes(entry.name)) continue;
      out.push(...walk(full, filter));
    } else if (filter(full)) {
      out.push(full);
    }
  }
  return out;
}

const jsFiles = walk(PUBLIC, (file) => file.endsWith(".js") && !file.includes("/vendor/"));
const vendorFiles = walk(PUBLIC, (file) => file.endsWith(".js") && file.includes("/vendor/"));
const htmlFiles = walk(PUBLIC, (file) => file.endsWith(".html"));

/* ------------------------------------------------------------ 1. JS parses */
for (const file of [...jsFiles, ...vendorFiles]) {
  // `node --check` parses the file as an ES module (package.json type=module)
  // without executing it. It is the same parser the browser-equivalent build uses.
  const result = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
  if (result.status !== 0) {
    const message = (result.stderr || "").split("\n").filter(Boolean).slice(0, 3).join(" ");
    fail(`Parse error in ${path.relative(ROOT, file)}: ${message}`);
  }
}

/* --------------------------------------------- 2 & 3. imports and exports */
function exportsOf(source) {
  const names = new Set();
  const re =
    /export\s+(?:async\s+)?(?:function|const|let|var|class)\s+([A-Za-z_$][\w$]*)|export\s*\{([^}]*)\}/g;
  let match;
  while ((match = re.exec(source))) {
    if (match[1]) names.add(match[1]);
    if (match[2]) {
      match[2]
        .split(",")
        .map((part) => part.trim().split(/\s+as\s+/)[0].trim())
        .filter(Boolean)
        .forEach((name) => names.add(name));
    }
  }
  if (/export\s+default/.test(source)) names.add("default");
  return names;
}

for (const file of jsFiles) {
  const source = fs.readFileSync(file, "utf8");
  /* Comments are stripped first: a comment that mentions an import statement
     would otherwise be parsed as code, and a bare `import "./x.js"` (a
     side-effect import, perfectly legal) made the old pattern swallow the next
     statement and report a bogus default import. */
  const stripped = source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
  /* `[^;]*?` for the clause is the important part: an import clause can never
     contain a semicolon, so a bare side-effect import above can no longer be
     swallowed into the statement below it. */
  const importRe = /(?:^|[;{}()\s])import\s+([^;]*?)\s+from\s+["']([^"']+)["']/g;
  let match;

  while ((match = importRe.exec(stripped))) {
    const clause = match[1].trim();
    const specifier = match[2];
    if (!specifier.startsWith(".")) {
      fail(`Non-relative import "${specifier}" in ${path.relative(ROOT, file)} — the frontend must be dependency-free.`);
      continue;
    }

    /* A release stamp (`./pwa.js?v=2026…`) is still the same module on disk —
       resolve the path without the query before checking it exists. */
    const bare = specifier.split("?")[0];
    const target = path.resolve(path.dirname(file), bare);
    if (!fs.existsSync(target)) {
      fail(`Missing module ${specifier} imported by ${path.relative(ROOT, file)}`);
      continue;
    }

    const targetExports = exportsOf(fs.readFileSync(target, "utf8"));

    const named = clause.match(/\{([^}]*)\}/);
    if (named) {
      for (const raw of named[1].split(",").map((value) => value.trim()).filter(Boolean)) {
        const name = raw.split(/\s+as\s+/)[0].trim();
        if (!targetExports.has(name)) {
          fail(`${path.relative(ROOT, file)} imports { ${name} } from ${specifier}, but it is not exported.`);
        }
      }
    }

    const defaultBinding = clause.replace(/\{[^}]*\}/, "").replace(/^\*\s+as\s+\w+/, "").replace(/,/g, " ").trim();
    if (defaultBinding && !defaultBinding.startsWith("*") && !targetExports.has("default")) {
      // A bare `import "./x.js"` has an empty clause; anything else expects a default.
      fail(`${path.relative(ROOT, file)} default-imports ${specifier}, which has no default export.`);
    }
  }
}

/* ------------------------- 3b. helpers used but never imported */
/* Analytics shipped calling `on(...)` with only `qs, esc` imported: the page
   loaded, painted its skeleton, then threw "on is not defined" — the whole view
   dead, and no static check noticed because the module still parsed. The shared
   DOM helpers are the ones this actually happens to, so they are checked by
   name: any module that calls one must import it from lib/dom.js. */
{
  const HELPERS = ["qs", "qsa", "esc", "on", "delegate", "debounce", "trapFocus"];
  for (const file of jsFiles) {
    const source = fs.readFileSync(file, "utf8");
    const importRe = /import\s*\{([^}]*)\}\s*from\s*["'][^"']*lib\/dom\.js["']/g;
    const chunks = [...source.matchAll(importRe)];
    if (!chunks.length) continue;
    const imported = new Set();
    for (const chunk of chunks) {
      for (const part of chunk[1].split(",")) {
        const name = part.trim().split(/\s+as\s+/)[0].trim();
        if (name) imported.add(name);
      }
    }
    const body = source;
    for (const helper of HELPERS) {
      const calls = new RegExp(`(^|[^.\\w$])${helper}\\s*\\(`, "m");
      if (!calls.test(body) || imported.has(helper)) continue;
      /* A local function/const of the same name counts as a definition. */
      const declared = new RegExp(`(function\\s+${helper}\\b|(const|let|var)\\s+${helper}\\s*=)`);
      if (declared.test(body)) continue;
      fail(`${path.relative(ROOT, file)} calls ${helper}() but does not import it from lib/dom.js — that is a runtime "not defined" error.`);
    }
  }
}

/* ------------------------------------------- 4. HTML asset references */
const assetRe = /(?:href|src)\s*=\s*["'](\/[^"'#?]+)(?:\?[^"']*)?["']/g;
for (const file of htmlFiles) {
  const source = fs.readFileSync(file, "utf8");
  let match;
  while ((match = assetRe.exec(source))) {
    const ref = match[1];
    if (ref.startsWith("//")) continue;
    // Generated at build time by scripts/generate-config.mjs (and by the dev
    // server per request), so it is not expected to exist in the repo.
    if (ref === "/js/config/runtime.js" || ref === "/js/runtime.js") continue;
    const onDisk = path.join(PUBLIC, ref);
    const candidates = [onDisk, `${onDisk}.html`, path.join(onDisk, "index.html")];
    if (!candidates.some((candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isFile())) {
      fail(`${path.relative(ROOT, file)} references ${ref}, which does not exist in public/`);
    }
  }
}

/* ------------------------------- 4b. runtime config path consistency */
/* A build that writes the config somewhere no page loads is invisible in dev
   (the dev server injects it per request) and fatal in production. Pin the
   three places together: the page, the build script and the dev server. */
{
  const gen = fs.readFileSync(path.join(ROOT, "scripts", "generate-config.mjs"), "utf8");
  const dev = fs.readFileSync(path.join(ROOT, "scripts", "dev-server.mjs"), "utf8");
  const referenced = new Set();
  for (const file of htmlFiles) {
    const source = fs.readFileSync(file, "utf8");
    for (const m of source.matchAll(/src\s*=\s*["'](\/js\/[^"']*runtime\.js)["']/g)) referenced.add(m[1]);
  }
  if (referenced.size === 0) fail("no page loads /js/config/runtime.js, so the build emits config nothing reads");
  for (const ref of referenced) {
    if (!gen.includes(ref)) fail(`pages load ${ref} but scripts/generate-config.mjs writes it somewhere else`);
    if (!dev.includes(ref)) fail(`pages load ${ref} but scripts/dev-server.mjs does not serve it`);
  }
}

/* ------------------------------------------------- 5. secret-looking strings */
const SECRET_PATTERNS = [
  { label: "Supabase service_role key", re: /service_role\s*[:=]\s*["'][A-Za-z0-9._-]{20,}/ },
  { label: "Google API key", re: /AIza[0-9A-Za-z_-]{30,}/ },
  { label: "Razorpay live secret", re: /rzp_live_[0-9A-Za-z]{10,}/ },
  { label: "Private key block", re: /-----BEGIN (RSA |EC |)PRIVATE KEY-----/ },
  { label: "Gemini key assignment", re: /GEMINI_API_KEY\s*[:=]\s*["'][^"']{8,}/ }
];

for (const file of walk(PUBLIC, () => true)) {
  const name = path.basename(file);
  if (!/\.(js|html|json|webmanifest|css|txt|md)$/.test(name)) continue;
  const source = fs.readFileSync(file, "utf8");
  for (const pattern of SECRET_PATTERNS) {
    if (pattern.re.test(source)) {
      fail(`Possible ${pattern.label} in ${path.relative(ROOT, file)}`);
    }
  }
}

/* --------------------------------------------------- 6. CSS cascade order */
const expectedCss = {
  "index.html": ["tokens.css", "components.css", "marketing.css", "marketing-sections.css", "fx.css"],
  "auth/login/index.html": ["tokens.css", "components.css", "auth.css"],
  "onboarding/index.html": ["tokens.css", "components.css", "app.css", "onboarding.css"],
  "app/index.html": ["tokens.css", "components.css", "app.css", "views.css"],
  "admin/index.html": ["tokens.css", "components.css", "app.css", "views.css", "admin.css"]
};

for (const [relative, order] of Object.entries(expectedCss)) {
  const file = path.join(PUBLIC, relative);
  if (!fs.existsSync(file)) {
    fail(`Missing page ${relative}`);
    continue;
  }
  const source = fs.readFileSync(file, "utf8");
  /* Strip a ?v= cache-busting stamp before comparing — the stamp is a release
     marker, not a different stylesheet. */
  const found = [...source.matchAll(/href="\/css\/([^"?]+)(?:\?[^"]*)?"/g)].map((match) => match[1]);
  for (const css of order) {
    if (!found.includes(css)) fail(`${relative} does not load ${css}`);
    if (!fs.existsSync(path.join(PUBLIC, "css", css))) fail(`public/css/${css} is missing`);
  }
  const ordered = found.filter((css) => order.includes(css));
  if (ordered.join(",") !== order.join(",")) {
    fail(`${relative} loads CSS out of order: ${ordered.join(" → ")} (expected ${order.join(" → ")})`);
  }
}

/* ---------------------------------------------------------- migrations order */
const migrationsDir = path.join(ROOT, "supabase", "migrations");
if (!fs.existsSync(migrationsDir)) {
  fail("supabase/migrations is missing");
} else {
  const migrations = fs.readdirSync(migrationsDir).filter((file) => file.endsWith(".sql")).sort();
  for (const required of ["0001_schema.sql", "0002_functions_rls.sql", "0003_storage_realtime.sql"]) {
    if (!migrations.includes(required)) fail(`supabase/migrations/${required} is missing`);
  }
  notes.push(`Migrations: ${migrations.join(", ")}`);
}

/* --------------------------------------------- backup covers every table ----*/
/* An incomplete backup is worse than no backup, because it looks like one.
   Every table the migrations create must appear in APPLICATION_TABLES, which is
   what scripts/db-backup.mjs walks. */
{
  const admin = await import("./lib/supabase-admin.mjs");
  const listed = new Set(admin.APPLICATION_TABLES);
  const created = new Set();
  for (const file of fs.readdirSync(migrationsDir).filter((f) => f.endsWith(".sql"))) {
    const body = fs.readFileSync(path.join(migrationsDir, file), "utf8");
    for (const match of body.matchAll(/create\s+table\s+(?:if\s+not\s+exists\s+)?public\.([a-z_][a-z0-9_]*)/gi)) {
      created.add(match[1]);
    }
  }
  const missing = [...created].filter((table) => !listed.has(table)).sort();
  if (missing.length) {
    fail(`APPLICATION_TABLES is missing ${missing.join(", ")} — those tables would never be backed up`);
  } else {
    notes.push(`Backup table list: ${listed.size} tables, covers all ${created.size} created by the migrations.`);
  }
  for (const table of admin.SECRET_BEARING_TABLES) {
    if (!listed.has(table)) notes.push(`note: ${table} is not backed up (holds provider credentials).`);
  }
}

/* ---------------------------------------------------------------- reporting */
notes.push(`Checked ${jsFiles.length} modules, ${vendorFiles.length} vendor files and ${htmlFiles.length} pages.`);

console.log("");
for (const note of notes) console.log(`  · ${note}`);

if (problems.length) {
  console.log(`\n  ✕ ${problems.length} problem${problems.length === 1 ? "" : "s"}\n`);
  for (const problem of problems) console.log(`    - ${problem}`);
  console.log("");
  process.exit(1);
}

console.log("\n  ✓ All static checks passed\n");
