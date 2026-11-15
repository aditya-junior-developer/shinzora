/* ==========================================================================
   Call quality and devices (P8) — pure logic, exact thresholds
   ========================================================================== */
import {
  classifyQuality,
  videoBitrateFor,
  summariseStats,
  shouldWarn,
  VIDEO_BITRATE_BPS
} from "../public/js/modules/messaging/call-quality.js";
import { groupDevices, captureConstraints } from "../public/js/modules/messaging/call-devices.js";

let pass = 0;
let fail = 0;
const check = (name, cond, extra = "") =>
  cond ? (pass++, console.log(`  ✓ ${name}`)) : (fail++, console.log(`  ✗ ${name}${extra ? ` — ${extra}` : ""}`));

console.log("quality levels");
check("no measurement is 'unknown', not a warning", classifyQuality({}) === "unknown");
check("a clean link is good", classifyQuality({ rttSeconds: 0.05, lossRatio: 0, availableOutgoingBps: 3_000_000 }) === "good");
check("3% loss is fair", classifyQuality({ rttSeconds: 0.05, lossRatio: 0.03, availableOutgoingBps: 3_000_000 }) === "fair");
check("300 ms round trip is fair", classifyQuality({ rttSeconds: 0.3, lossRatio: 0, availableOutgoingBps: 3_000_000 }) === "fair");
check("8% loss is poor", classifyQuality({ rttSeconds: 0.05, lossRatio: 0.08, availableOutgoingBps: 3_000_000 }) === "poor");
check("600 ms round trip is poor", classifyQuality({ rttSeconds: 0.6, lossRatio: 0, availableOutgoingBps: 3_000_000 }) === "poor");
check("under 150 kbps headroom is poor", classifyQuality({ rttSeconds: 0.05, lossRatio: 0, availableOutgoingBps: 100_000 }) === "poor");
check("headroom under 500 kbps is fair", classifyQuality({ rttSeconds: 0.05, lossRatio: 0, availableOutgoingBps: 400_000 }) === "fair");

console.log("video ceiling");
check("good allows 1.5 Mbps", videoBitrateFor("good") === 1_500_000);
check("poor drops to 200 kbps", videoBitrateFor("poor") === 200_000);
check("unknown does not cap video below good", videoBitrateFor("unknown") === VIDEO_BITRATE_BPS.good);
check("the ceiling falls as quality falls", videoBitrateFor("good") > videoBitrateFor("fair") && videoBitrateFor("fair") > videoBitrateFor("poor"));

console.log("stats reduction");
const report = new Map([
  ["cp", { type: "candidate-pair", nominated: true, state: "succeeded", currentRoundTripTime: 0.12, availableOutgoingBitrate: 2_000_000 }],
  ["out", { type: "outbound-rtp", kind: "video", packetsSent: 900 }],
  ["in", { type: "remote-inbound-rtp", kind: "video", packetsLost: 100, roundTripTime: 0.2 }]
]);
const s = summariseStats(report);
check("reads the round trip from the nominated pair", s.rttSeconds === 0.12);
check("reads the headroom from the nominated pair", s.availableOutgoingBps === 2_000_000);
check("computes loss from packets lost over packets sent", Math.abs(s.lossRatio - 0.1) < 1e-9, String(s.lossRatio));
check("a failed or un-nominated pair is ignored", summariseStats([{ type: "candidate-pair", nominated: false, currentRoundTripTime: 9 }]).rttSeconds === undefined);
check("an empty report is unknown", classifyQuality(summariseStats(new Map())) === "unknown");

console.log("warning");
check("one bad sample does not warn", shouldWarn(["good", "poor"]) === null);
check("three poor samples warn poor", shouldWarn(["good", "poor", "poor", "poor"]) === "poor");
check("three fair samples warn fair", shouldWarn(["fair", "fair", "fair"]) === "fair");
check("unknown never warns", shouldWarn(["unknown", "unknown", "unknown"]) === null);

console.log("devices");
const groups = groupDevices([
  { kind: "audioinput", deviceId: "m1", label: "" },
  { kind: "audioinput", deviceId: "m2", label: "USB headset" },
  { kind: "videoinput", deviceId: "c1", label: "" },
  { kind: "audiooutput", deviceId: "s1", label: "Speakers" },
  { kind: "other", deviceId: "x", label: "ignored" }
]);
check("microphones are grouped", groups.microphones.length === 2);
check("an unlabelled microphone gets a numbered name", groups.microphones[0].label === "Microphone 1");
check("a labelled microphone keeps its name", groups.microphones[1].label === "USB headset");
check("an unlabelled camera gets a numbered name", groups.cameras[0].label === "Camera 1");
check("speakers are grouped", groups.speakers.length === 1);
check("unknown kinds are dropped", groups.microphones.length + groups.cameras.length + groups.speakers.length === 4);

const c = captureConstraints({ microphoneId: "m2", cameraId: "c1", video: true });
check("a chosen microphone is requested exactly", c.audio.deviceId?.exact === "m2");
check("a chosen camera is requested exactly", c.video.deviceId?.exact === "c1");
check("echo cancellation stays on", c.audio.echoCancellation === true && c.audio.noiseSuppression === true);
check("voice-only asks for no camera", captureConstraints({ video: false }).video === false);
check("no device chosen means the default", captureConstraints({}).audio.deviceId === undefined);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
