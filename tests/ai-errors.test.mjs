/* ============================================================================
   Shinzora — AI provider error handling
   ----------------------------------------------------------------------------
   Runs in plain Node, with no API key and no network: `fetch` and `Deno` are
   stubbed. It locks down what a customer is told when the provider refuses a
   request, because the alternative — a developer paragraph, or a cheerful
   "try again in a minute" for a quota that resets in 84 minutes — is how the
   reset page ended up printing "PKCE code verifier not found in storage".

     node tests/ai-errors.test.mjs
   ========================================================================== */

/* esbuild is a dev-only dependency used to bundle the Deno-flavoured TypeScript
   for plain Node. A fresh checkout (or a sandbox that dropped node_modules) does
   not have it, and silently skipping these assertions would be worse than not
   having them — so the skip is loud and the command to fix it is printed. */
let build = null;
try {
  ({ build } = await import("esbuild"));
} catch {
  console.log("  ! SKIPPED — esbuild is not installed, so the AI error-path assertions did not run.");
  console.log("  ! Install it with: npm install --save-dev esbuild");
  process.exit(0);
}
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

let pass = 0, fail = 0;
const check = (name, cond, extra = "") =>
  cond ? (pass++, console.log(`  ✓ ${name}`)) : (fail++, console.log(`  ✗ ${name} ${extra}`));

/* The module reads Deno.env at call time; give it a stand-in before import. */
const ENV = { SHINZORA_AI_API_KEY: "test-key-not-a-real-one-0123456789", SHINZORA_AI_MODEL: "gemini-3.8-flash" };
globalThis.Deno = { env: { get: (name) => ENV[name] ?? undefined } };

const outdir = mkdtempSync(join(tmpdir(), "shinzora-ai-"));
const outfile = join(outdir, "gemini.mjs");
await build({
  entryPoints: ["supabase/functions/_shared/gemini.ts"],
  outfile,
  format: "esm",
  bundle: true,
  platform: "neutral",
  logLevel: "silent"
});
const mod = await import(pathToFileURL(outfile).href);
const { extractRetrySeconds, describeWait, isQuotaExhausted, providerError, gemini, GeminiError } = mod;

/* The real payload Gemini returned for this project, verbatim. */
const QUOTA_BODY = JSON.stringify({
  error: {
    code: 429,
    message:
      "You exceeded your current quota, please check your plan and billing details. For more information on this error, head to: https://ai.google.dev/gemini-api/docs/rate-limits.\n" +
      "* Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: 20, model: gemini-3.8-flash, description: Generate content requests per day limit exceeded on Free Tier.\n" +
      "Please retry in 1h24m15.473309721s.",
    status: "RESOURCE_EXHAUSTED"
  }
});

const ZERO_LIMIT_BODY = JSON.stringify({
  error: {
    code: 429,
    message:
      "* Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: 0, model: gemini-2.5-flash-preview-image\n" +
      "Please retry in 1h24m15.049126493s."
  }
});

console.log("\nwait parsing");
check("parses 1h24m15.4s", extractRetrySeconds(QUOTA_BODY) === 5055, String(extractRetrySeconds(QUOTA_BODY)));
check("parses a retryDelay field", extractRetrySeconds('{"retryDelay":"84s"}') === 84);
check("parses plain seconds", extractRetrySeconds("You may retry in 20 seconds.") === 20);
check("no wait invented when absent", extractRetrySeconds("Something failed.") === null);
check("merges hours and minutes", describeWait(5055) === "about 1h 24m", describeWait(5055));
check("short waits stay in seconds", describeWait(45) === "45 seconds");
check("minutes only when under 90", describeWait(600) === "about 10 minutes");

console.log("\nquota classification");
check("daily limit recognised", isQuotaExhausted(QUOTA_BODY));
check("a plain rate limit is not a quota", !isQuotaExhausted("Too many requests per minute."));
check("zero limit recognised", isQuotaExhausted(ZERO_LIMIT_BODY));

console.log("\nwhat the customer is told");
const quota = providerError(429, QUOTA_BODY);
check("quota gets its own code", quota.code === "ai_quota_exhausted", quota.code);
check("quota keeps 429", quota.status === 429);
check("quota carries the real wait as data", quota.retryAfter === 5055, String(quota.retryAfter));
check("message states the true reset window", /resets in about 1h 24m/.test(quota.message), quota.message);
check("no developer URL leaks", !/generativelanguage|ai\.google\.dev|rate-limits/i.test(quota.message), quota.message);

const zero = providerError(429, ZERO_LIMIT_BODY);
check("zero allowance is explained as a plan matter", /not included in the provider plan/i.test(zero.message), zero.message);
check("zero allowance tells the owner what to do", /billing settings/i.test(zero.message));

const rate = providerError(429, "Too many requests. Retry in 12s.");
check("a fast limit stays a fast limit", rate.code === "ai_rate_limited", rate.code);
check("and still carries the wait", rate.retryAfter === 12);

const badKey = providerError(400, '{"error":{"message":"API key not valid. Please pass a valid API key."}}');
check("a bad key is named", badKey.code === "ai_bad_key", badKey.code);
const disabled = providerError(403, '{"error":{"message":"Billing has not been enabled for this project."}}');
check("a billing/permission refusal is named", disabled.code === "ai_forbidden", disabled.code);
check("unknown provider errors keep their status", providerError(500, "boom").message.includes("500"));

console.log("\nfull request path");
const calls = [];
globalThis.fetch = async (url, init) => {
  const target = String(url);
  /* Model discovery lists models on the same fetch; only generation attempts
     belong in this list. */
  const match = target.match(/models\/([^:?]+):generateContent/);
  if (!match) return new Response(JSON.stringify({ models: [] }), { status: 200, headers: { "content-type": "application/json" } });
  const model = match[1];
  calls.push(model);
  if (model === "gemini-3.8-flash") {
    return new Response(QUOTA_BODY, { status: 429, headers: { "content-type": "application/json" } });
  }
  return new Response("{}", { status: 500 });
};

let thrown = null;
try {
  await gemini("Plan a website");
} catch (error) {
  thrown = error;
}
check("a spent quota fails fast instead of walking the fallback chain", thrown?.code === "ai_quota_exhausted", thrown?.code);
check("only one model was tried", calls.length === 1, `tried ${calls.join(", ")}`);
check("the error carries the wait", thrown?.retryAfter === 5055);
check("the key never appears in the message", !String(thrown?.message).includes(ENV.SHINZORA_AI_API_KEY));
check("the key never appears in the stack or JSON", !JSON.stringify({ ...thrown, message: thrown?.message }).includes(ENV.SHINZORA_AI_API_KEY));

console.log("\nMAX_TOKENS is not an empty answer");
/* A second model, so "fall through on an exhausted budget" is actually
   exercised. In production this list comes from the configured fallbacks plus
   the provider's own model list (see _shared/models.ts). */
ENV.SHINZORA_AI_MODEL_FALLBACKS = "gemini-3.1-pro-preview";
calls.length = 0;
globalThis.fetch = async (url) => {
  const target = String(url);
  /* Model discovery lists models on the same fetch; only generation attempts
     belong in this list. */
  const match = target.match(/models\/([^:?]+):generateContent/);
  if (!match) return new Response(JSON.stringify({ models: [] }), { status: 200, headers: { "content-type": "application/json" } });
  const model = match[1];
  calls.push(model);
  if (model === "gemini-3.8-flash") {
    return new Response(
      JSON.stringify({ candidates: [{ content: {}, finishReason: "MAX_TOKENS" }], usageMetadata: { totalTokenCount: 76 } }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  }
  return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: "fallback answered" }] }, finishReason: "STOP" }] }), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
};
const answer = await gemini("Plan a website");
check("an exhausted budget falls through to the next model", answer === "fallback answered", answer);
check("the primary model was tried first", calls[0] === "gemini-3.8-flash", calls.join(", "));

/* Every model exhausted → the specific reason survives, not a generic one. */
delete ENV.SHINZORA_AI_MODEL_FALLBACKS;
globalThis.fetch = async (url) => {
  const target = String(url);
  if (!/models\/[^:?]+:generateContent/.test(target)) {
    return new Response(JSON.stringify({ models: [] }), { status: 200, headers: { "content-type": "application/json" } });
  }
  return new Response(JSON.stringify({ candidates: [{ content: {}, finishReason: "MAX_TOKENS" }] }), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
};
thrown = null;
try {
  await gemini("Plan a website");
} catch (error) {
  thrown = error;
}
check("all-models-exhausted reports the output limit", thrown?.code === "ai_max_tokens", thrown?.code);
check("its message tells the user what to change", /fewer pages|shorter brief/.test(thrown?.message ?? ""), thrown?.message);

console.log("\nthe sandbox copy agrees with the edge function copy");
/* Two files carry this mapping (the Edge Function cannot import from server/).
   Run both over the same payloads so they cannot drift apart unnoticed. */
const sandbox = await import("../server/prelaunch/functions.mjs").catch((error) => ({ __importError: error }));

if (sandbox.__importError) {
  check("sandbox module imports in Node", false, sandbox.__importError.message);
} else {
  check("sandbox exports the translator", typeof sandbox.translateAiError === "function");
  for (const [name, status, body] of [
    ["daily quota", 429, QUOTA_BODY],
    ["zero allowance", 429, ZERO_LIMIT_BODY],
    ["fast limit", 429, "Too many requests. Retry in 12s."],
    ["bad key", 400, '{"error":{"message":"API key not valid."}}'],
    ["billing refusal", 403, '{"error":{"message":"Billing has not been enabled."}}'],
    ["provider fault", 500, "upstream exploded"]
  ]) {
    const edge = providerError(status, body);
    const local = sandbox.translateAiError(status, body);
    check(`same code for ${name}`, edge.code === local.code, `${edge.code} vs ${local.code}`);
    check(`same status for ${name}`, edge.status === local.status, `${edge.status} vs ${local.status}`);
    check(
      `same retry window for ${name}`,
      (edge.retryAfter ?? null) === (local.extra?.retry_after_seconds ?? null),
      `${edge.retryAfter} vs ${local.extra?.retry_after_seconds}`
    );
    check(`no provider prose for ${name}`, !/generativelanguage|ai\.google\.dev|rate-limits/i.test(local.message), local.message);
  }
}

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
