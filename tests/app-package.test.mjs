/* ==========================================================================
   App Builder — packages, platforms and honest status
   --------------------------------------------------------------------------
   The rules tested here are the ones a customer would be harmed by if they
   slipped: a wrong format for a platform, a build claimed as finished with no
   file behind it, or a plan restriction that only lives in the UI.
   ========================================================================== */

import {
  PACKAGE_FORMATS,
  isCorrectPairing,
  packageOptions,
  resolveTarget,
  isValidPackageId,
  suggestPackageId,
  signingRequirements,
  validateMobileApp,
  describeConversionJob,
  packageReadiness
} from "../public/js/lib/app-package.js";

let pass = 0;
let fail = 0;
const check = (name, cond, extra = "") =>
  cond ? (pass++, console.log(`  ✓ ${name}`)) : (fail++, console.log(`  ✗ ${name} ${extra}`));

console.log("formats belong to platforms");
check("APK is Android", PACKAGE_FORMATS.apk.platform === "android");
check("AAB is Android", PACKAGE_FORMATS.aab.platform === "android");
check("IPA is iOS", PACKAGE_FORMATS.ipa.platform === "ios");
check("there is no iOS AAB", !isCorrectPairing("ios", "aab"));
check("there is no Android IPA", !isCorrectPairing("android", "ipa"));
check("iOS APK is refused", !isCorrectPairing("ios", "apk"));
check("each correct pairing is accepted",
  isCorrectPairing("android", "apk") && isCorrectPairing("android", "aab") && isCorrectPairing("ios", "ipa"));
check("an unknown target resolves to nothing", resolveTarget("exe") === null);
check("a target resolves with its platform", resolveTarget("aab").platform === "android");

console.log("\nplan entitlement");
const free = packageOptions(1);
const enterprise = packageOptions(2);
check("a one-platform plan offers APK", free.some((o) => o.target === "apk" && !o.locked));
check("a one-platform plan offers AAB", free.some((o) => o.target === "aab" && !o.locked));
check("a one-platform plan locks IPA", free.some((o) => o.target === "ipa" && o.locked));
check("the lock explains itself", /Enterprise/.test(free.find((o) => o.target === "ipa").reason));
check("two platforms unlock IPA", enterprise.find((o) => o.target === "ipa").locked === false);
check("nothing else is unlocked by Enterprise", enterprise.filter((o) => !o.locked).length === 3);
check("an unknown entitlement is treated as one platform", packageOptions(0).filter((o) => !o.locked).length === 2);

console.log("\npackage ids");
check("a reverse-dns id is accepted", isValidPackageId("in.shinzora.aster"));
check("a single segment is refused", !isValidPackageId("aster"));
check("an underscore in a segment is accepted", isValidPackageId("in.shinzora.aster_studio"));
check("a leading digit is refused", !isValidPackageId("in.9studio.app"));
check("an empty id is refused", !isValidPackageId(""));
check("the reserved java prefix is refused", !isValidPackageId("java.example.app"));
check("a suggestion is derived from the name", suggestPackageId("Aster Studio") === "in.shinzora.asterstudio");
check("a nameless suggestion still produces a valid id", isValidPackageId(suggestPackageId("")));

console.log("\nwhat signing really needs");
const apkNeeds = signingRequirements("apk");
const ipaNeeds = signingRequirements("ipa");
check("Android needs a keystore", apkNeeds.some((r) => r.id === "keystore"));
check("Android needs a toolchain", apkNeeds.some((r) => r.id === "toolchain"));
check("iOS needs an Apple team", ipaNeeds.some((r) => r.id === "team"));
check("iOS needs a certificate and a profile",
  ipaNeeds.some((r) => r.id === "certificate") && ipaNeeds.some((r) => r.id === "profile"));
check("iOS names the macOS requirement", /macOS/.test(ipaNeeds.find((r) => r.id === "toolchain").detail));
check("an unknown format needs nothing listed", signingRequirements("exe").length === 0);

console.log("\nmobile-only output");
const mobileApp = `<!doctype html><html lang="en"><head>
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>Clinic</title><style>
:root{--gap:4vw} body{margin:0;width:100%;touch-action:manipulation}
.screen{padding:5vw;min-height:100dvh}
.card{width:100%;max-width:100%}
@media (max-width:480px){.grid{grid-template-columns:1fr}}
@media (min-width:481px){.grid{grid-template-columns:1fr 1fr}}
</style></head><body>
<div data-route="/" data-title="Home"><h1>Clinic</h1><a href="#/book">Book</a></div>
<section data-route="/book" hidden><h1>Book</h1><a href="#/">Back</a></section>
</body></html>`;

const mobile = validateMobileApp(mobileApp);
check("a real mobile app passes", mobile.ok, JSON.stringify(mobile.issues.map((i) => i.code)));
check("it is recognised as mobile", mobile.mobile === true);
check("both screens are found", mobile.routes.length === 2);

const desktop = validateMobileApp(`<!doctype html><html><head><title>Site</title>
<style>body{margin:0} .wrap{width:1200px;margin:0 auto} .col{width:960px}</style></head>
<body><h1>Desktop site</h1></body></html>`);
check("a desktop layout fails", desktop.ok === false);
check("the missing viewport is an error", desktop.issues.some((i) => i.code === "app-viewport"));
check("fixed desktop widths are an error", desktop.issues.some((i) => i.code === "app-fixed-width"));
check("it is not described as mobile", desktop.mobile === false);

const zoomLocked = validateMobileApp(mobileApp.replace("initial-scale=1", "initial-scale=1, maximum-scale=1, user-scalable=no"));
check("disabling pinch zoom is a warning", zoomLocked.issues.some((i) => i.code === "app-zoom"));

const oneScreen = validateMobileApp(mobileApp.replace(/<section data-route[\s\S]*?<\/section>/, "").replace('<a href="#/book">Book</a>', ""));
check("a single-screen app is flagged", oneScreen.issues.some((i) => i.code === "app-screens"));

const noTouch = validateMobileApp(mobileApp.replace("touch-action:manipulation", ""));
check("missing touch handling is flagged", noTouch.issues.some((i) => i.code === "app-touch"));

const unreachable = validateMobileApp(mobileApp.replace('<a href="#/book">Book</a>', "").replace('<a href="#/">Back</a>', ""));
check("screens with no way between them are flagged", unreachable.issues.some((i) => i.code === "app-navigation"));

console.log("\nhonest conversion status");
const queued = describeConversionJob({ status: "queued", target: "apk" });
check("queued is not downloadable", queued.downloadable === false);
check("queued says no package exists", /no package exists/i.test(queued.detail), queued.detail);
const running = describeConversionJob({ status: "running", target: "apk" });
check("running is not downloadable", running.downloadable === false);
const built = describeConversionJob({ status: "built", target: "apk", artifact_path: "a.apk", artifact_sha256: "abc" });
check("built with a file and a checksum is downloadable", built.downloadable === true);
const fakeBuilt = describeConversionJob({ status: "built", target: "apk" });
check("built with no file is not downloadable", fakeBuilt.downloadable === false);
check("and it is called a fault, not a build", /fault/i.test(fakeBuilt.detail));
const builtWithoutChecksum = describeConversionJob({ status: "built", target: "apk", artifact_path: "a.apk" });
check("a file with no checksum is not trusted either", builtWithoutChecksum.downloadable === false);
const waiting = describeConversionJob({ status: "awaiting_toolchain", target: "ipa" });
check("a waiting IPA names the Apple requirements", /Apple/.test(waiting.detail));
const waitingApk = describeConversionJob({ status: "awaiting_toolchain", target: "apk" });
check("a waiting APK names the keystore", /keystore/i.test(waitingApk.detail));
check("failed shows the real error", /boom/.test(describeConversionJob({ status: "failed", target: "apk", error: "boom" }).detail));
check("an unknown status is not dressed up", describeConversionJob({ status: "wat" }).downloadable === false);

console.log("\nreadiness before a request");
const ready = packageReadiness({ target: "apk", appName: "Aster", packageId: "in.shinzora.aster", icon: { dataUrl: "data:image/png;base64,AA" } });
check("a complete request is ready", ready.length === 0, JSON.stringify(ready));
check("no target is refused", packageReadiness({ appName: "A", packageId: "a.b", icon: {} }).some((p) => p.field === "target"));
check("no icon is refused", packageReadiness({ target: "apk", appName: "A", packageId: "a.b" }).some((p) => p.field === "icon"));
check("a bad package id is refused", packageReadiness({ target: "apk", appName: "A", packageId: "Aster", icon: {} }).some((p) => p.field === "packageId"));
check("a very long name is refused",
  packageReadiness({ target: "apk", appName: "x".repeat(80), packageId: "a.b", icon: {} }).some((p) => p.field === "appName"));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
