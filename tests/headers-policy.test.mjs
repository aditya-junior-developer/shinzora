/* ==========================================================================
   The headers the host sends
   --------------------------------------------------------------------------
   A refused microphone is not a bug in the call code — it can be a header the
   host sets. `Permissions-Policy: microphone=()` forbids the microphone for
   every page on the domain, and the browser then refuses getUserMedia with the
   same error a person refusing the prompt produces, so the app blamed the user
   for something it had itself forbidden.

   Calls are the whole point of that header being wrong, so it is pinned here.
   ========================================================================== */

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const repo = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const vercel = JSON.parse(fs.readFileSync(path.join(repo, "vercel.json"), "utf8"));

const headerValue = (key) => {
  for (const block of vercel.headers || []) {
    for (const header of block.headers || []) {
      if (header.key.toLowerCase() === key.toLowerCase()) return header.value;
    }
  }
  return null;
};

test("the microphone and camera are allowed for this site, not forbidden for everyone", () => {
  const policy = headerValue("Permissions-Policy");
  assert.ok(policy, "a Permissions-Policy header is sent");
  const directive = (name) => {
    const match = policy.match(new RegExp(`${name}=([^,]+)`));
    return match ? match[1].trim() : null;
  };
  assert.equal(directive("microphone"), "(self)", `microphone must allow self, got ${directive("microphone")}`);
  assert.equal(directive("camera"), "(self)", `camera must allow self, got ${directive("camera")}`);
});

test("features the site does not use stay switched off", () => {
  const policy = headerValue("Permissions-Policy");
  assert.match(policy, /geolocation=\(\)/, "no page needs location");
});

test("the frame and transport protections stay on", () => {
  assert.equal(headerValue("X-Content-Type-Options"), "nosniff");
  assert.equal(headerValue("X-Frame-Options"), "SAMEORIGIN");
  assert.match(headerValue("Strict-Transport-Security"), /max-age=\d+/);
});
