import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");
const [builder, ai, notify, onboarding, store, styles] = await Promise.all([
  read("../public/js/modules/dashboard/builder-core.js"),
  read("../supabase/functions/ai/index.ts"),
  read("../public/js/lib/notify.js"),
  read("../public/js/boot/onboarding.js"),
  read("../public/js/lib/store.js"),
  read("../public/css/views.css")
]);

assert.match(builder, /api\.ai\.buildStart\(/, "build returns after a persistent job is started");
assert.match(builder, /api\.ai\.buildStatus\(\{ jobId, type \}\)/, "job polling is scoped to the selected builder type");
assert.match(builder, /openOwnedProject[\s\S]*?resumeUnfinishedBuild/, "reopening the builder restores the existing project and job");
assert.doesNotMatch(builder, /data-viewport="desktop"/, "compiler preview offers no desktop preset");
assert.match(builder, /Samsung Galaxy[\s\S]*?iPhone/, "phone preview presets cover Galaxy and iPhone sizes");
assert.match(builder, /classList\.toggle\("is-expanded"\)/, "Expand toggles the real workspace layout");
assert.match(styles, /\.builder\.is-expanded[\s\S]*?builder-panel \{ display: none; \}/, "expanded builder fills the workspace");
assert.match(ai, /scheduleBuildStep\(req, job\.id\);[\s\S]*?retry_after_seconds: 3/, "retryable background steps are rescheduled without a browser poller");
assert.match(ai, /requestedKind[\s\S]*?\.in\("kind", requestedKind \? \[requestedKind\]/, "status lookup cannot attach an app builder to a website job");
assert.match(notify, /localStorage\.getItem\(ASKED_KEY\)[\s\S]*?requestPermission/, "notification permission is not prompted repeatedly");
assert.match(onboarding, /data\?\.data \?\? data\?\.answers/, "legacy onboarding drafts still resume");
assert.match(onboarding, /compatiblePayload\.is_completed = Boolean\(payload\.completed_at\)/, "completion remains compatible with older schema variants");
assert.match(store, /state\.onboarding\?\.completed_at \|\| state\.onboarding\?\.is_completed/, "the router recognizes either onboarding completion marker");

console.log("  ✓ builder persistence, retries, viewport presets, expand, notification prompt and onboarding compatibility");
