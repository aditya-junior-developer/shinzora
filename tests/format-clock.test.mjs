/* ==========================================================================
   The two clocks
   --------------------------------------------------------------------------
   `timeAgo` is for a bubble, where there is room to spell it out. `timeAgoShort`
   is for the rail, where "12 minutes ago" pushed the group name down to
   "Desig…". They must agree on the instant and disagree only on the ink.
   ========================================================================== */

import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";

const repo = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const { timeAgo, timeAgoShort } = await import(pathToFileURL(path.join(repo, "public/js/lib/format.js")).href);

const at = (secondsAgo) => new Date(Date.now() - secondsAgo * 1000).toISOString();

test("seconds read as \"now\"", () => {
  assert.equal(timeAgoShort(at(5)), "now");
  assert.equal(timeAgoShort(at(59)), "now");
});

test("minutes, hours, days and weeks are one or two characters wide", () => {
  assert.equal(timeAgoShort(at(60 * 12)), "12m");
  assert.equal(timeAgoShort(at(3600 * 3)), "3h");
  assert.equal(timeAgoShort(at(86400 * 2)), "2d");
  assert.equal(timeAgoShort(at(604800 * 5)), "5w");
});

test("nothing older than a year is still a duration", () => {
  assert.match(timeAgoShort(at(31557600 * 2)), /\d/, "a date, not a count of months");
  assert.doesNotMatch(timeAgoShort(at(31557600 * 2)), /m$|h$|d$|w$/, "not a short duration");
});

test("an empty or unparseable stamp is quiet, not \"Invalid Date\"", () => {
  assert.equal(timeAgoShort(null), "");
  assert.equal(timeAgoShort("not a date"), "");
});

test("the rail clock is never longer than the spelled-out one", () => {
  for (const secondsAgo of [30, 600, 7200, 172800, 2592000]) {
    const stamp = at(secondsAgo);
    assert.ok(
      timeAgoShort(stamp).length < timeAgo(stamp).length,
      `"${timeAgoShort(stamp)}" should be shorter than "${timeAgo(stamp)}"`
    );
  }
});
