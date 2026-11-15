/* Brief item 3 — invitation links. Pure helpers: the return path after sign-in,
   the meeting path, and the join-code check. */
import assert from "node:assert/strict";
import { normaliseMeetingCode, safeNextPath, meetingPath, onboardingPathWithNext, MEETING_CODE_PATTERN } from "../public/js/lib/invite.js";

let passed = 0;
const test = (name, fn) => { fn(); passed++; console.log(`ok - ${name}`); };

test("safeNextPath keeps an in-app meeting link intact", () => {
  const link = "/app/?view=meeting&code=abcdefgh2";
  assert.equal(safeNextPath(link), link);
});

test("safeNextPath refuses anything that could leave the site", () => {
  for (const bad of ["https://evil.example/app/", "//evil.example", "/\\evil.example", "javascript:alert(1)", "app/?view=meeting", "", " ", "/app/\r\nX: y"]) {
    assert.equal(safeNextPath(bad, "/app/"), "/app/", `refused: ${JSON.stringify(bad)}`);
  }
});

test("safeNextPath returns the fallback for a missing or non-string value", () => {
  assert.equal(safeNextPath(null, "/x/"), "/x/");
  assert.equal(safeNextPath(undefined), "");
  assert.equal(safeNextPath(42, "/x/"), "/x/");
});

test("meetingPath builds the lobby link and encodes the code", () => {
  assert.equal(meetingPath("abcdefgh2"), "/app/?view=meeting&code=abcdefgh2");
  assert.equal(meetingPath("a b&c"), "/app/?view=meeting&code=a%20b%26c");
});

test("onboardingPathWithNext carries a safe invite through onboarding", () => {
  const invite = meetingPath("abcdefgh2");
  const path = onboardingPathWithNext(invite);
  assert.equal(path, `/onboarding/?next=${encodeURIComponent(invite)}`);
  assert.equal(new URL(path, "https://x.test").searchParams.get("next"), invite);
  assert.equal(onboardingPathWithNext("https://evil.example"), "/onboarding/");
  assert.equal(onboardingPathWithNext(""), "/onboarding/");
});

test("normaliseMeetingCode accepts real codes, ignoring case, spaces and dashes", () => {
  assert.equal(normaliseMeetingCode("ABCD-EFGH2"), "abcdefgh2");
  assert.equal(normaliseMeetingCode("  abcd efgh2 "), "abcdefgh2");
});

test("normaliseMeetingCode refuses wrong length and letters the minter never uses", () => {
  for (const bad of ["", "abcdefgh", "abcdefgh23", "abcdefghi", "abcdefghl", "abcdefgho", "abcdefgh!", "abcdefgh0", "abcdefgh1"]) {
    assert.equal(normaliseMeetingCode(bad), null, `refused: ${bad}`);
  }
  assert.equal(normaliseMeetingCode(undefined), null);
});

test("the pattern matches the database check on meetings.code", () => {
  assert.ok(MEETING_CODE_PATTERN.test("abcdefgh2"));
  assert.equal(MEETING_CODE_PATTERN.test("ABCDEFGH2"), false);
});

console.log(`\n${passed} passed, 0 failed`);
