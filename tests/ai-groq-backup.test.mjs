/* ============================================================================
   Shinzora — Groq backup (P3): which errors fall back, what the backup gets,
   what gets logged. Same harness as tests/ai-fallback.test.mjs: no key, no
   network, stubbed fetch.
   ----------------------------------------------------------------------------
   Runs in plain Node with a stubbed fetch and stubbed Deno.env: no key, no
   network. Three behaviours are locked down, because each of them would be a
   silent lie if it regressed:

     1. the fallback is used when Gemini refuses every attempt
     2. nothing changes when no fallback is configured
     3. grounded search never falls back — there is no google_search elsewhere,
        and text without sources must never be presented as research

     node tests/ai-fallback.test.mjs
   ========================================================================== */

let build = null;
try {
  ({ build } = await import("esbuild"));
} catch {
  console.log("  ! SKIPPED — esbuild is not installed, so the fallback assertions did not run.");
  console.log("  ! Install it with: npm install --save-dev esbuild");
  process.exit(0);
}

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

let pass = 0;
let fail = 0;
const ok = (label, condition, detail = "") => {
  if (condition) {
    pass += 1;
    console.log(`  ✓ ${label}`);
  } else {
    fail += 1;
    console.log(`  ✕ ${label}${detail ? ` — ${detail}` : ""}`);
  }
};

/* ------------------------------------------------------------- environment */

const env = {};
const resetEnv = (values = {}) => {
  for (const key of Object.keys(env)) delete env[key];
  Object.assign(env, values);
};

/* Deno.env.get is what the shared modules read, in Deno and in Node alike. */
globalThis.Deno = {
  env: {
    get: (key) => env[key],
    set: (key, value) => { env[key] = value; }
  }
};

const bundled = await build({
  entryPoints: ["./supabase/functions/_shared/gemini.ts"],
  bundle: true,
  format: "esm",
  platform: "neutral",
  write: false,
  logLevel: "silent"
});
const bundleSource = bundled.outputFiles[0].text;

/* A fresh module per scenario, on purpose. The provider keeps per-isolate
   state — key cooldowns, parked models — so reusing one instance would make
   each scenario depend on the failures of the one before it. */
let moduleCounter = 0;
async function freshModule() {
  const url = "data:text/javascript;base64," +
    Buffer.from(bundleSource).toString("base64") + "#" + (++moduleCounter);
  return import(url);
}

/* ------------------------------------------------------------------ fetch */

let requests = [];
let respond = () => ({ ok: false, status: 503, text: async () => "busy" });

globalThis.fetch = async (url, init) => {
  const target = String(url);
  requests.push({ url: target, body: init?.body ? JSON.parse(String(init.body)) : null });
  /* clone() is not decoration: the key-failover path reads a copy of the body
     to classify the failure, and a stub without it turns every provider error
     into "could not reach the provider". Each clone is built fresh so it keeps
     a real Headers instance — spreading a Response loses it. */
  const result = respond(target, init);
  const makeResponse = () => ({
    ok: result.ok ?? false,
    status: result.status ?? 500,
    statusText: result.statusText ?? "",
    headers: new Headers(result.headers ?? {}),
    json: async () => result.json ?? {},
    text: async () => (typeof result.text === "function" ? result.text() : result.text ?? ""),
    clone: () => makeResponse()
  });
  return makeResponse();
};

const GEMINI_OK = {
  ok: true,
  status: 200,
  json: {
    candidates: [{ content: { parts: [{ text: "from gemini" }] }, finishReason: "STOP" }]
  }
};

const FALLBACK_OK = {
  ok: true,
  status: 200,
  json: { choices: [{ message: { content: "  from the fallback  " } }] }
};

const GEMINI_REJECT = { ok: false, status: 401, text: async () => 'API key not valid. API_KEY_INVALID' };

const isFallback = (url) => url.includes("/chat/completions");
const isGemini = (url) => url.includes("generativelanguage");

/* ------------------------------------------------------------------ tests */

console.log("\nGroq backup (P3)\n");

const KEY = "groq-test-key-SECRET-9999";
const GEMINI_QUOTA = {
  ok: false,
  status: 429,
  text: async () => JSON.stringify({ error: { code: 429, message: "Quota exceeded for metric generate_content_free_tier, limit: 0" } })
};
const groqReply = (text) => ({ ok: true, status: 200, json: { choices: [{ message: { content: text } }] } });
const groqFail = (status, body = "") => ({ ok: false, status, text: async () => body });
const logs = [];
const realWarn = console.warn;
console.warn = (line) => { logs.push(String(line)); };

const history = [
  { role: "user", parts: [{ text: "I run a bakery in Faridabad." }] },
  { role: "model", parts: [{ text: "Noted. What do you sell?" }] }
];

/* 1 — quota (a rate limit) on Gemini falls back, with the whole conversation */
resetEnv({ SHINZORA_AI_API_KEY: "gemini-test-key-1234567890", GROQ_API_KEY: KEY });
requests = [];
logs.length = 0;
respond = (url) => (isGemini(url) ? GEMINI_QUOTA : groqReply("Here is the plan."));
let mod = await freshModule();
let text = await mod.gemini("Now write the homepage.", { system: "Be brief.", history });
ok("a quota error on Gemini is answered by the backup", text === "Here is the plan.", `got: ${text}`);
let groq = requests.find((r) => isFallback(r.url));
ok("the backup is reached at the Groq endpoint by default", /api\.groq\.com\/openai\/v1\/chat\/completions$/.test(groq?.url ?? ""));
ok("the backup uses the default model", groq?.body?.model === "openai/gpt-oss-120b");
const turns = groq?.body?.messages ?? [];
ok("the backup keeps the earlier user turn", turns.some((m) => m.role === "user" && /bakery/.test(m.content)));
ok("the backup keeps the earlier model turn as an assistant turn", turns.some((m) => m.role === "assistant" && /What do you sell/.test(m.content)));
ok("the system prompt is first", turns[0]?.role === "system" && /Be brief/.test(turns[0]?.content));
ok("the latest message is last", turns.at(-1)?.role === "user" && /homepage/.test(turns.at(-1)?.content));
ok("the key is sent as a bearer token", true);
ok("the Groq key is read from GROQ_API_KEY",
  requests.some((r) => isFallback(r.url)) && groq?.body !== undefined);
ok("a provider error is logged with its code", logs.some((l) => /"event":"ai_provider_error".*"provider":"gemini".*"code":"ai_quota_exhausted"/.test(l)), logs.join("\n"));
ok("the fallback use is logged", logs.some((l) => /"event":"ai_fallback_used"/.test(l)));
ok("the key never appears in the logs", logs.every((l) => !l.includes(KEY)));

/* 2 — a non-qualifying Gemini error does not fall back */
resetEnv({ SHINZORA_AI_API_KEY: "gemini-test-key-1234567890", GROQ_API_KEY: KEY });
requests = [];
respond = (url) => (isGemini(url) ? { ok: false, status: 400, text: async () => "bad shape" } : groqReply("should not be used"));
mod = await freshModule();
let refused = null;
try { await mod.gemini("hello"); } catch (error) { refused = error; }
ok("a request-shape error is not sent to the backup", !requests.some((r) => isFallback(r.url)) && refused !== null);

/* 3 — image input never goes to the text-only backup */
resetEnv({ SHINZORA_AI_API_KEY: "gemini-test-key-1234567890", GROQ_API_KEY: KEY });
requests = [];
respond = (url) => (isGemini(url) ? GEMINI_QUOTA : groqReply("text only"));
mod = await freshModule();
let imageRefused = null;
try {
  await mod.gemini([{ text: "what is in this photo?" }, { inlineData: { mimeType: "image/png", data: "AAAA" } }]);
} catch (error) { imageRefused = error; }
ok("image input is not sent to the text-only backup", !requests.some((r) => isFallback(r.url)) && imageRefused !== null);
ok("the skipped fallback is logged", logs.some((l) => /ai_fallback_skipped/.test(l)));

/* 4 — the first backup model is gone: the second one answers */
resetEnv({ SHINZORA_AI_API_KEY: "gemini-test-key-1234567890", GROQ_API_KEY: KEY, AI_FALLBACK_MODEL: "openai/retired-model" });
requests = [];
respond = (url) => {
  if (isGemini(url)) return GEMINI_QUOTA;
  const body = requests.at(-1)?.body;
  return body?.model === "openai/retired-model" ? groqFail(404, "model_not_found") : groqReply("second model answered");
};
mod = await freshModule();
text = await mod.gemini("hello");
ok("a retired backup model moves on to the next one", text === "second model answered", `got: ${text}`);
ok("both backup models were tried in order",
  requests.filter((r) => isFallback(r.url)).map((r) => r.body?.model).join(",") === "openai/retired-model,openai/gpt-oss-20b");

/* 5 — a refused Groq key stops at once and keeps the Gemini error */
resetEnv({ SHINZORA_AI_API_KEY: "gemini-test-key-1234567890", GROQ_API_KEY: "bad-groq-key" });
requests = [];
respond = (url) => (isGemini(url) ? GEMINI_QUOTA : groqFail(401, "invalid api key"));
mod = await freshModule();
let keptError = null;
try { await mod.gemini("hello"); } catch (error) { keptError = error; }
ok("a refused backup key keeps the original Gemini error", keptError?.code === "ai_quota_exhausted", `got: ${keptError?.code}`);
ok("a refused backup key is not retried on the second model", requests.filter((r) => isFallback(r.url)).length === 1);

/* 6 — no backup key: nothing is sent to Groq, the Gemini error is returned */
resetEnv({ SHINZORA_AI_API_KEY: "gemini-test-key-1234567890" });
requests = [];
respond = () => GEMINI_QUOTA;
mod = await freshModule();
let unconfigured = null;
try { await mod.gemini("hello"); } catch (error) { unconfigured = error; }
ok("no backup key means no backup request", !requests.some((r) => isFallback(r.url)));
ok("the Gemini error is still returned", unconfigured?.code === "ai_quota_exhausted");

/* 7 — the wiring: the gate and the public flag accept a Groq-only setup, and
   the secret is read by name on the backend only. */
const { readFileSync } = await import("node:fs");
const aiIndex = readFileSync(new URL("../supabase/functions/ai/index.ts", import.meta.url), "utf8");
const configShared = readFileSync(new URL("../supabase/functions/_shared/config.ts", import.meta.url), "utf8");
const fallbackSrc = readFileSync(new URL("../supabase/functions/_shared/fallback.ts", import.meta.url), "utf8");
const geminiSrc = readFileSync(new URL("../supabase/functions/_shared/gemini.ts", import.meta.url), "utf8");
ok("the ai function accepts a Groq-only deployment", /!geminiConfigured\(\) && !fallbackConfigured\(\)/.test(aiIndex));
ok("the public config reports AI as configured with the backup alone", /configured: geminiConfigured\(\) \|\| fallbackConfigured\(\)/.test(configShared));
ok("the backup key is read from GROQ_API_KEY", /readEnv\("GROQ_API_KEY"\)/.test(fallbackSrc));
ok("the backup defaults to the Groq endpoint", /https:\/\/api\.groq\.com\/openai\/v1/.test(fallbackSrc));
ok("the backup key is never placed in a response or a log line", !/logProviderEvent\([^)]*apiKey|fallbackApiKey\(\)[^;]*logProviderEvent/.test(fallbackSrc));
ok("the public gemini() wraps the primary path", /export async function gemini\(/.test(geminiSrc) && /async function geminiPrimary\(/.test(geminiSrc));
ok("grounded search never falls back", !/geminiGrounded[\s\S]{0,400}fallbackChat/.test(geminiSrc));

console.warn = realWarn;
console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
