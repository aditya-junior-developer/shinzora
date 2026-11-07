// ============================================================================
// Shinzora · Edge Functions — Gemini client tests
// ----------------------------------------------------------------------------
// These run without a Google API key and without a network: `fetch` is stubbed.
// They lock down the two things that must never regress in a server-side AI
// client:
//
//   1. an unconfigured deployment fails with a clear, stable error code instead
//      of calling out with an empty key
//   2. the key travels in a request header and can never appear in an error
//      message, a thrown value or a log line
//
//   deno test --allow-env supabase/functions/_shared/gemini.test.ts
// ============================================================================

import { assertEquals, assertRejects, assertStringIncludes } from "jsr:@std/assert@1";
import { defaultModel, GeminiError, estimateTokens, gemini, geminiConfigured, geminiJson, geminiKey, modelChain } from "./gemini.ts";

const KEY_VARS = ["SHINZORA_AI_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY"] as const;

function clearKeys() {
  for (const name of KEY_VARS) Deno.env.delete(name);
}

function withKeys(values: Partial<Record<(typeof KEY_VARS)[number], string>>) {
  clearKeys();
  for (const [name, value] of Object.entries(values)) Deno.env.set(name, value as string);
}

type Captured = { url: string; init: RequestInit };

/** Replace global fetch with a scripted response and capture the request. */
/** Only the generation calls — discovery lists models on the same fetch. */
const generationCalls = (calls: Captured[]) => calls.filter((call) => /:generateContent$/.test(call.url));

function stubFetch(handler: (call: Captured) => Response | Promise<Response>) {
  const original = globalThis.fetch;
  const calls: Captured[] = [];
  globalThis.fetch = ((url: string | URL | Request, init: RequestInit = {}) => {
    const call = { url: String(url), init };
    calls.push(call);
    return Promise.resolve(handler(call));
  }) as typeof fetch;
  return {
    calls,
    restore: () => {
      globalThis.fetch = original;
    }
  };
}

const okResponse = (text: string) =>
  new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }] }), {
    status: 200,
    headers: { "content-type": "application/json" }
  });

/* ------------------------------------------------------------ key handling */

Deno.test("no key configured: reads as unconfigured and refuses to call out", async () => {
  clearKeys();
  assertEquals(geminiKey(), "");
  assertEquals(geminiConfigured(), false);

  const stub = stubFetch(() => okResponse("should not happen"));
  try {
    const error = await assertRejects(() => gemini("hello"), GeminiError);
    assertEquals(error.code, "functions_unavailable");
    assertEquals(error.status, 503);
    assertStringIncludes(error.message.toLowerCase(), "not configured");
    assertEquals(stub.calls.length, 0, "no request may leave the server without a key");
  } finally {
    stub.restore();
  }
});

Deno.test("a key shorter than a real key counts as unconfigured", () => {
  withKeys({ SHINZORA_AI_API_KEY: "short" });
  assertEquals(geminiConfigured(), false);
  clearKeys();
});

Deno.test("key precedence: SHINZORA_AI_API_KEY beats GEMINI_API_KEY beats GOOGLE_API_KEY", () => {
  withKeys({ SHINZORA_AI_API_KEY: "primary-key-0000000000", GEMINI_API_KEY: "secondary-key-0000", GOOGLE_API_KEY: "tertiary-key-00000" });
  assertEquals(geminiKey(), "primary-key-0000000000");

  withKeys({ GEMINI_API_KEY: "secondary-key-0000", GOOGLE_API_KEY: "tertiary-key-00000" });
  assertEquals(geminiKey(), "secondary-key-0000");

  withKeys({ GOOGLE_API_KEY: "tertiary-key-00000" });
  assertEquals(geminiKey(), "tertiary-key-00000");
  clearKeys();
});

Deno.test("surrounding whitespace in the secret is tolerated", () => {
  withKeys({ SHINZORA_AI_API_KEY: "  key-with-padding-0000000  \n" });
  assertEquals(geminiKey(), "key-with-padding-0000000");
  clearKeys();
});

/* ------------------------------------------------------------ request shape */

Deno.test("the key travels in a header, never in the URL", async () => {
  withKeys({ SHINZORA_AI_API_KEY: "secret-key-value-000000000" });
  const stub = stubFetch(() => okResponse("Hi there"));
  try {
    const text = await gemini("Say hi", { system: "Be brief", temperature: 0.2, maxOutputTokens: 64 });
    assertEquals(text, "Hi there");

    const [call] = stub.calls;
    assertEquals(call.url.includes("key="), false, "the key must not be a query parameter");
    assertEquals(call.url.includes("secret-key-value"), false, "the key must not appear in the URL at all");
    const headers = new Headers(call.init.headers);
    assertEquals(headers.get("x-goog-api-key"), "secret-key-value-000000000");

    const body = JSON.parse(String(call.init.body));
    assertEquals(body.systemInstruction.parts[0].text, "Be brief");
    assertEquals(body.generationConfig.temperature, 0.2);
    assertEquals(body.generationConfig.maxOutputTokens, 64);
    assertEquals(body.contents.at(-1).parts[0].text, "Say hi");
    assertStringIncludes(call.url, defaultModel());
  } finally {
    stub.restore();
    clearKeys();
  }
});

Deno.test("json mode asks for a JSON mime type", async () => {
  withKeys({ SHINZORA_AI_API_KEY: "secret-key-value-000000000" });
  const stub = stubFetch(() => okResponse('{"ok":true}'));
  try {
    await gemini("give me json", { json: true });
    const body = JSON.parse(String(stub.calls[0].init.body));
    assertEquals(body.generationConfig.responseMimeType, "application/json");
  } finally {
    stub.restore();
    clearKeys();
  }
});

/* ---------------------------------------------------------- error contracts */

Deno.test("a rejected key is reported without echoing the key back", async () => {
  withKeys({ SHINZORA_AI_API_KEY: "secret-key-value-000000000" });
  const stub = stubFetch(
    () => new Response(JSON.stringify({ error: { message: "API key not valid. Please pass a valid API key." } }), { status: 400 })
  );
  try {
    const error = await assertRejects(() => gemini("hi"), GeminiError);
    assertEquals(error.code, "ai_bad_key");
    assertEquals(error.message.includes("secret-key-value"), false);
    assertEquals(JSON.stringify(error).includes("secret-key-value"), false);
  } finally {
    stub.restore();
    clearKeys();
  }
});

Deno.test("rate limiting has its own code so the UI can say something useful", async () => {
  withKeys({ SHINZORA_AI_API_KEY: "secret-key-value-000000000" });
  const stub = stubFetch(() => new Response("quota", { status: 429 }));
  try {
    const error = await assertRejects(() => gemini("hi"), GeminiError);
    assertEquals(error.code, "ai_rate_limited");
    assertEquals(error.status, 429);
  } finally {
    stub.restore();
    clearKeys();
  }
});

Deno.test("an empty candidate is an error, not an empty string", async () => {
  withKeys({ SHINZORA_AI_API_KEY: "secret-key-value-000000000" });
  const stub = stubFetch(() => new Response(JSON.stringify({ candidates: [] }), { status: 200 }));
  try {
    await assertRejects(() => gemini("hi"), GeminiError, "empty response");
  } finally {
    stub.restore();
    clearKeys();
  }
});

Deno.test("a safety block is explained rather than swallowed", async () => {
  withKeys({ SHINZORA_AI_API_KEY: "secret-key-value-000000000" });
  const stub = stubFetch(() =>
    new Response(JSON.stringify({ promptFeedback: { blockReason: "SAFETY" }, candidates: [] }), { status: 200 })
  );
  try {
    const error = await assertRejects(() => gemini("hi"), GeminiError);
    assertEquals(error.code, "ai_blocked");
    assertStringIncludes(error.message.toLowerCase(), "safety");
  } finally {
    stub.restore();
    clearKeys();
  }
});

Deno.test("network failure is not reported as a provider error", async () => {
  withKeys({ SHINZORA_AI_API_KEY: "secret-key-value-000000000" });
  const stub = stubFetch(() => {
    throw new TypeError("connection reset");
  });
  try {
    const error = await assertRejects(() => gemini("hi"), GeminiError);
    assertEquals(error.code, "ai_unreachable");
    assertEquals(error.status, 502);
  } finally {
    stub.restore();
    clearKeys();
  }
});

/* ------------------------------------------------------------ JSON parsing */

Deno.test("JSON survives code fences and surrounding prose", async () => {
  withKeys({ SHINZORA_AI_API_KEY: "secret-key-value-000000000" });

  for (const raw of ['{"a":1}', '```json\n{"a":1}\n```', 'Here you go:\n{"a":1}\nAnything else?']) {
    const stub = stubFetch(() => okResponse(raw));
    try {
      const parsed = await geminiJson<{ a: number }>("give me json");
      assertEquals(parsed.a, 1);
    } finally {
      stub.restore();
    }
  }
  clearKeys();
});

Deno.test("unparseable output raises ai_bad_json instead of returning junk", async () => {
  withKeys({ SHINZORA_AI_API_KEY: "secret-key-value-000000000" });
  const stub = stubFetch(() => okResponse("I cannot help with that."));
  try {
    const error = await assertRejects(() => geminiJson("give me json"), GeminiError);
    assertEquals(error.code, "ai_bad_json");
  } finally {
    stub.restore();
    clearKeys();
  }
});

/* ------------------------------------------------------------------ tokens */

Deno.test("token estimate is never zero", () => {
  assertEquals(estimateTokens(""), 1);
  assertEquals(estimateTokens("abcd"), 1);
  assertEquals(estimateTokens("a".repeat(400)), 100);
});

/* ---------------------------------------------------------- model fallback */

Deno.test("a 503 on the primary model falls through to the next one", async () => {
  withKeys({ SHINZORA_AI_API_KEY: "secret-key-value-000000000" });
  Deno.env.set("SHINZORA_AI_MODEL", "model-a");
  Deno.env.set("SHINZORA_AI_MODEL_FALLBACKS", "model-b,model-c");

  let call = 0;
  const stub = stubFetch(() => {
    call++;
    if (call === 1) return new Response("overloaded", { status: 503 });
    return okResponse("served by the fallback");
  });
  try {
    const text = await gemini("hi");
    assertEquals(text, "served by the fallback");
    assertEquals(stub.calls.length, 2, "one retry, not a loop");
    assertStringIncludes(stub.calls[0].url, "model-a");
    assertStringIncludes(stub.calls[1].url, "model-b");
  } finally {
    stub.restore();
    Deno.env.delete("SHINZORA_AI_MODEL");
    Deno.env.delete("SHINZORA_AI_MODEL_FALLBACKS");
    clearKeys();
  }
});

Deno.test("a retired model (404) also falls through", async () => {
  withKeys({ SHINZORA_AI_API_KEY: "secret-key-value-000000000" });
  Deno.env.set("SHINZORA_AI_MODEL", "gemini-retired");
  let call = 0;
  const stub = stubFetch(() => (++call === 1 ? new Response("no such model", { status: 404 }) : okResponse("ok")));
  try {
    assertEquals(await gemini("hi"), "ok");
    assertEquals(stub.calls.length, 2);
  } finally {
    stub.restore();
    Deno.env.delete("SHINZORA_AI_MODEL");
    clearKeys();
  }
});

Deno.test("a rejected key is never retried against another model", async () => {
  withKeys({ SHINZORA_AI_API_KEY: "secret-key-value-000000000" });
  const stub = stubFetch(
    () => new Response(JSON.stringify({ error: { message: "API key not valid" } }), { status: 400 })
  );
  try {
    const error = await assertRejects(() => gemini("hi"), GeminiError);
    assertEquals(error.code, "ai_bad_key");
    assertEquals(generationCalls(stub.calls).length, 1, "retrying a bad key would just burn quota");
  } finally {
    stub.restore();
    clearKeys();
  }
});

Deno.test("when every model is unavailable the error still names a code", async () => {
  withKeys({ SHINZORA_AI_API_KEY: "secret-key-value-000000000" });
  const stub = stubFetch(() => new Response("shedding load", { status: 503 }));
  try {
    const error = await assertRejects(() => gemini("hi"), GeminiError);
    assertEquals(error.code, "ai_provider_error");
    /* Discovery also answers 503 here, so the live list is empty and the
       configured chain is what gets tried — once each. */
    assertEquals(generationCalls(stub.calls).length, modelChain().length, "every model in the chain was tried once");
  } finally {
    stub.restore();
    clearKeys();
  }
});

Deno.test("the chain is ordered, de-duplicated and always non-empty", () => {
  Deno.env.set("SHINZORA_AI_MODEL", "primary-x");
  Deno.env.set("SHINZORA_AI_MODEL_FALLBACKS", "primary-x, fallback-y ,, fallback-y");
  const chain = modelChain();
  assertEquals(chain.slice(0, 2), ["primary-x", "fallback-y"], "primary first, then the configured fallbacks, no duplicates");
  assertEquals(chain.length >= 2, true);
  Deno.env.delete("SHINZORA_AI_MODEL");
  Deno.env.delete("SHINZORA_AI_MODEL_FALLBACKS");
});
