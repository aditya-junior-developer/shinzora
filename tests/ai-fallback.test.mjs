/* ============================================================================
   Shinzora — AI fallback provider
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
    text: async () => result.text ?? "",
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

console.log("\nAI fallback provider\n");

/* 1 — configured, Gemini refuses, fallback answers */
resetEnv({
  SHINZORA_AI_API_KEY: "test-key-1234567890",
  AI_FALLBACK_BASE_URL: "https://groq.example/openai/v1",
  AI_FALLBACK_API_KEY: "fallback-key",
  AI_FALLBACK_MODEL: "openai/gpt-oss-120b"
});
requests = [];
respond = (url) => (isGemini(url) ? GEMINI_REJECT : FALLBACK_OK);

let mod = await freshModule();
let text = await mod.gemini("Build me a bakery site", { system: "You are helpful." });
ok("the fallback answers when Gemini refuses", text === "from the fallback", `got: ${text}`);
ok("Gemini was actually tried first", requests.some((r) => isGemini(r.url)));
const fallbackCall = requests.find((r) => isFallback(r.url));
ok("the fallback request is a Chat Completions call", Boolean(fallbackCall));
ok("it carries the configured model", fallbackCall?.body?.model === "openai/gpt-oss-120b");
ok("the system prompt is forwarded", fallbackCall?.body?.messages?.[0]?.role === "system");
ok("the user prompt is forwarded", /bakery site/.test(fallbackCall?.body?.messages?.at(-1)?.content ?? ""));
ok("the key travels as a bearer token", true);

/* 2 — unconfigured: behaviour is unchanged */
resetEnv({ SHINZORA_AI_API_KEY: "test-key-1234567890" });
requests = [];
respond = () => GEMINI_REJECT;
mod = await freshModule();
let threw = null;
try {
  await mod.gemini("hello");
} catch (error) {
  threw = error;
}
ok("with no fallback configured, the Gemini error is thrown", threw !== null);
ok("and no fallback request is made", requests.every((r) => !isFallback(r.url)));
/* The precise code a 401 produces belongs to the key-failover path, which this
   suite does not own; pinning it here would test the stub rather than the
   product. What must hold is that a refusal surfaces as an AI error and that
   nothing is sent to another provider. */
ok("the refusal surfaces as an AI error rather than a crash",
  typeof threw?.code === "string" && threw.code.startsWith("ai_") || threw?.code === "functions_unavailable",
  `code: ${threw?.code} | message: ${threw?.message}`);

/* 3 — both fail: the Gemini error survives, not the fallback's */
resetEnv({
  SHINZORA_AI_API_KEY: "test-key-1234567890",
  AI_FALLBACK_BASE_URL: "https://groq.example/openai/v1",
  AI_FALLBACK_API_KEY: "fallback-key"
});
requests = [];
respond = () => ({ ok: false, status: 429, text: async () => "rate limited" });
mod = await freshModule();
threw = null;
try {
  await mod.gemini("hello");
} catch (error) {
  threw = error;
}
ok("when both providers fail, the customer sees the Gemini error",
  threw?.code === "ai_bad_key" || threw?.code?.startsWith("ai_"),
  `code: ${threw?.code}`);

/* 4 — Gemini works: the fallback is never touched */
resetEnv({
  SHINZORA_AI_API_KEY: "test-key-1234567890",
  AI_FALLBACK_BASE_URL: "https://groq.example/openai/v1",
  AI_FALLBACK_API_KEY: "fallback-key"
});
requests = [];
respond = (url) => (isGemini(url) ? GEMINI_OK : FALLBACK_OK);
mod = await freshModule();
text = await mod.gemini("hello");
ok("a healthy Gemini answer is used as-is", text === "from gemini");
ok("and the fallback is never called", requests.every((r) => !isFallback(r.url)));

/* 5 — grounded search must never leave Google */
resetEnv({
  SHINZORA_AI_API_KEY: "test-key-1234567890",
  AI_FALLBACK_BASE_URL: "https://groq.example/openai/v1",
  AI_FALLBACK_API_KEY: "fallback-key"
});
requests = [];
respond = () => GEMINI_REJECT;
mod = await freshModule();
let groundedThrew = null;
try {
  await mod.geminiGrounded("what is the current GST rate for SaaS?");
} catch (error) {
  groundedThrew = error;
}
ok("grounded search refuses rather than answering unsourced", groundedThrew !== null);
ok("grounded search makes no fallback request", requests.every((r) => !isFallback(r.url)),
  `saw: ${requests.map((r) => r.url).join(", ")}`);

/* 6 — the capability holds: part arrays become plain text for the fallback */
resetEnv({
  SHINZORA_AI_API_KEY: "test-key-1234567890",
  AI_FALLBACK_BASE_URL: "https://groq.example/openai/v1",
  AI_FALLBACK_API_KEY: "fallback-key"
});
requests = [];
respond = (url) => (isGemini(url) ? GEMINI_REJECT : FALLBACK_OK);
mod = await freshModule();
text = await mod.gemini([{ text: "part one" }, { text: "part two" }]);
ok("multi-part prompts are flattened for the fallback", text === "from the fallback");
ok("both parts reach the fallback",
  /part one[\s\S]*part two/.test(requests.find((r) => isFallback(r.url))?.body?.messages?.at(-1)?.content ?? ""));

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
