/* ============================================================================
   Shinzora — reading JSON out of a model's answer
   ----------------------------------------------------------------------------
   The bug this locks down: "Do something" → "add a product in my inventory
   named KYLO and i have 64 only" → red banner "The AI returned malformed JSON.
   Retrying usually fixes this."

   That sentence was wrong twice. The answer was *cut off* — the 500-token output
   budget was shared with thinking, so the object arrived half-written — and the
   advice ("retrying usually fixes this") sent the shopkeeper into a loop that
   could never succeed. The parser also gave up on wrappers the model produces
   routinely: ```json fences, a sentence before the object, a trailing comma,
   curly quotes pasted into a string.

   These assertions run in plain Node: no key, no network, `Deno` and `fetch`
   stubbed.

     node tests/json-repair.test.mjs
   ========================================================================== */

let build = null;
try {
  ({ build } = await import("esbuild"));
} catch {
  console.log("  ! SKIPPED — esbuild is not installed, so the JSON-repair assertions did not run.");
  console.log("  ! Install it with: npm install --save-dev esbuild");
  process.exit(0);
}
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

let pass = 0, fail = 0;
const check = (name, cond, extra = "") =>
  cond ? (pass++, console.log(`  ✓ ${name}`)) : (fail++, console.log(`  ✗ ${name} ${extra}`));

const ENV = {
  SHINZORA_AI_API_KEY: "test-key-not-a-real-one-0123456789",
  SHINZORA_AI_MODEL: "gemini-3.8-flash"
};
globalThis.Deno = { env: { get: (name) => ENV[name] ?? undefined } };

const outdir = mkdtempSync(join(tmpdir(), "shinzora-json-"));
const bundle = async (entry, name) => {
  const outfile = join(outdir, name);
  await build({ entryPoints: [entry], outfile, format: "esm", bundle: true, platform: "neutral", logLevel: "silent" });
  return import(pathToFileURL(outfile).href);
};

const repairMod = await bundle("supabase/functions/_shared/json-repair.ts", "json-repair.mjs");
const { unwrap, repair, firstJsonValue, parseModelJson } = repairMod;
const geminiMod = await bundle("supabase/functions/_shared/gemini.ts", "gemini.mjs");
const { geminiJson, GeminiError, resetGeminiKeyHealth } = geminiMod;

/* The product the shopkeeper asked for, as the model is asked to return it. */
const COMMAND = {
  understood: true,
  action: "create_product",
  payload: { name: "KYLO", price: 0, stock: 64 },
  summary: "Create KYLO with 64 in stock.",
  missing: []
};

/* ------------------------------------------------------------------ unwrap */
console.log("\nwrappers");
check("a ```json fence is removed", unwrap('```json\n{"a":1}\n```') === '{"a":1}', unwrap('```json\n{"a":1}\n```'));
check("a bare fence is removed", unwrap('```\n{"a":1}\n```') === '{"a":1}');
check("a byte-order mark is removed", unwrap('\uFEFF{"a":1}') === '{"a":1}');
check("plain JSON is left alone", unwrap('{"a":1}') === '{"a":1}');

/* ------------------------------------------------------------------ repair */
console.log("\nrepairs that carry no ambiguity");
check("a trailing comma before } is dropped", repair('{"a":1,}') === '{"a":1}');
check("a trailing comma before ] is dropped", repair('{"a":[1,2,]}') === '{"a":[1,2]}');
check("curly double quotes become straight", repair('{"name":"KYLO"}'.replace(/"/g, "\u201C")) === '{"name":"KYLO"}');
check("a real apostrophe survives", repair('{"name":"Kylo\'s"}').includes("Kylo's"));

/* --------------------------------------------------------- firstJsonValue */
console.log("\nextracting the value");
const fenced = firstJsonValue('```json\n' + JSON.stringify(COMMAND) + '\n```');
check("the fenced object parses", fenced.ok && fenced.value.action === "create_product", JSON.stringify(fenced));
check("its payload keeps the quantity", fenced.ok && fenced.value.payload.stock === 64);

const prose = firstJsonValue('Here is the command:\n{"a":1}\nLet me know if you want it changed.');
check("prose before and after is ignored", prose.ok && prose.value.a === 1, JSON.stringify(prose));

const bracesInString = firstJsonValue('{"description":"holds {large} brackets","stock":64}');
check("braces inside a string are not structure",
  bracesInString.ok && bracesInString.value.description === "holds {large} brackets", JSON.stringify(bracesInString));

const escapedQuote = firstJsonValue('{"text":"he said \\"stop\\"","n":2}');
check("an escaped quote does not end the string", escapedQuote.ok && escapedQuote.value.n === 2, JSON.stringify(escapedQuote));

const curly = firstJsonValue('{\u201Cname\u201D:\u201CKYLO\u201D,\u201Cstock\u201D:64}');
check("a curly-quoted object is read", curly.ok && curly.value.name === "KYLO", JSON.stringify(curly));

const array = firstJsonValue('[{"a":1},{"b":2}]');
check("a top-level array is read", array.ok && Array.isArray(array.value) && array.value.length === 2, JSON.stringify(array));

/* The honest failure: a half-written object must not become a half-true command. */
const cut = firstJsonValue('{"understood":true,"action":"create_product","payload":{"name":"KYL');
check("a truncated object is refused, not guessed", !cut.ok, JSON.stringify(cut));
check("and the reason says it stopped mid-JSON", /mid-JSON|incomplete/i.test(cut.ok ? "" : cut.reason), cut.reason);

check("an answer with no JSON at all is refused", !firstJsonValue("I cannot help with that.").ok);

/* --------------------------------------------------------- parseModelJson */
console.log("\nparseModelJson");
check("exact JSON parses", parseModelJson('{"a":1}').ok);
check("an empty answer is named", /returned nothing/i.test(parseModelJson("   ").reason ?? ""));
check("truncation is reported as truncation", /mid-JSON|incomplete/i.test(parseModelJson('{"a":').reason ?? ""));

/* ---------------------------------------------------- geminiJson end to end */
console.log("\ngeminiJson against a stubbed provider");
let bodies = [];
let answers = [];
globalThis.fetch = async (url, init) => {
  const target = String(url);
  if (!/models\/[^:?]+:generateContent/.test(target)) {
    return new Response(JSON.stringify({ models: [] }), { status: 200, headers: { "content-type": "application/json" } });
  }
  const body = JSON.parse(init?.body ?? "{}");
  bodies.push(body);
  const text = answers.shift() ?? "";
  const payload = { candidates: [{ content: { parts: [{ text }] }, finishReason: "STOP" }] };
  return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
};

const reset = () => { bodies = []; answers = []; resetGeminiKeyHealth(); };

reset();
answers = ["```json\n" + JSON.stringify(COMMAND) + "\n```"];
let value = await geminiJson("make a product", { json: true, maxOutputTokens: 1600 });
check("a fenced answer is returned, not thrown", value?.action === "create_product", JSON.stringify(value));
check("the request asked for JSON", bodies[0]?.generationConfig?.responseMimeType === "application/json");

reset();
answers = ["Sure — here is the command: " + JSON.stringify(COMMAND)];
value = await geminiJson("make a product", { json: true });
check("a prose-wrapped answer is returned", value?.payload?.stock === 64, JSON.stringify(value));

/* The real production failure: answer one is cut off, answer two is complete. */
reset();
const truncatedAnswer = '{"understood":true,"action":"create_product","payload":{"name":"KYLO","price":0,"sto';
answers = [truncatedAnswer, JSON.stringify(COMMAND)];
value = await geminiJson("make a product", { json: true, maxOutputTokens: 500 });
check("a truncated first answer is retried, not reported as malformed", value?.action === "create_product", JSON.stringify(value));
check("two attempts were made", bodies.length === 2, `made ${bodies.length}`);
check("the retry asks for more room", Number(bodies[1]?.generationConfig?.maxOutputTokens) === 2048, String(bodies[1]?.generationConfig?.maxOutputTokens));
check("the retry turns reasoning off", bodies[1]?.generationConfig?.thinkingConfig?.thinkingBudget === 0,
  JSON.stringify(bodies[1]?.generationConfig?.thinkingConfig));

/* Genuinely unreadable: must fail, must not pretend, must say the true reason. */
reset();
answers = ["I am not able to do that.", "Still no JSON here."];
let thrown = null;
try { await geminiJson("make a product", { json: true, maxOutputTokens: 1600 }); } catch (error) { thrown = error; }
check("an unreadable answer throws", thrown instanceof GeminiError, String(thrown));
check("it does not blame the model for malformed JSON", !/malformed JSON/i.test(thrown?.message ?? ""), thrown?.message);
check("it says nothing was used", /nothing was used/i.test(thrown?.message ?? ""), thrown?.message);
check("no second attempt when nothing was truncated", bodies.length === 1, `made ${bodies.length}`);

reset();
answers = [truncatedAnswer, truncatedAnswer];
thrown = null;
try { await geminiJson("make a product", { json: true, maxOutputTokens: 500 }); } catch (error) { thrown = error; }
check("a doubly-truncated answer is named as cut off", thrown?.code === "ai_truncated", thrown?.code);
check("its message says the answer was cut off", /cut off/i.test(thrown?.message ?? ""), thrown?.message);
check("it no longer promises that retrying fixes it", !/retrying usually fixes/i.test(thrown?.message ?? ""), thrown?.message);

/* The schema is the grammar; without it the model is only asked nicely. */
reset();
answers = [JSON.stringify(COMMAND)];
const SCHEMA = { type: "OBJECT", properties: { action: { type: "STRING" } } };
await geminiJson("make a product", { json: true, responseSchema: SCHEMA });
check("a response schema reaches the provider", bodies[0]?.generationConfig?.responseSchema?.type === "OBJECT",
  JSON.stringify(bodies[0]?.generationConfig));

reset();
answers = [JSON.stringify(COMMAND)];
await geminiJson("make a product", { json: false });
check("no schema is sent when JSON was not requested", !("responseSchema" in (bodies[0]?.generationConfig ?? {})));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
