/* ==========================================================================
   ZIP export tests
   --------------------------------------------------------------------------
   Verifies the archive with an independent reader (the system `unzip`) as well
   as a byte-level parse, so "it downloads a .zip" cannot silently regress into
   "it downloads a text file".
   ========================================================================== */

import { createWriteStream } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { createZip, crc32, safeEntryName, zipBlob } from "../public/js/lib/zip.js";

let pass = 0;
let fail = 0;
const check = (name, cond, extra = "") =>
  cond ? (pass++, console.log(`  ✓ ${name}`)) : (fail++, console.log(`  ✗ ${name} ${extra}`));

console.log("zip");

/* --- crc-32 against known vectors ---------------------------------------- */
check("crc32 of empty input", crc32(new Uint8Array()) === 0);
check(
  "crc32 of '123456789' is the reference value",
  crc32(new TextEncoder().encode("123456789")) === 0xcbf43926,
  String(crc32(new TextEncoder().encode("123456789")))
);
check(
  "crc32 of 'hello' matches zlib",
  crc32(new TextEncoder().encode("hello")) === 0x3610a686,
  String(crc32(new TextEncoder().encode("hello")))
);

/* --- name hardening ------------------------------------------------------ */
check("absolute paths are stripped", safeEntryName("/etc/index.html") === "etc/index.html");
check("traversal is removed", safeEntryName("../../secret.txt") === "secret.txt");
check("windows separators normalised", safeEntryName("a\\b\\c.css") === "a/b/c.css");
check("empty name falls back to index.html", safeEntryName("") === "index.html");

/* --- archive structure --------------------------------------------------- */
const files = {
  "index.html": "<!doctype html><html><body><h1>Shinzora</h1></body></html>",
  "styles.css": "body{margin:0}",
  "assets/app.js": "console.log('hi');"
};
const bytes = createZip(files, { root: "my-project", date: new Date(2026, 10, 7, 12, 0, 0) });

const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
check("starts with a local file header signature", view.getUint32(0, true) === 0x04034b50);
check(
  "ends with an end-of-central-directory record",
  view.getUint32(bytes.length - 22, true) === 0x06054b50
);
check("entry count recorded", view.getUint16(bytes.length - 22 + 8, true) === 3);
check("no archive comment", view.getUint16(bytes.length - 2, true) === 0);

/* Every local header must name a file that exists and carry the right size. */
let at = 0;
const seen = [];
for (let i = 0; i < 3; i += 1) {
  const nameLen = view.getUint16(at + 26, true);
  const size = view.getUint32(at + 18, true);
  const name = new TextDecoder().decode(bytes.slice(at + 30, at + 30 + nameLen));
  seen.push(name);
  at += 30 + nameLen + size;
}
check(
  "all three files are in the archive under the project folder",
  seen.sort().join(",") === "my-project/assets/app.js,my-project/index.html,my-project/styles.css",
  seen.join(",")
);
check("central directory follows the last file", view.getUint32(at, true) === 0x02014b50);

/* --- round trip through unzip ------------------------------------------- */
let dir = null;
try {
  dir = await mkdtemp(join(tmpdir(), "shinzora-zip-"));
  const path = join(dir, "export.zip");
  await new Promise((resolve, reject) => {
    const stream = createWriteStream(path);
    stream.on("finish", resolve);
    stream.on("error", reject);
    stream.end(Buffer.from(bytes));
  });

  const listing = execFileSync("unzip", ["-l", path], { encoding: "utf8" });
  check("unzip lists the archive as a valid zip", /my-project\/index\.html/.test(listing), listing.split("\n")[0]);
  check("unzip sees a non-empty archive", !/zipfile is empty/.test(listing));

  const test = execFileSync("unzip", ["-t", path], { encoding: "utf8" });
  check("unzip -t reports no CRC errors", /No errors detected/.test(test), test.trim().split("\n").pop());

  execFileSync("unzip", ["-q", path, "-d", join(dir, "out")]);
  const restored = await readFile(join(dir, "out", "my-project", "index.html"), "utf8");
  check("file contents survive the round trip", restored === files["index.html"]);
  const restoredJs = await readFile(join(dir, "out", "my-project", "assets", "app.js"), "utf8");
  check("nested paths survive the round trip", restoredJs === files["assets/app.js"]);
} catch (error) {
  check("unzip round trip", false, error.message);
} finally {
  if (dir) await rm(dir, { recursive: true, force: true });
}

/* --- edge cases --------------------------------------------------------- */
let threw = false;
try {
  createZip({});
} catch {
  threw = true;
}
check("an empty project is refused, not exported as a broken archive", threw);

check("utf-8 file names are flagged and preserved", (() => {
  const one = createZip({ "café.html": "x" });
  const dv = new DataView(one.buffer, one.byteOffset, one.byteLength);
  return dv.getUint16(6, true) === 0x0800 && new TextDecoder().decode(one.slice(30, 30 + 11)).includes("café");
})());

const blob = zipBlob(files);
check("blob advertises the zip mime type", blob.type === "application/zip", blob.type);
check("blob is non-trivial in size", blob.size > 200, String(blob.size));

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
