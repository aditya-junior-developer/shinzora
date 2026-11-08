import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../public/js/boot/onboarding.js", import.meta.url), "utf8");
const store = await readFile(new URL("../public/js/lib/store.js", import.meta.url), "utf8");

assert.match(source, /data\?\.data[\s\S]*?data\?\.answers/, "resume falls back to legacy answers");
assert.match(source, /compatiblePayload\.is_completed\s*=\s*Boolean\(payload\.completed_at\)/, "completion mirrors the legacy boolean");
assert.match(source, /answers:\s*payload\.data\s*\?\?\s*draft/, "saved drafts mirror the legacy answers column");
assert.match(source, /submitting\s*=\s*false;[\s\S]*?setBusy\(nextBtn, false\)/, "the post-save navigation fallback unlocks the finish button");
assert.match(source, /link\.textContent\s*=\s*"Open dashboard"/, "the navigation fallback creates a real dashboard link");
assert.match(store, /state\.onboarding\?\.completed_at\s*\|\|\s*state\.onboarding\?\.is_completed/, "the app recognizes either completion marker");

console.log("  ✓ onboarding legacy-schema compatibility and finish fallback");
