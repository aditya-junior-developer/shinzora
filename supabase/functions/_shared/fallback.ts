/* ==========================================================================
   Shinzora — Groq backup provider
   --------------------------------------------------------------------------
   Gemini stays the primary provider. Groq is used only when Gemini cannot
   answer: quota or rate limit, timeout, outage, a busy model, or a rejected or
   missing Gemini key. Safety blocks, empty answers and request-shape errors do
   not fall back, because a second model would not change those results.

   Secrets (backend only, never sent to the browser):
     GROQ_API_KEY            the Groq key. Set with the Supabase secret store.
     AI_FALLBACK_API_KEY     optional alternative key for another compatible gateway
     AI_FALLBACK_BASE_URL    optional, default https://api.groq.com/openai/v1
     AI_FALLBACK_MODEL       optional, default openai/gpt-oss-120b

   Models are tried in order: the configured model, then openai/gpt-oss-20b.
   Grounded search (geminiGrounded) never falls back: Groq has no equivalent of
   Google Search, and text without sources must not be presented as research.
   ========================================================================== */

export class FallbackError extends Error {
  status: number;
  code: string;
  constructor(message: string, code = "ai_fallback_failed", status = 502) {
    super(message);
    this.name = "FallbackError";
    this.status = status;
    this.code = code;
  }
}

const DEFAULT_BASE_URL = "https://api.groq.com/openai/v1";
const DEFAULT_MODEL = "openai/gpt-oss-120b";
const SECOND_MODEL = "openai/gpt-oss-20b";

/* Congestion, rate limits and server errors move on to the next model. A
   refused key stops at once: every model would refuse it the same way. */
const TRY_NEXT_MODEL = new Set([404, 408, 409, 425, 429, 500, 502, 503, 504]);

const readEnv = (key: string): string => {
  try {
    // Deno is present in Edge Functions; Node is used by the test harness.
    const deno = (globalThis as { Deno?: { env: { get(k: string): string | undefined } } }).Deno;
    if (deno?.env?.get) return (deno.env.get(key) ?? "").trim();
    const proc = (globalThis as { process?: { env: Record<string, string | undefined> } }).process;
    return (proc?.env?.[key] ?? "").trim();
  } catch {
    return "";
  }
};

export const fallbackBaseUrl = () => (readEnv("AI_FALLBACK_BASE_URL") || DEFAULT_BASE_URL).replace(/\/+$/, "");
export const fallbackModel = () => readEnv("AI_FALLBACK_MODEL") || DEFAULT_MODEL;

/** The key used for the backup: GROQ_API_KEY first, then the generic setting. */
const fallbackApiKey = () => readEnv("GROQ_API_KEY") || readEnv("AI_FALLBACK_API_KEY");

/** True when a backup key exists. The base URL and model have safe defaults. */
export function fallbackConfigured(): boolean {
  return Boolean(fallbackApiKey());
}

export type FallbackOptions = {
  system?: string;
  json?: boolean;
  temperature?: number;
  maxOutputTokens?: number;
  timeoutMs?: number;
};

export type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

/* One line per event, for the function logs. Never the key, never the prompt. */
export function logProviderEvent(event: string, fields: Record<string, unknown>) {
  const safe = Object.fromEntries(
    Object.entries(fields).map(([key, value]) => [
      key,
      typeof value === "string" ? value.slice(0, 240) : value
    ])
  );
  console.warn(JSON.stringify({ event, at: new Date().toISOString(), ...safe }));
}

/**
 * One completion from the backup, with the whole conversation. Throws
 * FallbackError when no model answers, so the caller can keep the original
 * provider's error, which is usually more accurate about the cause.
 */
export async function fallbackChat(messages: ChatMessage[], options: FallbackOptions = {}): Promise<string> {
  if (!fallbackConfigured()) {
    throw new FallbackError("No backup provider is configured.", "ai_fallback_unconfigured", 503);
  }

  const models = [...new Set([fallbackModel(), SECOND_MODEL])];
  const withSystem = options.system && !messages.some((m) => m.role === "system")
    ? [{ role: "system" as const, content: options.system }, ...messages]
    : messages;

  let lastError: FallbackError | null = null;

  for (const model of models) {
    const body: Record<string, unknown> = {
      model,
      messages: withSystem,
      temperature: options.temperature ?? 0.7,
      max_tokens: options.maxOutputTokens ?? 4096
    };
    if (options.json) body.response_format = { type: "json_object" };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 60000);
    let response: Response;
    try {
      response = await fetch(`${fallbackBaseUrl()}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${fallbackApiKey()}`
        },
        body: JSON.stringify(body),
        signal: controller.signal
      });
    } catch (error) {
      lastError = new FallbackError(
        `The backup provider could not be reached: ${(error as Error)?.message ?? error}`,
        "ai_fallback_unreachable",
        502
      );
      logProviderEvent("ai_provider_error", { provider: "groq", model, code: lastError.code, message: lastError.message });
      continue;
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      let detail = "";
      try {
        detail = String(await response.text());
      } catch {
        /* the status alone is still useful */
      }
      const code = response.status === 401 || response.status === 403 ? "ai_fallback_bad_key" : "ai_fallback_failed";
      lastError = new FallbackError(
        `The backup provider refused the request (${response.status}).`,
        code,
        response.status === 429 ? 429 : 502
      );
      logProviderEvent("ai_provider_error", {
        provider: "groq",
        model,
        status: response.status,
        code,
        message: String(detail ?? "").slice(0, 200)
      });
      if (code === "ai_fallback_bad_key" || !TRY_NEXT_MODEL.has(response.status)) throw lastError;
      continue;
    }

    const payload = (await response.json().catch(() => null)) as
      | { choices?: Array<{ message?: { content?: string } }> }
      | null;
    const text = payload?.choices?.[0]?.message?.content?.trim() ?? "";
    if (!text) {
      lastError = new FallbackError("The backup provider returned an empty response.", "ai_fallback_empty", 502);
      logProviderEvent("ai_provider_error", { provider: "groq", model, code: lastError.code });
      continue;
    }
    return text;
  }

  throw lastError ?? new FallbackError("The backup provider did not answer.", "ai_fallback_failed", 502);
}

/** Single-prompt form, kept for callers that do not have a conversation. */
export async function fallbackComplete(prompt: string, options: FallbackOptions = {}): Promise<string> {
  const messages: ChatMessage[] = [{ role: "user", content: prompt }];
  return fallbackChat(messages, options);
}
