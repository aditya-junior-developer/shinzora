// ============================================================================
// Shinzora Edge Functions — Google Gemini client
// ----------------------------------------------------------------------------
// Server-side only. GEMINI_API_KEY is read from Edge Function secrets and is
// never included in a response, a log line or a client bundle.
// ============================================================================

import { resolveChain, type Capability } from "./models.ts";

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
  return (Deno.env.get("SHINZORA_AI_MODEL") ?? Deno.env.get("GEMINI_MODEL") ?? "gemini-3-flash-preview").trim();
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
const RETRYABLE = new Set([404, 429, 503]);

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

  if (status === 429) {
    if (isQuotaExhausted(detail)) {
      const window = retryAfter ? ` It resets in ${describeWait(retryAfter)}.` : "";
      const zeroLimit = /limit:\s*0\b/.test(detail);
      return new GeminiError(
        zeroLimit
          ? "This AI feature is not included in the provider plan this project is on. The owner can enable it in the AI provider's billing settings."
          : `The AI provider's allowance for this project is used up.${window}`,
        "ai_quota_exhausted",
        429,
        retryAfter
      );
    }
    return new GeminiError(
      "The AI provider is rate limiting this project. Try again in a minute.",
      "ai_rate_limited",
      429,
      retryAfter
    );
  }

  if (status === 400 && /api key/i.test(detail)) {
    return new GeminiError("The AI provider rejected the configured key.", "ai_bad_key", 502);
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
const AI_KEY_NAMES = ["SHINZORA_AI_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY"] as const;

export function geminiKey(): string {
  for (const name of AI_KEY_NAMES) {
    const value = (Deno.env.get(name) ?? "").trim();
    if (value) return value;
  }
  return "";
}

export function geminiConfigured(): boolean {
  return geminiKey().length > 10;
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

/** Low-level call. Throws GeminiError with a stable code for the UI. */
export async function gemini(parts: string | Part[], options: GeminiOptions = {}): Promise<string> {
  const key = geminiKey();
  if (!geminiConfigured()) {
    throw new GeminiError(
      "AI generation is not configured on this deployment.",
      "functions_unavailable",
      503
    );
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
  const chain = options.model ? [options.model] : await resolvedModelChain(options.capability ?? "site");
  let lastRetryable: GeminiError | null = null;

  for (const model of chain) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 120000);

    let response: Response;
    try {
      response = await fetch(`${API_ROOT}/${model}:generateContent`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": key },
        body: JSON.stringify(body),
        signal: controller.signal
      });
    } catch (error) {
      clearTimeout(timer);
      const aborted = (error as Error)?.name === "AbortError";
      // A timeout on the primary model is worth one fallback attempt only if
      // another model is configured; otherwise report it.
      const fallbackError = new GeminiError(
        aborted ? "The AI request timed out. Try a shorter brief or fewer pages." : "Could not reach the AI provider.",
        aborted ? "ai_timeout" : "ai_unreachable",
        aborted ? 504 : 502
      );
      lastRetryable = fallbackError;
      continue;
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      const detail = await response.text().catch(() => "");

      if (RETRYABLE.has(response.status)) {
        const mapped = providerError(response.status, detail);
        /* A spent *daily/plan* allowance will not clear by trying the next model
           in the chain — every model answers 429 for the same project. Failing
           fast keeps the real reason instead of overwriting it with the last
           fallback's generic message. */
        if (mapped.code === "ai_quota_exhausted") throw mapped;
        lastRetryable = response.status === 503 ? new GeminiError("AI provider error (503).", "ai_provider_error", 502) : mapped;
        continue;
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
        continue;
      }
      throw new GeminiError(
        blocked
          ? "The request was blocked by the provider's safety filters. Rephrase the brief."
          : "The AI returned an empty response.",
        blocked ? "ai_blocked" : "ai_empty",
        422
      );
    }

    return text;
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
  const key = geminiKey();
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

  const chain = options.model ? [options.model] : await resolvedModelChain(options.capability ?? "site");
  let lastRetryable: GeminiError | null = null;

  for (const model of chain) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 90000);

    let response: Response;
    try {
      response = await fetch(`${API_ROOT}/${model}:generateContent`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": key },
        body: JSON.stringify(body),
        signal: controller.signal
      });
    } catch (error) {
      clearTimeout(timer);
      const aborted = (error as Error)?.name === "AbortError";
      lastRetryable = new GeminiError(
        aborted ? "The research request timed out." : "Could not reach the AI provider.",
        aborted ? "ai_timeout" : "ai_unreachable",
        aborted ? 504 : 502
      );
      continue;
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      const mapped = providerError(response.status, detail);
      if (RETRYABLE.has(response.status)) {
        if (mapped.code === "ai_quota_exhausted") throw mapped;
        lastRetryable = mapped;
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
