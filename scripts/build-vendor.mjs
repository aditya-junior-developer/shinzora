#!/usr/bin/env node
/* Build the browser global expected by the static HTML entry points. */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outfile = path.join(ROOT, "public/js/vendor/supabase-js.js");
fs.mkdirSync(path.dirname(outfile), { recursive: true });

await build({
  entryPoints: ["@supabase/supabase-js"],
  bundle: true,
  format: "iife",
  globalName: "supabase",
  platform: "browser",
  target: ["es2020"],
  minify: true,
  sourcemap: false,
  outfile,
  legalComments: "none"
});

console.log(`Built ${path.relative(ROOT, outfile)} (${fs.statSync(outfile).size.toLocaleString()} bytes).`);
