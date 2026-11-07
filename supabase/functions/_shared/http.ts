// ============================================================================
// Shinzora Edge Functions — shared HTTP helpers
// ============================================================================

export const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS"
};

export function json(body: unknown, status = 200, extraHeaders: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...CORS,
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...extraHeaders
    }
  });
}

/** Standard error shape the frontend's `normalizeError` understands. */
export function fail(status: number, code: string, error: string, extra: Record<string, unknown> = {}) {
  return json({ code, error, ...extra }, status);
}

export function preflight(req: Request) {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: CORS });
  }
  return null;
}

export async function readBody<T = Record<string, unknown>>(req: Request): Promise<T> {
  if (req.method === "GET") return {} as T;
  try {
    const raw = await req.text();
    return raw ? (JSON.parse(raw) as T) : ({} as T);
  } catch {
    return {} as T;
  }
}

/** Very small input guard: trims, caps length, rejects non-strings. */
export function clean(value: unknown, max = 4000): string {
  if (typeof value !== "string") return "";
  return value.trim().slice(0, max);
}

export function cleanList(value: unknown, max = 20): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item) => typeof item === "string").slice(0, max).map((item) => item.trim().slice(0, 120));
}

export function isEmail(value: string) {
  return /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(value);
}
