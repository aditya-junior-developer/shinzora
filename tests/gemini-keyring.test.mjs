/* Key failover contracts: local Node harness, fake credentials and stubbed fetch. */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

const ENV = {
  SHINZORA_AI_MODEL: "gemini-3.8-flash",
  SHINZORA_AI_MODEL_FALLBACKS: ""
};
globalThis.Deno = { env: { get: (name) => ENV[name] ?? undefined } };

const dir = mkdtempSync(join(tmpdir(), "shinzora-keyring-"));
try {
  const outfile = join(dir, "gemini.mjs");
  await build({
    entryPoints: ["supabase/functions/_shared/gemini.ts"],
    outfile,
    format: "esm",
    bundle: true,
    platform: "neutral",
    logLevel: "silent"
  });
  const ai = await import(pathToFileURL(outfile).href);
  const fakeKeys = ["fake-project-a-key-alpha-0001", "fake-project-a-key-beta-0002", "fake-project-b-key-gamma-0003"];
  const configure = (keys) => {
    for (const name of Object.keys(ENV)) if (name.startsWith("SHINZORA_AI_")) delete ENV[name];
    ENV.SHINZORA_AI_MODEL = "gemini-3.8-flash";
    ENV.SHINZORA_AI_MODEL_FALLBACKS = "";
    ENV.SHINZORA_AI_KEYRING = JSON.stringify(keys);
    ai.resetGeminiKeyHealth();
  };
  const responseJson = (payload, status = 200) => new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
  const originalFetch = globalThis.fetch;
  const requests = [];
  const stub = (handler) => {
    requests.length = 0;
    globalThis.fetch = async (url, init = {}) => {
      const call = { url: String(url), init, key: new Headers(init.headers).get("x-goog-api-key") };
      requests.push(call);
      return handler(call);
    };
  };
  const generateCalls = () => requests.filter((call) => call.url.includes(":generateContent"));

  assert.equal(ai.primaryModel(), "gemini-3.8-flash", "the verified Gemini Flash model is the default");

  configure([
    { id: "alpha", key: fakeKeys[0], projectId: "project-a", priority: 1 },
    { id: "beta", key: fakeKeys[1], projectId: "project-a", priority: 2 },
    { id: "gamma", key: fakeKeys[2], projectId: "project-b", priority: 3 },
    { id: "disabled", key: "fake-disabled-key-0004", projectId: "project-c", priority: 0, enabled: false }
  ]);
  assert.deepEqual(ai.geminiKeyMetadata(), [
    { id: "alpha", projectId: "project-a", priority: 1 },
    { id: "beta", projectId: "project-a", priority: 2 },
    { id: "gamma", projectId: "project-b", priority: 3 }
  ]);
  stub((call) => {
    if (!call.url.includes(":generateContent")) return responseJson({ models: [] });
    if (call.key === fakeKeys[0]) return responseJson({ error: { message: "Quota exceeded for project. Please retry in 1m." } }, 429);
    if (call.key === fakeKeys[1]) throw new Error("same-project key should be skipped after quota exhaustion");
    return responseJson({ candidates: [{ content: { parts: [{ text: "generated" }] } }] });
  });
  assert.equal(await ai.gemini("Build a small website"), "generated");
  const quotaCalls = generateCalls();
  assert.deepEqual(quotaCalls.map((call) => call.key), [fakeKeys[0], fakeKeys[2]], "quota failover skips another key in the same Google project and tries an explicitly different project");
  assert.ok(quotaCalls.every((call) => call.url.includes("gemini-3.8-flash")), "all credentials use the same selected model");
  assert.ok(requests.every((call) => !call.url.includes(fakeKeys[0]) && !call.url.includes("?key=")), "credentials never enter URLs");

  configure([
    { id: "alpha", key: fakeKeys[0], projectId: "project-a", priority: 1 },
    { id: "beta", key: fakeKeys[1], projectId: "project-a", priority: 2 }
  ]);
  stub((call) => {
    if (!call.url.includes(":generateContent")) return responseJson({ models: [] });
    if (call.key === fakeKeys[0]) return responseJson({ error: { message: "Too many requests per minute. Retry in 20 seconds." } }, 429);
    return responseJson({ candidates: [{ content: { parts: [{ text: "second key worked" }] } }] });
  });
  assert.equal(await ai.gemini("Retry safely"), "second key worked", "a key-level rate limit rotates to the next key");
  assert.deepEqual(generateCalls().map((call) => call.key), [fakeKeys[0], fakeKeys[1]]);

  /* An explicit keyring with no project ids is deliberately conservative: those
     keys might share one project, so one spent allowance parks the ring. */
  configure([
    { id: "unknown-a", key: fakeKeys[0], priority: 1 },
    { id: "unknown-b", key: fakeKeys[1], priority: 2 }
  ]);
  stub((call) => {
    if (!call.url.includes(":generateContent")) return responseJson({ models: [] });
    return responseJson({ error: { message: "Quota exceeded for project." } }, 429);
  });
  await assert.rejects(() => ai.gemini("Do not assume spare quota"), (error) => error.code === "ai_quota_exhausted");
  assert.equal(generateCalls().length, 1, "an unlabelled keyring shares one conservative quota group");

  configure([
    { id: "disabled", key: "fake-disabled-key-0004", projectId: "project-a", enabled: false },
    { id: "enabled", key: fakeKeys[2], projectId: "project-b", enabled: true }
  ]);
  assert.equal(ai.geminiKey(), fakeKeys[2], "disabled keys are never selected");
  assert.equal(ai.geminiConfigured(), true);

  /* ---- one Gmail account per API key ------------------------------------ */
  /* Five keys created from five different Google accounts are five separate
     free-tier allowances. A spent allowance on the first must rotate to the
     second, not park the whole ring: that is the entire point of five accounts. */
  ai.resetGeminiKeyHealth();
  for (const name of Object.keys(ENV)) if (name.startsWith("SHINZORA_AI_")) delete ENV[name];
  ENV.SHINZORA_AI_MODEL = "gemini-3.8-flash";
  ENV.SHINZORA_AI_MODEL_FALLBACKS = "";
  ENV.SHINZORA_AI_API_KEY_1 = "account-one-key-000000001";
  ENV.SHINZORA_AI_API_KEY_2 = "account-two-key-000000002";
  ENV.SHINZORA_AI_API_KEY_3 = "account-three-key-000003";
  ai.resetGeminiKeyHealth();

  const projects = ai.geminiKeyMetadata().map((entry) => entry.projectId);
  assert.equal(new Set(projects).size, 3, "each numbered key is its own quota pool by default");
  assert.ok(projects.every((id) => !id.includes("unclassified")), "numbered keys are not lumped into one shared pool");

  stub((call) => {
    if (!call.url.includes(":generateContent")) return responseJson({ models: [] });
    if (call.key === "account-one-key-000000001") {
      return responseJson({ error: { message: "You exceeded your current quota." } }, 429);
    }
    return responseJson({ candidates: [{ content: { parts: [{ text: "second account answered" }] } }] });
  });
  const fromSecond = await ai.gemini("Use another account");
  assert.equal(fromSecond, "second account answered", "a spent daily quota rotates to the next account");
  assert.deepEqual(
    generateCalls().map((call) => call.key),
    ["account-one-key-000000001", "account-two-key-000000002"],
    "exactly two accounts were tried, in order"
  );

  /* Opting back in to a shared pool restores the conservative behaviour. */
  ai.resetGeminiKeyHealth();
  ENV.SHINZORA_AI_SHARED_QUOTA = "1";
  const grouped = ai.geminiKeyMetadata().map((entry) => entry.projectId);
  assert.equal(new Set(grouped).size, 1, "SHINZORA_AI_SHARED_QUOTA=1 puts every key in one pool");
  delete ENV.SHINZORA_AI_SHARED_QUOTA;

  /* An explicit per-slot project wins over both defaults. */
  ai.resetGeminiKeyHealth();
  ENV.SHINZORA_AI_KEY_PROJECT_2 = "google-project-two";
  const labelled = ai.geminiKeyMetadata();
  assert.equal(labelled.find((entry) => entry.id === "env-2")?.projectId, "google-project-two", "a slot can state its project");
  delete ENV.SHINZORA_AI_KEY_PROJECT_2;
  for (const name of Object.keys(ENV)) if (name.startsWith("SHINZORA_AI_API_KEY_")) delete ENV[name];
  ai.resetGeminiKeyHealth();

  /* Restore a normal ring for the scenarios that follow. */
  configure([{ id: "alpha", key: fakeKeys[0], projectId: "project-a", priority: 1 }]);

  /* ---- automatic model switching ---------------------------------------- */
  ai.resetGeminiModelHealth();

  // A congested model is demoted to the end, never dropped from the chain.
  ai.resetGeminiModelHealth();
  stub(() => responseJson({}, 503));
  try { await ai.gemini("hi", { model: "gemini-3.8-flash" }); } catch { /* expected */ }
  const health = ai.geminiModelHealth();
  assert.ok(health.some((entry) => entry.model === "gemini-3.8-flash" && entry.coolingForMs > 0), "a 503 parks the model");
  const order = ai.orderChainByHealth(["gemini-3.8-flash", "gemini-3.5-flash"]);
  assert.equal(order[order.length - 1], "gemini-3.8-flash", "the cooling model is tried last");
  assert.equal(order.length, 2, "the chain never loses a model");

  // A 400 is a request-shape problem: recoverable, and it relaxes the body.
  ai.resetGeminiModelHealth();
  configure([{ id: "alpha", key: fakeKeys[0], projectId: "project-a", priority: 1 }]);
  let sawLeanBody = false;
  stub((call) => {
    const body = JSON.parse(call.init?.body ?? "{}");
    const hasJsonMode = body?.generationConfig?.responseMimeType === "application/json";
    if (hasJsonMode) {
      return responseJson({ error: { status: "INVALID_ARGUMENT", message: "temperature must be in the range [0.0, 2.0]" } }, 400);
    }
    sawLeanBody = true;
    return responseJson({ candidates: [{ content: { parts: [{ text: "answered" }] } }] });
  });
  const recovered = await ai.gemini("hi", { model: "gemini-3.8-flash", json: true });
  assert.equal(recovered, "answered", "a shape 400 is retried with a relaxed body");
  assert.ok(sawLeanBody, "the retry actually dropped the rejected parameters");

  // A rejected credential is never mistaken for a shape problem.
  const keyError = ai.providerError(400, '{"error":{"code":400,"message":"API key not valid. Please pass a valid API key.","status":"INVALID_ARGUMENT","details":[{"reason":"API_KEY_INVALID"}]}}');
  assert.notEqual(keyError.code, "ai_request_rejected", "a bad key is not retried as a shape error");

  /* ---- the configured model is the ONLY model --------------------------- */
  /* The owner pinned gemini-3.8-flash. Discovery must never widen the chain:
     an unrequested fallback changes output shape, latency and cost. */
  ai.resetGeminiModelHealth();
  configure([{ id: "alpha", key: fakeKeys[0], projectId: "project-a", priority: 1 }]);
  stub(() => responseJson({
    models: [
      { name: "models/gemini-3.8-flash", supportedGenerationMethods: ["generateContent"] },
      { name: "models/gemini-3.5-flash", supportedGenerationMethods: ["generateContent"] },
      { name: "models/gemini-flash-lite-latest", supportedGenerationMethods: ["generateContent"] }
    ]
  }));
  const chain = await ai.resolvedModelChain("site");
  assert.deepEqual(chain, ["gemini-3.8-flash"], "only the configured model is in the chain");
  assert.ok(!chain.includes("gemini-3.5-flash"), "a discovered sibling is not silently added");
  assert.ok(!chain.includes("gemini-flash-lite-latest"), "a discovered lite model is not silently added");

  /* And with the model congested, the request fails honestly instead of
     answering from a different model. */
  ai.resetGeminiModelHealth();
  configure([{ id: "alpha", key: fakeKeys[0], projectId: "project-a", priority: 1 }]);
  stub(() => responseJson({ error: { status: "UNAVAILABLE" } }, 503));
  let busy = null;
  try {
    await ai.gemini("hi");
  } catch (error) {
    busy = error;
  }
  assert.equal(busy?.code, "ai_model_busy", "a congested model reports busy, not a provider code");
  assert.ok(!/provider error \(503\)/i.test(busy?.message ?? ""), "no raw status code reaches the customer");
  assert.ok(/allowance/i.test(busy?.message ?? ""), "the customer is told nothing was charged");
  const modelsTried = new Set(generateCalls().map((call) => (call.url.match(/models\/([^:]+):/) ?? [])[1]));
  assert.deepEqual([...modelsTried], ["gemini-3.8-flash"], "no other model was called");

  globalThis.fetch = originalFetch;
  console.log("  ✓ Gemini keyring priority, same-model failover, project quota grouping, per-key rate limits, disabled keys, and URL secrecy");
  console.log("  ✓ model auto-switching: congestion demotes, shape 400s recover, bad keys stay bad");
  console.log("  ✓ the configured model is the only model: discovery never widens the chain");
  console.log("  ✓ five accounts are five quota pools: a spent allowance rotates instead of parking the ring");
} finally {
  rmSync(dir, { recursive: true, force: true });
}
