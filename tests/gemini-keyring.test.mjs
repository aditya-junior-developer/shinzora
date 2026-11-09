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

  configure([
    { id: "unknown-a", key: fakeKeys[0], priority: 1 },
    { id: "unknown-b", key: fakeKeys[1], priority: 2 }
  ]);
  stub((call) => {
    if (!call.url.includes(":generateContent")) return responseJson({ models: [] });
    return responseJson({ error: { message: "Quota exceeded for project." } }, 429);
  });
  await assert.rejects(() => ai.gemini("Do not assume spare quota"), (error) => error.code === "ai_quota_exhausted");
  assert.equal(generateCalls().length, 1, "keys without project assignments share a conservative quota group");

  configure([
    { id: "disabled", key: "fake-disabled-key-0004", projectId: "project-a", enabled: false },
    { id: "enabled", key: fakeKeys[2], projectId: "project-b", enabled: true }
  ]);
  assert.equal(ai.geminiKey(), fakeKeys[2], "disabled keys are never selected");
  assert.equal(ai.geminiConfigured(), true);

  globalThis.fetch = originalFetch;
  console.log("  ✓ Gemini keyring priority, same-model failover, project quota grouping, per-key rate limits, disabled keys, and URL secrecy");
} finally {
  rmSync(dir, { recursive: true, force: true });
}
