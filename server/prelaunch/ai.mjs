/* ==========================================================================
   Shinzora — pre-launch sandbox AI
   --------------------------------------------------------------------------
   The sandbox previously answered every builder action with
   `not_available_prelaunch`, so "Generate" could never work from a pre-launch
   session: the button ran for three minutes and produced nothing. Generation is
   now implemented here too, against the same Gemini contract as the Edge
   Function in supabase/functions/_shared/{prompts,gemini}.ts:

     • same house style and hard technical rules
     • same JSON output shape ({ files, entry, pages, seo, design_system, notes })
     • same file sanitisation (allowed extensions, no traversal, size caps)
     • same model fallback chain and the same provider error translation

   The prompt text is duplicated rather than imported because the Edge Function
   is TypeScript written for Deno and this process is Node: importing it would
   mean shipping a transpiler into the serverless bundle. Keep the two in step —
   scripts/check.mjs asserts the shared rules are present in both.

   The API key is read from the environment and never leaves this module.
   ========================================================================== */

const API_ROOT = "https://generativelanguage.googleapis.com/v1beta/models";

const MAX_FILES = 12;
const MAX_FILE_BYTES = 240_000;
/* Paths may be nested (models emit "pages/about.html"), but never absolute and
   never a traversal segment; depth is capped so an archive cannot nest forever. */
const ALLOWED = /^[\w.-]+(\/[\w.-]+){0,2}\.(html|css|js|json|svg|txt)$/i;

export const HOUSE_STYLE = `You are Shinzora, an AI business operating system for small businesses in India.
Tone: precise, calm, premium, practical. Never breathless, never salesy, never cute.
Rules you must never break:
- No emoji. No exclamation marks in body copy. No "unlock", "supercharge", "game-changer", "revolutionise".
- Never invent statistics, reviews, testimonials, client names, awards or press mentions.
- Never promise specific financial results. Be concrete about actions, not outcomes.
- Currency is INR (₹) unless the user asks otherwise. Use Indian digit grouping (₹1,20,000).
- Be honest about uncertainty and about what still requires a human.`;

export const HARD_RULES = `HARD TECHNICAL RULES
- Output plain HTML5, CSS3 and vanilla JavaScript as ES modules. No frameworks, no build step, no bundler.
- Zero external dependencies: no <script src="https://...">, no CDN links, no Google Fonts, no Tailwind. Fonts must use system stacks or an inline @font-face with no URL.
- Do not invent image URLs. Use CSS gradients, inline SVG and geometric composition for imagery.
- Shared assets live in "styles.css" and "app.js"; each page links them with relative paths.
- JavaScript must be defensive: no global namespace collisions, no console spam, no alert(). Handle empty states.
- Forms must not post anywhere. Show an inline confirmation message instead.
- Include accessible landmarks and aria labels on icon-only controls. Use inline SVG icons only — never emoji.
- SEO: one <h1> per page, descriptive <title>, meta description, Open Graph tags, semantic headings.
- No lorem ipsum. Write real copy in the brand voice, grounded in the brief.`;

const TYPE_CONTRACT = {
  website:
    "Build a marketing website: hero, value proposition, product or service detail, proof section WITHOUT invented testimonials, pricing or process where it fits, FAQ, contact section with a working-looking form, footer.",
  app:
    "Build a web application prototype: an entry screen, a working navigation shell, at least one interactive data view with local state (add/edit/delete), empty states, and a settings surface. It must actually respond to clicks — no dead buttons.",
  store:
    "Build an online store: storefront hero, category or filter bar, product grid with prices in INR, product detail view, cart with quantities and totals, and a checkout form summary. Cart state must work in JavaScript. Never invent stock levels or shipping promises."
};

const OUTPUT_FORMAT = `OUTPUT FORMAT — return ONE JSON object, no markdown fences, with exactly these keys:
{
  "files": { "index.html": "<full file>", "styles.css": "<full file>", "app.js": "<full file>", "<other-page>.html": "<full file>" },
  "entry": "index.html",
  "framework": "html",
  "pages": [{ "name": "Home", "path": "index.html", "title": "..." }],
  "seo": { "title": "...", "description": "...", "keywords": ["..."] },
  "design_system": { "colors": { "background": "...", "surface": "...", "primary": "...", "accent": "...", "text": "..." }, "fonts": { "display": "...", "body": "..." }, "radius": "...", "spacing": "..." },
  "notes": "two sentences describing what was built and what the owner should do next"
}`;

function businessContext(business) {
  if (!business || typeof business !== "object") return "- nothing supplied; keep product claims generic and verifiable";
  const lines = Object.entries(business)
    .filter(([, value]) => value !== null && value !== "" && !(Array.isArray(value) && value.length === 0))
    .map(([key, value]) => `- ${key}: ${typeof value === "object" ? JSON.stringify(value) : value}`);
  return lines.length ? lines.join("\n") : "- nothing supplied; keep product claims generic and verifiable";
}

export function generationPrompt({ type, name, brief, pages, style, business }) {
  const list = Array.isArray(pages) && pages.length ? pages.join(", ") : "Home";
  return `${HOUSE_STYLE}

TASK: generate a complete, self-contained ${type} named "${name}".

BRIEF
"""
${brief}
"""

STRUCTURE
${TYPE_CONTRACT[type] || TYPE_CONTRACT.website}
Pages requested: ${list}. Every requested page must exist as its own HTML file and be linked from the shared navigation.

VISUAL DIRECTION
${style || "Editorial dark, restrained, premium"}
Interpret this as a design decision: define actual colours, type scale, spacing and radii. Do not produce a generic template. Ensure text contrast meets WCAG AA and the layout is mobile-first responsive with working keyboard focus states.

BUSINESS CONTEXT
${businessContext(business)}

${HARD_RULES}

${OUTPUT_FORMAT}`;
}

export function revisionPrompt(instruction, files, pages) {
  const manifest = Array.isArray(pages) && pages.length ? pages.join(", ") : Object.keys(files).join(", ");
  const payload = Object.entries(files)
    .map(([name, content]) => `--- FILE: ${name} ---\n${content}`)
    .join("\n\n");

  return `${HOUSE_STYLE}

TASK: apply a change to an existing generated project and return the COMPLETE updated file set.

REQUESTED CHANGE
"""
${instruction}
"""

CURRENT PAGES: ${manifest}

CURRENT FILES
${payload}

RULES
- Return every file, not a diff. Unchanged files must still be included, unmodified.
- Keep the existing visual language unless the change asks otherwise.
- Do not add external dependencies or invent image URLs.

${HARD_RULES}

${OUTPUT_FORMAT}`;
}

/* ------------------------------------------------------------------ models */

/* Mirrors supabase/functions/_shared/keyring.ts: numbered secrets first, then
   the legacy single-key names. Values stay server-side and are never logged. */
export function keyring() {
  const values = [];
  const seen = new Set();
  const add = (value) => {
    const key = String(value || "").trim();
    if (key.length <= 10 || seen.has(key) || values.length >= 32) return;
    seen.add(key);
    values.push(key);
  };

  for (let index = 1; index <= 32; index += 1) {
    add(process.env[`SHINZORA_AI_API_KEY_${index}`] ?? process.env[`GEMINI_API_KEY_${index}`]);
  }
  add(process.env.SHINZORA_AI_API_KEY);
  add(process.env.GEMINI_API_KEY);
  add(process.env.GOOGLE_API_KEY);
  return values;
}

/* A key the provider has refused is parked for a while so the next request is
   not spent hitting the same wall. Bounded to avoid growth in a long process. */
const cooldowns = new Map();
const COOLDOWN_MS = 60_000;

export function resetKeyHealth() {
  cooldowns.clear();
}

function availableKeys() {
  const now = Date.now();
  return keyring().filter((key) => {
    const until = cooldowns.get(key);
    if (!until) return true;
    if (until <= now) {
      cooldowns.delete(key);
      return true;
    }
    return false;
  });
}

/* ---------------------------------------------------------- model health --
   Google sheds load per model, not per key: at any moment one model answers
   503 or hangs while a sibling answers in under a second. A static fallback
   list cannot know that, so health is learned at runtime. A model that fails
   is parked for a short while and skipped instantly on the next request; a
   success clears it. This is what makes the chain "auto-switch" instead of
   spending 35 seconds rediscovering the same outage on every call. */
const modelCooldowns = new Map();
const modelStats = new Map();
const MODEL_COOLDOWN_MS = 90_000;

export function resetModelHealth() {
  modelCooldowns.clear();
  modelStats.clear();
}

function modelIsCooling(model, now = Date.now()) {
  return now < (modelCooldowns.get(model) || 0);
}

function parkModel(model, ms = MODEL_COOLDOWN_MS) {
  if (modelCooldowns.size > 64) modelCooldowns.clear();
  modelCooldowns.set(model, Date.now() + ms);
  const stats = modelStats.get(model) || { ok: 0, fail: 0 };
  stats.fail += 1;
  modelStats.set(model, stats);
}

function markModelOk(model) {
  modelCooldowns.delete(model);
  const stats = modelStats.get(model) || { ok: 0, fail: 0 };
  stats.ok += 1;
  modelStats.set(model, stats);
}

/** Secret-free health snapshot for the admin console and tests. */
export function modelHealth() {
  const now = Date.now();
  return [...new Set([...modelCooldowns.keys(), ...modelStats.keys()])].map((model) => ({
    model,
    coolingForMs: Math.max(0, (modelCooldowns.get(model) || 0) - now),
    ...(modelStats.get(model) || { ok: 0, fail: 0 })
  }));
}

/**
 * Order the chain by measured health: models that are serving go first, models
 * in cooldown are demoted to the end rather than dropped, so a stale cooldown
 * can never turn into an outage. The configured primary still leads when it is
 * healthy, which keeps the operator's choice honest.
 */
export function orderedChain(preferred = []) {
  const base = preferred.length ? preferred : modelChain();
  const fresh = base.filter((model) => !modelIsCooling(model));
  const cooling = base.filter((model) => modelIsCooling(model));
  const byHealth = (a, b) => (modelStats.get(b)?.ok || 0) - (modelStats.get(a)?.ok || 0);
  return [...fresh.sort(byHealth), ...cooling.sort(byHealth)];
}

function park(key, ms = COOLDOWN_MS) {
  if (cooldowns.size > 64) cooldowns.clear();
  cooldowns.set(key, Date.now() + ms);
}

/** The first healthy key, for metadata calls that need only one credential. */
function apiKey() {
  const healthy = availableKeys();
  return healthy.length ? healthy[0] : keyring()[0] || "";
}

export function aiConfigured() {
  return keyring().length > 0;
}

function primaryModel() {
  return (process.env.SHINZORA_AI_MODEL || process.env.GEMINI_MODEL || "").trim();
}

/** Configured model first, then the deployment's fallbacks. */
export function modelChain() {
  const fallbacks = (process.env.SHINZORA_AI_MODEL_FALLBACKS || "")
    .split(",")
    .map((model) => model.trim())
    .filter(Boolean);
  return [primaryModel(), ...fallbacks].filter((model, index, all) => model && all.indexOf(model) === index);
}

/* Discovery mirrors _shared/models.ts: nothing is offered unless the provider
   lists it for this key. Cached briefly so a picker does not hammer the API. */
let discovery = { at: 0, ids: [] };
const DISCOVERY_TTL = 10 * 60 * 1000;

export async function discoveredModels({ force = false } = {}) {
  if (!aiConfigured()) return [];
  if (!force && Date.now() - discovery.at < DISCOVERY_TTL) return discovery.ids;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetch(`${API_ROOT}?key=${encodeURIComponent(apiKey())}&pageSize=200`, {
      signal: controller.signal
    });
    if (!response.ok) return discovery.ids;
    const payload = await response.json();
    const ids = (payload?.models || [])
      .filter((model) => (model.supportedGenerationMethods || []).includes("generateContent"))
      .map((model) => String(model.name || "").replace(/^models\//, ""))
      .filter(Boolean);
    discovery = { at: Date.now(), ids };
    return ids;
  } catch {
    return discovery.ids;
  } finally {
    clearTimeout(timer);
  }
}

const RULES = [
  { match: /image/i, capabilities: ["image"], note: "Images" },
  { match: /tts/i, capabilities: [], note: "Speech" },
  { match: /embedding|embed/i, capabilities: [], note: "Embeddings" },
  { match: /pro/i, capabilities: ["text", "site", "code", "debug", "reasoning", "project_modification", "pdf"], note: "Highest quality, slower" },
  { match: /flash-lite|lite/i, capabilities: ["text", "code", "debug"], note: "Fastest, simpler output" },
  { match: /flash/i, capabilities: ["text", "site", "code", "debug", "project_modification", "pdf"], note: "Fast, good for building" }
];

function classify(id) {
  for (const rule of RULES) if (rule.match.test(id)) return { capabilities: [...rule.capabilities], note: rule.note };
  return { capabilities: ["text"], note: "Text only" };
}

function label(id) {
  return id
    .replace(/^models\//, "")
    .split("-")
    .map((part) => (part ? part[0].toUpperCase() + part.slice(1) : part))
    .join(" ");
}

export async function availableModels(capability = "site") {
  const configured = primaryModel();
  const ids = await discoveredModels();
  return ids
    .map((id) => {
      const { capabilities, note } = classify(id);
      return { id, label: label(id), capabilities, note, recommended: id === configured };
    })
    .filter((model) => model.capabilities.includes(capability))
    .sort((a, b) => {
      if (a.recommended !== b.recommended) return a.recommended ? -1 : 1;
      return b.id.localeCompare(a.id, "en", { numeric: true });
    });
}

export async function isUsable(model, capability) {
  if (!model) return false;
  const list = await availableModels(capability);
  return list.some((entry) => entry.id === model);
}

/* -------------------------------------------------------------- generation */

export class SandboxAiError extends Error {
  constructor(message, { code = "ai_error", status = 502, hint = "", retryAfter = null } = {}) {
    super(message);
    this.code = code;
    this.status = status;
    this.hint = hint;
    this.retryAfter = retryAfter;
  }
}

const RETRYABLE = new Set([404, 429, 503]);

/* A 400 is the request's shape, not the account's health: an unsupported
   parameter, a value out of range, or a model that does not accept a field the
   others do. Retrying the identical body is pointless, but retrying a *simpler*
   body (or a different model) usually works, so this is treated as recoverable
   rather than fatal. The provider's own wording is kept for the log, never shown
   to the customer. */
export function isRequestShapeError(status, detail) {
  return status === 400 && /INVALID_ARGUMENT|invalid argument|unsupported|out of range|must be/i.test(String(detail));
}

function translate(status, detail) {
  /* A rejected credential is never a shape problem, whatever status it arrives
     with, so this is checked before the generic 400 handling below. */
  if (status === 401 || status === 403 || /API key not valid|API_KEY_INVALID|API key expired/i.test(detail)) {
    return new SandboxAiError("The AI provider rejected the configured key.", { code: "ai_bad_key", status: 503 });
  }
  if (isRequestShapeError(status, detail)) {
    const error = new SandboxAiError("The AI provider rejected the shape of this request.", {
      code: "ai_request_rejected",
      status: 502
    });
    error.retryable = true;
    error.shape = true;
    error.detail = String(detail).slice(0, 300);
    return error;
  }
  if (status === 400) {
    /* A 400 we do not recognise is still worth one simplified retry. */
    const error = new SandboxAiError("The AI provider rejected this request.", {
      code: "ai_request_rejected",
      status: 502
    });
    error.retryable = true;
    error.shape = true;
    error.detail = String(detail).slice(0, 300);
    return error;
  }
  if (status === 429) {
    const match = detail.match(/retry in\s+(?:(\d+)h)?(?:(\d+)m)?(?:([0-9.]+)s)?/i);
    const seconds = match ? Number(match[1] || 0) * 3600 + Number(match[2] || 0) * 60 + Number(match[3] || 0) : null;
    return new SandboxAiError("The AI provider's allowance for this key is spent.", {
      code: "ai_quota_exhausted",
      status: 429,
      hint: seconds
        ? `The provider asked to wait about ${Math.max(1, Math.round(seconds / 60))} minutes. Generating again will fail the same way until it clears.`
        : "Generating again will fail the same way until the allowance resets.",
      retryAfter: seconds
    });
  }
  if (status === 404) return new SandboxAiError("This AI model is not available to this key.", { code: "ai_model_gone", status: 502 });
  return new SandboxAiError("The AI provider failed to answer.", { code: "ai_provider_error", status: 502 });
}

function parseJson(text) {
  const trimmed = String(text || "").trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(trimmed.slice(start, end + 1));
      } catch {
        /* fall through */
      }
    }
    throw new SandboxAiError("The AI response was not valid JSON. Try again, or simplify the brief.", {
      code: "ai_bad_json",
      status: 502
    });
  }
}

async function callModel(model, prompt, { timeoutMs = 120000, key = apiKey(), lean = false } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${API_ROOT}/${model}:generateContent`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": key },
      signal: controller.signal,
      /* `lean` is the recovery shape: no JSON mode, a modest output budget and
         no temperature override. It is what a request-shape 400 falls back to
         for the same model before the chain moves on. */
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: lean
          ? { maxOutputTokens: 8192 }
          : {
              temperature: 0.85,
              maxOutputTokens: 30000,
              responseMimeType: "application/json"
            }
      })
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      const error = translate(response.status, detail);
      error.retryable = RETRYABLE.has(response.status);
      throw error;
    }

    const payload = await response.json();
    const candidate = payload?.candidates?.[0];
    const text = (candidate?.content?.parts || []).map((part) => part.text || "").join("");
    if (!text) {
      const blocked = payload?.promptFeedback?.blockReason;
      throw new SandboxAiError(
        blocked ? "The request was blocked by the provider's safety filters. Rephrase the brief." : "The AI returned an empty response.",
        { code: blocked ? "ai_blocked" : "ai_empty", status: 422 }
      );
    }
    return text;
  } catch (error) {
    if (error?.name === "AbortError") {
      const timeout = new SandboxAiError("The AI request timed out. Try a shorter brief or fewer pages.", {
        code: "ai_timeout",
        status: 504,
        retryable: true
      });
      throw timeout;
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Ask for JSON, automatically switching to whatever can actually answer.
 *
 * Order of preference at every step:
 *   1. the model that is configured (the operator's choice, when healthy)
 *   2. the other configured fallbacks
 *   3. whatever the provider says this key can really call
 *
 * For each model the keys are rotated first, because a spent key is an account
 * problem, then the request shape is relaxed if the provider rejects it, and
 * only then does the chain move on. Nothing in this loop can return a bare
 * provider status code to the customer.
 */
export async function completeJson(prompt, { model = "" } = {}) {
  const chain = orderedChain(model ? [model, ...modelChain().filter((m) => m !== model)] : []);
  if (!chain.length) {
    throw new SandboxAiError("No AI model is configured for this deployment.", {
      code: "ai_unconfigured",
      status: 503,
      hint: "Set SHINZORA_AI_MODEL (or GEMINI_MODEL) alongside the API key."
    });
  }

  let last = null;
  for (const candidate of chain) {
    const healthy = availableKeys();
    const attemptKeys = healthy.length ? healthy : keyring();
    let shapeFailedForThisModel = false;

    for (const key of attemptKeys) {
      /* Two attempts per credential: the normal request, then one simplified
         request if the provider rejected the shape. */
      for (const lean of [false, true]) {
        if (lean && !shapeFailedForThisModel) continue;
        try {
          const text = await callModel(candidate, prompt, { key, lean });
          markModelOk(candidate);
          return { text, model: candidate };
        } catch (error) {
          last = error;

          if (error?.shape) {
            /* Request shape: relax it, then move to the next model. The key is
               perfectly good, so it is never parked for this. */
            shapeFailedForThisModel = true;
            if (!lean) continue;
            parkModel(candidate);
            break;
          }

          /* Key-scoped problems park the credential, never the model. */
          if (error?.code === "ai_bad_key" || error?.code === "ai_quota_exhausted") {
            park(key, error?.retryAfter ? error.retryAfter * 1000 : COOLDOWN_MS);
            break;
          }

          /* Model-scoped or provider-scoped: park the model so the next request
             skips it instantly, and try the next one. */
          if (error?.retryable || error?.code === "ai_model_gone" || error?.code === "ai_timeout") {
            parkModel(candidate, error?.code === "ai_timeout" ? 30_000 : MODEL_COOLDOWN_MS);
            break;
          }

          throw error;
        }
      }
      if (modelIsCooling(candidate)) break;
    }
  }

  throw last || new SandboxAiError(
    "The AI model is busy right now. Try again in a minute.",
    { code: "ai_model_busy", status: 503 }
  );
}

/** Same contract as `sanitiseFiles` in the ai Edge Function. */
export function sanitiseFiles(input) {
  const out = {};
  if (!input || typeof input !== "object") return out;
  for (const [rawName, rawContent] of Object.entries(input).slice(0, MAX_FILES)) {
    const name = String(rawName).replace(/^\/+/, "").replace(/\.\./g, "").slice(0, 120);
    if (!ALLOWED.test(name)) continue;
    if (typeof rawContent !== "string") continue;
    if (rawContent.length > MAX_FILE_BYTES) continue;
    out[name] = rawContent;
  }
  return out;
}

function shape(parsed, model) {
  const files = sanitiseFiles(parsed?.files);
  if (!Object.keys(files).length) {
    throw new SandboxAiError("The AI response did not contain any files.", { code: "ai_bad_json", status: 502 });
  }
  return {
    files,
    entry: String(parsed?.entry || "index.html"),
    framework: "html",
    pages: Array.isArray(parsed?.pages) ? parsed.pages.slice(0, 12) : [],
    seo: parsed?.seo ?? null,
    design_system: parsed?.design_system ?? null,
    notes: typeof parsed?.notes === "string" ? parsed.notes.slice(0, 800) : "",
    model
  };
}

export async function generate({ type = "website", name, brief, pages, style, business, model = "" }) {
  const prompt = generationPrompt({ type, name, brief, pages, style, business });
  const result = await completeJson(prompt, { model });
  return shape(parseJson(result.text), result.model);
}

export async function revise({ instruction, files, pages, model = "" }) {
  const prompt = revisionPrompt(instruction, files || {}, pages);
  const result = await completeJson(prompt, { model });
  return shape(parseJson(result.text), result.model);
}
