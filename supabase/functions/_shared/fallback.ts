/* ==========================================================================
   Shinzora — OpenAI-compatible fallback provider
   --------------------------------------------------------------------------
   Gemini stays the primary provider. This module exists for one reason: when
   Google refuses a request — a rejected key, an exhausted free quota, or a
   busy model — the customer gets an answer instead of an error page.

   It speaks the Chat Completions shape, which is what every free-tier gateway
   speaks (Groq, OpenRouter, Cerebras, NVIDIA NIM, Cloudflare's compat endpoint,
   and Gemini's own compat endpoint). Pointing it somewhere else is two secrets:

     AI_FALLBACK_BASE_URL   e.g. https://api.groq.com/openai/v1
     AI_FALLBACK_API_KEY    the gateway key
     AI_FALLBACK_MODEL      e.g. openai/gpt-oss-120b

   With none of them set, nothing changes: `fallbackConfigured()` is false and
   the caller behaves exactly as before.

   Deliberately NOT used for grounded search. Google's built-in google_search
   tool is the one capability with no equivalent here, so `geminiGrounded()`
   never falls back — it would silently return ungrounded text pretending to
   be sourced.
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

export const fallbackBaseUrl = () => readEnv("AI_FALLBACK_BASE_URL").replace(/\/+$/, "");
export const fallbackModel = () => readEnv("AI_FALLBACK_MODEL") || "openai/gpt-oss-120b";

/** True when a fallback is fully configured. A base URL alone is not enough. */
export function fallbackConfigured(): boolean {
  return Boolean(fallbackBaseUrl() && readEnv("AI_FALLBACK_API_KEY"));
}

export type FallbackOptions = {
  system?: string;
  json?: boolean;
  temperature?: number;
  maxOutputTokens?: number;
  timeoutMs?: number;
};

type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

/**
 * One completion through the fallback gateway. Throws FallbackError on any
 * refusal, so the caller can decide whether to surface it or keep the original
 * provider error (which is usually more accurate about what went wrong).
 */
export async function fallbackComplete(prompt: string, options: FallbackOptions = {}): Promise<string> {
  if (!fallbackConfigured()) {
    throw new FallbackError("No fallback provider is configured.", "ai_fallback_unconfigured", 503);
  }

  const messages: ChatMessage[] = [];
  if (options.system) messages.push({ role: "system", content: options.system });
  messages.push({ role: "user", content: prompt });

  const body: Record<string, unknown> = {
    model: fallbackModel(),
    messages,
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
        authorization: `Bearer ${readEnv("AI_FALLBACK_API_KEY")}`
      },
      body: JSON.stringify(body),
      signal: controller.signal
    });
  } catch (error) {
    throw new FallbackError(
      `The fallback provider could not be reached: ${(error as Error)?.message ?? error}`,
      "ai_fallback_unreachable",
      502
    );
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    let detail = "";
    try {
      detail = await response.text();
    } catch {
      /* body not readable — the status is still useful */
    }
    throw new FallbackError(
      `The fallback provider refused the request (${response.status}): ${detail.slice(0, 300)}`,
      response.status === 401 || response.status === 403 ? "ai_fallback_bad_key" : "ai_fallback_failed",
      response.status === 429 ? 429 : 502
    );
  }

  const payload = await response.json().catch(() => null) as
    | { choices?: Array<{ message?: { content?: string } }> }
    | null;
  const text = payload?.choices?.[0]?.message?.content?.trim() ?? "";
  if (!text) {
    throw new FallbackError("The fallback provider returned an empty response.", "ai_fallback_empty", 502);
  }
  return text;
}
