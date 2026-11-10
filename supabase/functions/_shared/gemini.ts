// ============================================================================
// Shinzora Edge Functions — Google Gemini client
// ----------------------------------------------------------------------------
// Server-side only. GEMINI_API_KEY is read from Edge Function secrets and is
// never included in a response, a log line or a client bundle.
// ============================================================================

import { resolveChain, type Capability } from "./models.ts";
import { configuredGeminiKeys, primaryGeminiKey, type GeminiApiKey } from "./keyring.ts";

const API_ROOT = "https://generativelanguage.googleapis.com/v1beta/models";

/**
 * Model selection with a fallback chain.
 *
 * Google retires models (`gemini-2.5-flash` now answers 404) and rate-limits or
 * sheds load on popular ones (`gemini-3.8-flash` answers 503 during demand
 * spikes). A single hard-coded model therefore means "the AI is down" for a
 * reason the customer cannot influence. The primary is whatever the deployment
 * configured; the rest are tried in order on 404 / 429 / 503 only — never on a
 * bad key, a safety block or a malformed prompt, because retrying those would
 * just burn quota to fail again.
 */
export function primaryModel(): string {
  return (Deno.env.get("SHINZORA_AI_MODEL") ?? Deno.env.get("GEMINI_MODEL") ?? "gemini-3.8-flash").trim();
}

/**
 * The ordered list of models to try. Computed per call rather than at import so
 * a deployment can change the chain without redeploying code, and so tests can
 * assert the ordering rules.
 */
export function modelChain(): string[] {
  const fallbacks = (Deno.env.get("SHINZORA_AI_MODEL_FALLBACKS") ?? "")
    .split(",")
    .map((model) => model.trim())
    .filter(Boolean);

  return [primaryModel(), ...fallbacks].filter(
    (model, index, all) => Boolean(model) && all.indexOf(model) === index
  );
}

/**
 * The chain actually used for a call.
 *
 * `modelChain()` only knows what the deployment was told. Google retires models
 * without notice — `gemini-2.5-flash` answers 404 today and tells you to move to
 * `gemini-3.8-flash` — so a configured list that is months old is a silent
 * outage. This asks the provider which models the key can really call (cached
 * for ten minutes, in _shared/models.ts) and appends them, so a retired primary
 * still leaves working models behind it. If discovery is unavailable the
 * configured chain is used unchanged — never an invented model id.
 */
export async function resolvedModelChain(capability: Capability = "site"): Promise<string[]> {
  try {
    const live = await resolveChain(capability);
    return live.length ? live : modelChain();
  } catch {
    return modelChain();
  }
}

/** Kept for backwards compatibility: the model a deployment asks for first. */
export function defaultModel(): string {
  return primaryModel();
}

/** Statuses that mean "try another model", not "this request is wrong". */
const RETRYABLE = new Set([404, 408, 425, 429, 500, 502, 503, 504]);

export class GeminiError extends Error {
  code: string;
  status: number;
  /** Seconds the provider asked us to wait, when it said so. Never invented. */
  retryAfter: number | null;
  constructor(message: string, code = "ai_error", status = 502, retryAfter: number | null = null) {
    super(message);
    this.code = code;
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

/* --------------------------------------------------------------------------
   Provider error translation
   --------------------------------------------------------------------------
   Gemini answers a spent quota with a paragraph of developer prose that ends
   in "Please retry in 1h24m15.4s". Two rules follow from that:

     • a daily quota is not "a minute" — saying so would be a false statement to
       the customer, so the real wait is parsed out and shown
     • the retry window is attached to the error as data (retryAfter), so the UI
       can render it without re-parsing English
   -------------------------------------------------------------------------- */

/** Pull a wait out of "retry in 1h24m15.4s", `"retryDelay":"84s"`, or "20 seconds". */
export function extractRetrySeconds(detail: string): number | null {
  if (!detail) return null;

  const clock = detail.match(/retry in\s+(?:([0-9]+)h)?(?:([0-9]+)m)?(?:([0-9.]+)s)?/i);
  if (clock && (clock[1] || clock[2] || clock[3])) {
    const seconds = Number(clock[1] || 0) * 3600 + Number(clock[2] || 0) * 60 + Number(clock[3] || 0);
    if (seconds > 0) return Math.round(seconds);
  }

  const delayField = detail.match(/"retryDelay"\s*:\s*"?([0-9.]+)s/i);
  if (delayField) return Math.round(Number(delayField[1]));

  const secondsWord = detail.match(/([0-9]+)\s*(?:seconds|secs)\b/i);
  if (secondsWord) return Number(secondsWord[1]);

  return null;
}

/** Human wording for a wait, rounded to something a person can act on. */
export function describeWait(seconds: number): string {
  if (seconds < 90) return `${Math.max(1, Math.round(seconds))} seconds`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `about ${minutes} minutes`;
  const hours = Math.floor(seconds / 3600);
  const rest = Math.round((seconds % 3600) / 60);
  return rest ? `about ${hours}h ${rest}m` : `about ${hours} hours`;
}

/** True when the provider is telling us the project's allowance is spent, not that we were too fast. */
export function isQuotaExhausted(detail: string): boolean {
  return /quota|exceeded your current quota|limit:\s*0|billing/i.test(detail);
}

/** Map a non-2xx provider response to the error the customer should see. */
export function providerError(status: number, detail: string): GeminiError {
  const retryAfter = extractRetrySeconds(detail);

  /* A refused credential is never a shape problem, whatever status it arrives
     with, so this is decided before the generic 400 handling below. */
  if ((status === 400 || status === 401) && /api[ _]key|unauthorized|invalid key|API_KEY_INVALID|API key expired/i.test(detail)) {
    return new GeminiError("The AI provider rejected the configured key.", "ai_bad_key", 502);
  }

  /* A 400 is the request's shape, not the account's health: an unsupported
     parameter, a value out of range, or a model that rejects a field its
     siblings accept. Repeating the identical body is pointless; retrying a
     simpler body or a different model usually works. Marked retryable so the
     chain can do exactly that instead of failing the customer's build. */
  if (status === 400) {
    const error = new GeminiError(
      "The AI provider rejected this request. Retrying with a simpler request.",
      "ai_request_rejected",
      502
    );
    (error as GeminiError & { shape?: boolean }).shape = true;
    return error;
  }

  if (status === 429) {
    /* This limit belongs to the platform's own provider account. A customer
       reading "your allowance is used up" was reading about somebody else's
       key, so the message now says what happened, says the build did not start,
       and says nothing was charged. */
    if (isQuotaExhausted(detail)) {
      const window = retryAfter ? ` It resets in ${describeWait(retryAfter)}.` : "";
      const zeroLimit = /limit:\s*0\b/.test(detail);
      return new GeminiError(
        zeroLimit
          ? "This AI feature is not enabled for this project right now, so the build did not start. Nothing was taken from your allowance."
          : `The AI service has reached its current limit, so this build did not start.${window} Nothing was taken from your allowance.`,
        "ai_quota_exhausted",
        429,
        retryAfter
      );
    }
    return new GeminiError(
      "The AI service is busy right now, so this build did not start. Nothing was taken from your allowance — try again in a minute.",
      "ai_rate_limited",
      429,
      retryAfter
    );
  }

  if (status === 403 || /billing|permission|has not been used in project|is disabled/i.test(detail)) {
    return new GeminiError(
      "The AI provider refused the request for this project. Check that billing and the API are enabled for the configured key.",
      "ai_forbidden",
      502
    );
  }

  return new GeminiError(`AI provider error (${status}).`, "ai_provider_error", 502);
}

/**
 * The AI key is read from Edge Function secrets only.
 *
 * `SHINZORA_AI_API_KEY` is the documented, provider-neutral name: swap the
 * value (or the provider) in `supabase secrets set` and nothing in the client
 * changes. `GEMINI_API_KEY` is still honoured so an existing deployment that
 * already set it keeps working without a rename.
 */
export function geminiKey(): string {
  return primaryGeminiKey();
}

export function geminiConfigured(): boolean {
  return configuredGeminiKeys().length > 0;
}

/** Safe operator metadata; secret values are deliberately omitted. */
export function geminiKeyMetadata() {
  return configuredGeminiKeys().map(({ id, projectId, priority }) => ({ id, projectId, priority }));
}

/* Per-isolate circuit breakers reduce repeated calls to known-bad or exhausted
   keys. Quota is tracked by Google Cloud project when configured; an unknown
   project identity is handled conservatively and blocks all keys for a short
   backoff rather than pretending they represent independent quota pools. */
const keyCooldownUntil = new Map<string, number>();
const keyFailureCount = new Map<string, number>();
const projectCooldownUntil = new Map<string, number>();
let ambiguousQuotaUntil = 0;
let unknownProjectCooldownUntil = 0;
let rotationCursor = 0;
const MAX_KEYS_PER_REQUEST = 8;

function keyIsCooling(key: GeminiApiKey, now = Date.now()): boolean {
  return now < (keyCooldownUntil.get(key.id) || 0)
    || now < (projectCooldownUntil.get(key.projectId) || 0)
    || now < unknownProjectCooldownUntil && key.projectId.includes("unclassified")
    || now < ambiguousQuotaUntil;
}

function orderedAvailableKeys(): GeminiApiKey[] {
  const keys = configuredGeminiKeys();
  if (!keys.length) return [];
  const start = rotationCursor % keys.length;
  const rotated = [...keys.slice(start), ...keys.slice(0, start)];
  return rotated.filter((key) => !keyIsCooling(key)).slice(0, MAX_KEYS_PER_REQUEST);
}

function coolKey(key: GeminiApiKey, requestedSeconds: number | null = null, fixedMs?: number) {
  const failures = (keyFailureCount.get(key.id) || 0) + 1;
  keyFailureCount.set(key.id, failures);
  const delay = fixedMs ?? (requestedSeconds
    ? Math.min(24 * 60 * 60_000, Math.max(1_000, requestedSeconds * 1_000))
    : Math.min(60_000, 1_000 * 2 ** Math.min(failures - 1, 6)));
  keyCooldownUntil.set(key.id, Date.now() + delay);
}

function coolProject(projectId: string, requestedSeconds: number | null) {
  // This is a backoff, not a claim about when Google's quota resets.
  const delay = requestedSeconds
    ? Math.min(24 * 60 * 60_000, Math.max(1_000, requestedSeconds * 1_000))
    : 5 * 60_000;
  const until = Date.now() + delay;
  if (projectId.includes("unclassified")) ambiguousQuotaUntil = Math.max(ambiguousQuotaUntil, until);
  else {
    projectCooldownUntil.set(projectId, until);
    unknownProjectCooldownUntil = Math.max(unknownProjectCooldownUntil, until);
  }
}

/** Test-only circuit-breaker reset; it never reads or writes a secret. */
export function resetGeminiKeyHealth() {
  keyCooldownUntil.clear();
  keyFailureCount.clear();
  projectCooldownUntil.clear();
  ambiguousQuotaUntil = 0;
  unknownProjectCooldownUntil = 0;
  rotationCursor = 0;
}

/* ------------------------------------------------------------------------- *
 * Model health
 *
 * Google sheds load per model, not per key: while `gemini-3.8-flash` answers
 * 503 or hangs, a sibling model answers in under a second. A static fallback
 * list cannot know that, so health is measured at runtime and the chain is
 * re-ordered from it. A failing model is parked briefly and skipped instantly
 * on the next call; a success clears it.
 * ------------------------------------------------------------------------- */
const modelCooldownUntil = new Map<string, number>();
const modelSuccess = new Map<string, number>();
const MODEL_COOLDOWN_MS = 90_000;

function modelIsCooling(model: string, now = Date.now()): boolean {
  return now < (modelCooldownUntil.get(model) ?? 0);
}

function parkModel(model: string, ms = MODEL_COOLDOWN_MS) {
  if (modelCooldownUntil.size > 64) modelCooldownUntil.clear();
  modelCooldownUntil.set(model, Date.now() + ms);
}

function markModelOk(model: string) {
  modelCooldownUntil.delete(model);
  modelSuccess.set(model, (modelSuccess.get(model) ?? 0) + 1);
}

/** Secret-free health snapshot for the admin console and tests. */
export function geminiModelHealth() {
  const now = Date.now();
  return [...new Set([...modelCooldownUntil.keys(), ...modelSuccess.keys()])].map((model) => ({
    model,
    coolingForMs: Math.max(0, (modelCooldownUntil.get(model) ?? 0) - now),
    ok: modelSuccess.get(model) ?? 0
  }));
}

/** Test-only reset for model health. */
export function resetGeminiModelHealth() {
  modelCooldownUntil.clear();
  modelSuccess.clear();
}

/**
 * Order the chain from measured health: models that are serving first, models
 * in cooldown last (demoted, never dropped, so a stale cooldown cannot become
 * an outage). The operator's configured primary keeps its place while healthy.
 */
export function orderChainByHealth(chain: string[]): string[] {
  const fresh = chain.filter((model) => !modelIsCooling(model));
  const cooling = chain.filter((model) => modelIsCooling(model));
  const bySuccess = (a: string, b: string) => (modelSuccess.get(b) ?? 0) - (modelSuccess.get(a) ?? 0);
  return [...fresh.sort(bySuccess), ...cooling.sort(bySuccess)];
}

async function requestWithKeyFailover(model: string, body: Record<string, unknown>, timeoutMs: number): Promise<Response> {
  const keys = configuredGeminiKeys();
  if (!keys.length) throw new GeminiError("AI generation is not configured on this deployment.", "functions_unavailable", 503);
  const candidates = orderedAvailableKeys();
  if (!candidates.length) {
    const next = Math.min(...keys.map((key) => Math.max(
      keyCooldownUntil.get(key.id) || 0,
      projectCooldownUntil.get(key.projectId) || 0,
      key.projectId.includes("unclassified") ? unknownProjectCooldownUntil : 0,
      ambiguousQuotaUntil
    )).filter((at) => at > Date.now()));
    throw new GeminiError("Gemini keys are temporarily cooling down; retry after the current backoff.", "ai_key_cooldown", 503,
      Number.isFinite(next) ? Math.max(1, Math.ceil((next - Date.now()) / 1000)) : null);
  }

  let lastRetryable: GeminiError | null = null;
  let lastQuota: GeminiError | null = null;
  let lastPermanent: GeminiError | null = null;
  let retryResponse: { status: number; statusText: string; headers: Headers; text: string } | null = null;

  for (const key of candidates) {
    // A project quota can be exhausted while this invocation is iterating; do
    // not burn the next same-project key after that project is cooled.
    if (keyIsCooling(key)) continue;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response: Response;
    try {
      response = await fetch(`${API_ROOT}/${model}:generateContent`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": key.key },
        body: JSON.stringify(body),
        signal: controller.signal
      });
    } catch (error) {
      const aborted = (error as Error)?.name === "AbortError";
      lastRetryable = new GeminiError(
        aborted ? "The AI request timed out. Try again shortly." : "Could not reach the AI provider.",
        aborted ? "ai_timeout" : "ai_unreachable",
        aborted ? 504 : 502
      );
      coolKey(key);
      continue;
    } finally {
      clearTimeout(timer);
    }

    if (response.ok) {
      keyFailureCount.delete(key.id);
      keyCooldownUntil.delete(key.id);
      const index = keys.findIndex((entry) => entry.id === key.id);
      rotationCursor = index < 0 ? 0 : (index + 1) % keys.length;
      return response;
    }

    // Model retirement/capability errors are model-scoped, not key-scoped.
    if (response.status === 404) return response;
    const detail = await response.clone().text().catch(() => "");
    const mapped = providerError(response.status, detail);

    if (mapped.code === "ai_quota_exhausted") {
      lastQuota = mapped;
      coolProject(key.projectId, mapped.retryAfter);
      continue;
    }
    if (mapped.code === "ai_bad_key" || response.status === 401) {
      lastPermanent = mapped.code === "ai_bad_key"
        ? mapped
        : new GeminiError("The AI provider rejected a configured key.", "ai_bad_key", 502);
      coolKey(key, null, 60 * 60_000);
      continue;
    }
    if (response.status === 403) {
      lastPermanent = mapped;
      coolProject(key.projectId, null);
      continue;
    }
    if (RETRYABLE.has(response.status)) {
      lastRetryable = mapped;
      coolKey(key, mapped.retryAfter);
      const text = await response.text().catch(() => detail);
      retryResponse = { status: response.status, statusText: response.statusText, headers: response.headers, text };
      continue;
    }
    return response;
  }

  if (lastQuota && !lastRetryable && !lastPermanent) throw lastQuota;
  if (lastPermanent && !lastRetryable) throw lastPermanent;
  if (lastQuota) throw lastQuota;
  if (retryResponse) {
    return new Response(retryResponse.text, {
      status: retryResponse.status,
      statusText: retryResponse.statusText,
      headers: retryResponse.headers
    });
  }
  if (lastRetryable) throw lastRetryable;
  if (lastPermanent) throw lastPermanent;
  throw new GeminiError("No Gemini key is available for this request.", "functions_unavailable", 503);
}

type Part = { text: string };
type Content = { role: "user" | "model"; parts: Part[] };

export interface GeminiOptions {
  system?: string;
  history?: Content[];
  temperature?: number;
  maxOutputTokens?: number;
  json?: boolean;
  model?: string;
  /** What the call is for; picks the right fallback ordering. */
  capability?: Capability;
  timeoutMs?: number;
  /* 0 turns reasoning off for models that support it. A reasoning model that
     spends its whole output budget thinking returns MAX_TOKENS with no text, so
     the code then walks to the next model in the chain — and the cumulative wall
     clock is what the platform answers with 546. */
  thinkingBudget?: number;
}

/**
 * The recovery shape for a request the provider called invalid: no JSON mode,
 * no thinking directive, no temperature, and a modest output budget. Anything
 * the provider may object to is removed so one relaxed attempt can still
 * produce an answer.
 */
export function leanBody(body: Record<string, unknown>): Record<string, unknown> {
  const config = { ...(body.generationConfig as Record<string, unknown> | undefined) };
  const next: Record<string, unknown> = {
    maxOutputTokens: Math.min(Number(config.maxOutputTokens ?? 8192) || 8192, 8192)
  };
  return {
    ...body,
    generationConfig: next,
    safetySettings: undefined
  };
}

/** Low-level call. Throws GeminiError with a stable code for the UI. */
export async function gemini(parts: string | Part[], options: GeminiOptions = {}): Promise<string> {
  if (!geminiConfigured()) {
    throw new GeminiError("AI generation is not configured on this deployment.", "functions_unavailable", 503);
  }

  const contents: Content[] = [
    ...(options.history ?? []),
    { role: "user", parts: typeof parts === "string" ? [{ text: parts }] : parts }
  ];

  const body: Record<string, unknown> = {
    contents,
    generationConfig: {
      temperature: options.temperature ?? 0.7,
      maxOutputTokens: options.maxOutputTokens ?? 8192,
      ...(options.json ? { responseMimeType: "application/json" } : {}),
      ...(typeof options.thinkingBudget === "number"
        ? { thinkingConfig: { thinkingBudget: options.thinkingBudget } }
        : {})
    },
    safetySettings: [
      { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_ONLY_HIGH" },
      { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_ONLY_HIGH" },
      { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_ONLY_HIGH" },
      { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_ONLY_HIGH" }
    ]
  };

  if (options.system) {
    body.systemInstruction = { parts: [{ text: options.system }] };
  }

  /* An explicit model is honoured exactly: if the caller asked for it, guessing
     a different one would make the choice in the UI a lie. Otherwise the live
     chain is used. */
  /* An explicit model is tried first, then the live chain as a safety net: the
     caller's choice leads, but a congested model no longer fails the build. */
  const configured = options.model
    ? [options.model, ...(await resolvedModelChain(options.capability ?? "site")).filter((m) => m !== options.model)]
    : await resolvedModelChain(options.capability ?? "site");
  const chain = orderChainByHealth(configured);
  let lastRetryable: GeminiError | null = null;

  for (const model of chain) {
    /* Two shapes per model: the request as asked, then a relaxed one. A 400 is
       about the body, so relaxing it can turn a hard failure into an answer. */
    for (const lean of [false, true]) {
    const attemptBody = lean ? leanBody(body) : body;
    let response: Response;
    try {
      response = await requestWithKeyFailover(model, attemptBody, options.timeoutMs ?? 120000);
    } catch (error) {
      const mapped = error instanceof GeminiError ? error : new GeminiError("Could not reach the AI provider.", "ai_unreachable", 502);
      if (["ai_quota_exhausted", "ai_bad_key", "ai_forbidden", "functions_unavailable"].includes(mapped.code)) throw mapped;
      lastRetryable = mapped;
      if (mapped.code === "ai_timeout" || mapped.code === "ai_unreachable") parkModel(model, 30_000);
      break;
    }

    if (!response.ok) {
      const detail = await response.text().catch(() => "");

      if (response.status === 400) {
        /* Shape problem. Relax once for this model, then move on. */
        lastRetryable = providerError(400, detail);
        if (!lean) continue;
        parkModel(model);
        break;
      }

      if (RETRYABLE.has(response.status)) {
        const mapped = providerError(response.status, detail);
        /* A spent *daily/plan* allowance will not clear by trying the next model
           in the chain — every model answers 429 for the same project. Failing
           fast keeps the real reason instead of overwriting it with the last
           fallback's generic message. */
        if (mapped.code === "ai_quota_exhausted") throw mapped;
        lastRetryable = response.status === 503 ? new GeminiError("AI provider error (503).", "ai_provider_error", 502) : mapped;
        /* Congestion is per model, so remember it and switch immediately next
           time rather than paying the timeout again on every request. */
        if (response.status === 503 || response.status === 504) parkModel(model);
        break;
      }

      throw providerError(response.status, detail);
    }

    const payload = await response.json();
    const candidate = payload?.candidates?.[0];
    const text = candidate?.content?.parts?.map((part: Part) => part.text).join("") ?? "";

    if (!text) {
      const blocked = payload?.promptFeedback?.blockReason;
      if (!blocked && candidate?.finishReason === "MAX_TOKENS") {
        /* The model spent its whole output budget — usually on reasoning — and
           returned nothing. Say what happened, and let the next model try. */
        lastRetryable = new GeminiError(
          "The AI ran out of output space before it produced an answer. Ask for fewer pages or a shorter brief.",
          "ai_max_tokens",
          502
        );
        break;
      }
      throw new GeminiError(
        blocked
          ? "The request was blocked by the provider's safety filters. Rephrase the brief."
          : "The AI returned an empty response.",
        blocked ? "ai_blocked" : "ai_empty",
        422
      );
    }

    markModelOk(model);
    return text;
    }
  }

  throw (
    lastRetryable ??
    new GeminiError(
      "Every configured AI model is unavailable right now. Try again in a minute.",
      "ai_provider_error",
      502
    )
  );
}

/** Call Gemini and parse a JSON object, tolerating ```json fences. */
export async function geminiJson<T = unknown>(prompt: string, options: GeminiOptions = {}): Promise<T> {
  const raw = await gemini(prompt, { ...options, json: true });
  const cleaned = raw
    .replace(/^\uFEFF/, "")
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim();

  try {
    return JSON.parse(cleaned) as T;
  } catch {
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start > -1 && end > start) {
      try {
        return JSON.parse(cleaned.slice(start, end + 1)) as T;
      } catch {
        /* fall through */
      }
    }
    throw new GeminiError("The AI returned malformed JSON. Retrying usually fixes this.", "ai_bad_json", 502);
  }
}

/** Usage accounting helpers. */
export function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

/* ---------------------------------------------------------------- research */

export interface ResearchSource {
  title: string;
  url: string;
}

export interface GroundedAnswer {
  text: string;
  sources: ResearchSource[];
}

/**
 * Ask Gemini with Google Search grounding, so the answer can be tied to pages
 * that actually exist.
 *
 * This exists because a generated website that claims "the market grew 40%"
 * with nothing behind it is worse than one that says nothing. The sources come
 * from `groundingMetadata.groundingChunks`, which is the provider's own record
 * of what it read — they are never composed from the prompt. An answer with no
 * chunks returns `sources: []`, and the caller must then treat the research as
 * unusable.
 */
export async function geminiGrounded(
  prompt: string,
  options: GeminiOptions = {}
): Promise<GroundedAnswer> {
  if (!geminiConfigured()) {
    throw new GeminiError("AI generation is not configured on this deployment.", "functions_unavailable", 503);
  }

  const body: Record<string, unknown> = {
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    tools: [{ google_search: {} }],
    generationConfig: {
      temperature: options.temperature ?? 0.3,
      maxOutputTokens: options.maxOutputTokens ?? 4096
    },
    safetySettings: [
      { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_ONLY_HIGH" },
      { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_ONLY_HIGH" },
      { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_ONLY_HIGH" },
      { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_ONLY_HIGH" }
    ]
  };

  if (options.system) body.systemInstruction = { parts: [{ text: options.system }] };

  const configuredGrounding = options.model
    ? [options.model, ...(await resolvedModelChain(options.capability ?? "site")).filter((m) => m !== options.model)]
    : await resolvedModelChain(options.capability ?? "site");
  const chain = orderChainByHealth(configuredGrounding);
  let lastRetryable: GeminiError | null = null;

  for (const model of chain) {
    let response: Response;
    try {
      response = await requestWithKeyFailover(model, body, options.timeoutMs ?? 90000);
    } catch (error) {
      const mapped = error instanceof GeminiError ? error : new GeminiError("Could not reach the AI provider.", "ai_unreachable", 502);
      if (["ai_quota_exhausted", "ai_bad_key", "ai_forbidden", "functions_unavailable"].includes(mapped.code)) throw mapped;
      lastRetryable = mapped;
      if (mapped.code === "ai_timeout" || mapped.code === "ai_unreachable") parkModel(model, 30_000);
      continue;
    }

    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      const mapped = providerError(response.status, detail);
      if (RETRYABLE.has(response.status)) {
        if (mapped.code === "ai_quota_exhausted") throw mapped;
        lastRetryable = mapped;
        if (response.status === 503 || response.status === 504) parkModel(model);
        continue;
      }
      /* Search grounding is not offered on every model. That is a "this model
         cannot do it" answer, not a failure of the deployment, so the next model
         in the chain gets a turn. */
      if (response.status === 400 && /tool|grounding|search/i.test(detail)) {
        lastRetryable = new GeminiError(
          "Web research is not available on the configured model.",
          "ai_research_unsupported",
          422
        );
        parkModel(model);
        continue;
      }
      throw mapped;
    }

    const payload = await response.json();
    const candidate = payload?.candidates?.[0];
    const text = candidate?.content?.parts?.map((part: Part) => part.text).join("") ?? "";
    const chunks = candidate?.groundingMetadata?.groundingChunks ?? [];

    const sources: ResearchSource[] = [];
    for (const chunk of chunks) {
      const web = chunk?.web;
      const url = typeof web?.uri === "string" ? web.uri : "";
      if (!/^https?:\/\//i.test(url)) continue;
      const title = typeof web?.title === "string" && web.title.trim() ? web.title.trim() : url;
      if (!sources.some((source) => source.url === url)) sources.push({ title, url });
    }

    if (!text) {
      lastRetryable = new GeminiError("The research request returned nothing.", "ai_empty", 422);
      continue;
    }

    return { text, sources };
  }

  throw lastRetryable ?? new GeminiError("Web research is unavailable right now.", "ai_provider_error", 502);
}
