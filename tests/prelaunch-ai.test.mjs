/* ==========================================================================
   Pre-launch AI tests
   --------------------------------------------------------------------------
   The sandbox used to refuse every builder action, so "Generate" could not work
   from a pre-launch session. These tests hold the replacement to the same bar as
   the Edge Function: real prompts, real JSON contract, real file sanitisation,
   honest errors, and a model list that never claims more than it verified.
   ========================================================================== */

let pass = 0;
let fail = 0;
const check = (name, cond, extra = "") =>
  cond ? (pass++, console.log(`  ✓ ${name}`)) : (fail++, console.log(`  ✗ ${name} ${extra}`));

/* --- provider stub ------------------------------------------------------- */
const calls = [];
let handler = () => new Response("{}", { status: 200 });

globalThis.fetch = async (url, init = {}) => {
  const href = String(url);
  calls.push({ url: href, init });
  return handler(href, init);
};

process.env.SHINZORA_AI_API_KEY = "test-key-000000000000";
process.env.SHINZORA_AI_MODEL = "gemini-3.8-flash";
delete process.env.SHINZORA_AI_MODEL_FALLBACKS;
delete process.env.GEMINI_API_KEY;
delete process.env.GOOGLE_API_KEY;

const ai = await import("../server/prelaunch/ai.mjs");

const jsonResponse = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const generation = (files, extra = {}) =>
  jsonResponse({
    candidates: [
      {
        content: {
          parts: [
            {
              text: JSON.stringify({
                files,
                entry: "index.html",
                pages: [{ name: "Home", path: "index.html", title: "Home" }],
                seo: { title: "T", description: "D", keywords: ["k"] },
                design_system: { colors: { primary: "#111" } },
                notes: "Built.",
                ...extra
              })
            }
          ]
        }
      }
    ]
  });

console.log("prompts");

const prompt = ai.generationPrompt({
  type: "website",
  name: "Aster Studio",
  brief: "A photography studio in Delhi selling portrait sessions.",
  pages: ["Home", "Contact"],
  style: "Editorial, dark",
  business: { name: "Aster", category: "photography" }
});

check("prompt carries the house voice", prompt.includes("You are Shinzora"));
check("prompt states the no-invention rule", /Never invent statistics, reviews, testimonials/.test(prompt));
check("prompt forbids emoji", /No emoji/.test(prompt));
check("prompt forbids CDN dependencies", /no CDN links/.test(prompt));
check("prompt asks for responsive, accessible output", /mobile-first responsive/.test(prompt));
check("prompt includes every requested page", prompt.includes("Home, Contact"));
check("prompt includes the brief verbatim", prompt.includes("A photography studio in Delhi"));
check("prompt includes business context", prompt.includes("photography"));
check("prompt specifies the JSON contract", /"files": \{ "index\.html"/.test(prompt));
check("prompt names INR for money", /INR/.test(prompt));

const bare = ai.generationPrompt({ type: "app", name: "X", brief: "b", pages: [], style: "", business: null });
check("empty business context is stated, not faked", bare.includes("nothing supplied"));
check("app_type gets the app contract", /web application prototype/.test(bare));
check("store_type gets the store contract", /prices in INR/.test(ai.generationPrompt({ type: "store", name: "S", brief: "b", pages: [], style: "", business: null })));

const revision = ai.revisionPrompt("Make the hero darker", { "index.html": "<h1>x</h1>" }, ["Home"]);
check("revision prompt includes the current files", revision.includes("--- FILE: index.html ---"));
check("revision prompt demands the complete file set", /Return every file, not a diff/.test(revision));

console.log("generation");

calls.length = 0;
handler = () => generation({ "index.html": "<h1>Hi</h1>", "styles.css": "body{}", "app.js": "export {}" });
const built = await ai.generate({ type: "website", name: "Aster", brief: "A studio site with three pages.", pages: ["Home"] });
check("generate returns the files", Object.keys(built.files).length === 3);
check("generate reports the model that answered", built.model === "gemini-3.8-flash", built.model);
check("generate keeps the entry file", built.entry === "index.html");
check("generate passes SEO and design system through", built.seo?.title === "T" && built.design_system?.colors?.primary === "#111");
check("generate asks for JSON output", /"responseMimeType":"application\/json"/.test(calls[0].init.body));
check("the key travels as a header, never in the URL", !calls[0].url.includes("test-key") && calls[0].init.headers["x-goog-api-key"] === "test-key-000000000000");

/* Fenced JSON, as models sometimes emit it anyway. */
handler = () =>
  jsonResponse({
    candidates: [{ content: { parts: [{ text: "```json\n" + JSON.stringify({ files: { "index.html": "<p>x</p>" } }) + "\n```" }] } }]
  });
const fenced = await ai.generate({ brief: "b", name: "n", pages: [] });
check("markdown-fenced JSON still parses", fenced.files["index.html"] === "<p>x</p>");

/* Prose before the JSON. */
handler = () =>
  jsonResponse({
    candidates: [{ content: { parts: [{ text: 'Here you go:\n{ "files": { "index.html": "<p>y</p>" } }' }] } }]
  });
const prose = await ai.generate({ brief: "b", name: "n", pages: [] });
check("prose before the JSON is tolerated", prose.files["index.html"] === "<p>y</p>");

console.log("sanitisation");

const cleaned = ai.sanitiseFiles({
  "index.html": "<p>ok</p>",
  "../../etc/passwd": "root",
  "payload.exe": "MZ",
  "styles.css": "body{}",
  "deep/nested/page.html": "<p>n</p>"
});
check("allowed files are kept", Boolean(cleaned["index.html"] && cleaned["styles.css"]));
check("traversal is stripped from the name", !("../../etc/passwd" in cleaned));
check("disallowed extensions are dropped", !("payload.exe" in cleaned));
check("nested html is supported", Boolean(cleaned["deep/nested/page.html"]));

let emptyRejected = false;
handler = () => generation({ "shell.sh": "rm -rf /" });
try {
  await ai.generate({ brief: "b", name: "n", pages: [] });
} catch (error) {
  emptyRejected = error.code === "ai_bad_json";
}
check("a response with no usable files fails loudly", emptyRejected);

console.log("errors");

ai.resetModelHealth(); // each scenario starts from a clean model-health slate

ai.resetModelHealth();
handler = () => new Response("quota", { status: 429 });
let quota = null;
try {
  await ai.generate({ brief: "b", name: "n", pages: [] });
} catch (error) {
  quota = error;
}
check("a spent allowance maps to ai_quota_exhausted", quota?.code === "ai_quota_exhausted", quota?.code);
check("quota errors are 429, not 500", quota?.status === 429);

ai.resetModelHealth();
handler = () => new Response('{"error":{"status":"API_KEY_INVALID"}}', { status: 400 });
let badKey = null;
try {
  await ai.generate({ brief: "b", name: "n", pages: [] });
} catch (error) {
  badKey = error;
}
check("an invalid key is reported as a configuration problem", badKey?.code === "ai_bad_key", badKey?.code);

/* A retired model must fall through to the next configured one. */
process.env.SHINZORA_AI_MODEL_FALLBACKS = "gemini-4-fallback";
ai.resetModelHealth();
calls.length = 0;
handler = (url) =>
  url.includes("gemini-3.8-flash") ? new Response("gone", { status: 404 }) : generation({ "index.html": "<p>ok</p>" });
const fellThrough = await ai.generate({ brief: "b", name: "n", pages: [] });
check("a retired model falls through to the fallback", fellThrough.model === "gemini-4-fallback", fellThrough.model);
check("both models were tried in order", calls.length === 2, String(calls.length));
delete process.env.SHINZORA_AI_MODEL_FALLBACKS;

handler = () => {
  throw Object.assign(new Error("aborted"), { name: "AbortError" });
};
let timedOut = null;
try {
  await ai.generate({ brief: "b", name: "n", pages: [] });
} catch (error) {
  timedOut = error;
}
check("a timeout is reported as a timeout", timedOut?.code === "ai_timeout", timedOut?.code);

console.log("models");

calls.length = 0;
handler = () =>
  jsonResponse({
    models: [
      { name: "models/gemini-3.8-flash", supportedGenerationMethods: ["generateContent"] },
      { name: "models/gemini-3.1-pro-preview", supportedGenerationMethods: ["generateContent"] },
      { name: "models/gemini-2.5-flash-image", supportedGenerationMethods: ["generateContent"] },
      { name: "models/text-embedding-004", supportedGenerationMethods: ["embedContent"] },
      { name: "models/gemini-tts", supportedGenerationMethods: ["generateContent"] }
    ]
  });
const siteModels = await ai.availableModels("site");
const ids = siteModels.map((model) => model.id);
check("only site-capable models are offered", ids.includes("gemini-3.8-flash") && ids.includes("gemini-3.1-pro-preview"), ids.join(","));
check("image models are not offered for site building", !ids.some((id) => id.includes("image")));
check("speech models are not offered for site building", !ids.some((id) => id.includes("tts")));
check("embedding models are excluded entirely", !ids.includes("text-embedding-004"));
check("the configured model is marked recommended", siteModels[0].id === "gemini-3.8-flash" && siteModels[0].recommended);

const imageModels = await ai.availableModels("image");
check("image capability lists only image models", imageModels.every((model) => model.id.includes("image")));

check("a verified model is usable", (await ai.isUsable("gemini-3.8-flash", "site")) === true);
check("an unknown model is not usable", (await ai.isUsable("made-up-model", "site")) === false);
check("an embedding model is not usable for text", (await ai.isUsable("text-embedding-004", "text")) === false);

/* Discovery failure must not invent a list. */
delete process.env.SHINZORA_AI_API_KEY;
const noKey = await ai.availableModels("site");
check("without a key the model list is empty rather than guessed", noKey.length === 0);
check("aiConfigured is honest about that", ai.aiConfigured() === false);
process.env.SHINZORA_AI_API_KEY = "test-key-000000000000";

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
