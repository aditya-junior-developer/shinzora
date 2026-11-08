// ============================================================================
// Shinzora Edge Functions — AI capability registry
// ----------------------------------------------------------------------------
// The product must never offer a model it cannot actually use. That rule cannot
// live in the frontend: only the server holds the key, so only the server knows
// which models the key can reach.
//
// Everything here is therefore resolved live from the provider's model list and
// cached briefly. Nothing is hard-coded as "available":
//
//   • a model is offered only if the provider listed it for THIS key
//   • its capabilities come from an explicit registry, and a family that is not
//     in the registry is offered for plain text only — never for building sites
//     or writing code, because guessing would be a false claim
//   • if discovery fails, the picker shows nothing and the platform falls back
//     to the configured chain; it never invents a list
//
// Server-side only. The key is read from Edge Function secrets.
// ============================================================================

const API_ROOT = "https://generativelanguage.googleapis.com/v1beta/models";

/** What a model can be used for in this product. */
export type Capability =
  | "text"                 // assistant chat, copy, summaries
  | "site"                 // whole website / app generation
  | "code"                 // code generation and explanation
  | "debug"                // reading an error and proposing a fix
  | "reasoning"            // multi-step planning and analysis
  | "project_modification" // natural-language revisions of existing files
  | "image"                // image generation
  | "pdf";                 // PDF/document understanding

export const ALL_CAPABILITIES: Capability[] = [
  "text",
  "site",
  "code",
  "debug",
  "reasoning",
  "project_modification",
  "image",
  "pdf"
];

export interface ModelInfo {
  /** Provider model id, e.g. "gemini-3.8-flash". */
  id: string;
  /** Human label for the picker. */
  label: string;
  capabilities: Capability[];
  /** True when this is the deployment's configured first choice. */
  recommended: boolean;
  /** What the model optimises for — shown next to the label. */
  note: string;
}

/* --------------------------------------------------------------------------
   Registry
   --------------------------------------------------------------------------
   Matching is by family substring, most specific first. A model that matches
   nothing is deliberately *not* given site/code capability: an unknown model
   is offered for text only. Images and TTS are separate families and are never
   offered where text generation is expected.
   -------------------------------------------------------------------------- */

interface Rule {
  match: RegExp;
  capabilities: Capability[];
  note: string;
}

const RULES: Rule[] = [
  { match: /image/i, capabilities: ["image"], note: "Images" },
  { match: /tts/i, capabilities: [], note: "Speech" },
  { match: /embedding|embed/i, capabilities: [], note: "Embeddings" },
  {
    match: /pro/i,
    capabilities: ["text", "site", "code", "debug", "reasoning", "project_modification", "pdf"],
    note: "Highest quality, slower"
  },
  {
    match: /flash-lite|lite/i,
    capabilities: ["text", "code", "debug"],
    note: "Fastest, simpler output"
  },
  {
    match: /flash/i,
    capabilities: ["text", "site", "code", "debug", "project_modification", "pdf"],
    note: "Fast, good for building"
  }
];

function classify(id: string): { capabilities: Capability[]; note: string } {
  for (const rule of RULES) {
    if (rule.match.test(id)) return { capabilities: [...rule.capabilities], note: rule.note };
  }
  return { capabilities: ["text"], note: "Text only" };
}

/** "gemini-3.8-flash" → "Gemini 3.8 Flash". */
export function modelLabel(id: string): string {
  return id
    .replace(/^models\//, "")
    .split("-")
    .map((part) => (part ? part[0].toUpperCase() + part.slice(1) : part))
    .join(" ");
}

function key(): string {
  for (const name of [
    "SHINZORA_AI_API_KEY_1",
    "SHINZORA_AI_API_KEY_2",
    "SHINZORA_AI_API_KEY_3",
    "SHINZORA_AI_API_KEY_4",
    "SHINZORA_AI_API_KEY",
    "GEMINI_API_KEY",
    "GOOGLE_API_KEY"
  ]) {
    const value = (Deno.env.get(name) ?? "").trim();
    if (value) return value;
  }
  return "";
}

export function modelsConfigured(): boolean {
  return key().length > 10;
}

function primary(): string {
  return (Deno.env.get("SHINZORA_AI_MODEL") ?? Deno.env.get("GEMINI_MODEL") ?? "").trim();
}

/* --------------------------------------------------------------------------
   Live discovery
   -------------------------------------------------------------------------- */

interface RawModel {
  name?: string;
  displayName?: string;
  supportedGenerationMethods?: string[];
}

/** Cache, so a picker or a generation does not re-list models every call. */
let cache: { at: number; ids: string[] } | null = null;
const TTL_MS = 10 * 60 * 1000;

/** Ids the key can call `generateContent` on. Empty array when discovery fails. */
export async function discoveredModels({ force = false } = {}): Promise<string[]> {
  if (!modelsConfigured()) return [];
  if (!force && cache && Date.now() - cache.at < TTL_MS) return cache.ids;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetch(`${API_ROOT}?key=${encodeURIComponent(key())}&pageSize=200`, {
      signal: controller.signal
    });
    if (!response.ok) return cache?.ids ?? [];
    const payload = await response.json();
    const list: RawModel[] = payload?.models ?? [];
    const ids = list
      .filter((model) => (model.supportedGenerationMethods ?? []).includes("generateContent"))
      .map((model) => String(model.name ?? "").replace(/^models\//, ""))
      .filter(Boolean);
    cache = { at: Date.now(), ids };
    return ids;
  } catch {
    /* Offline, blocked or rate-limited: keep whatever was learned last time. */
    return cache?.ids ?? [];
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Every model that may honestly be offered to the customer, for `capability`.
 *
 * Returns [] when discovery failed — the caller must then show "Automatic"
 * only, because it cannot prove any model works.
 */
export async function availableModels(capability: Capability = "site"): Promise<ModelInfo[]> {
  const ids = await discoveredModels();
  const configured = primary();

  const offered = ids
    .map((id) => {
      const { capabilities, note } = classify(id);
      return { id, label: modelLabel(id), capabilities, note, recommended: id === configured };
    })
    .filter((model) => model.capabilities.includes(capability))
    /* Recommended first, then the newest generation available. */
    .sort((a, b) => {
      if (a.recommended !== b.recommended) return a.recommended ? -1 : 1;
      return b.id.localeCompare(a.id, "en", { numeric: true });
    });

  return offered;
}

/** True when a model id may be used for `capability` right now. */
export async function isUsable(model: string, capability: Capability): Promise<boolean> {
  if (!model) return false;
  const list = await availableModels(capability);
  return list.some((entry) => entry.id === model);
}

/**
 * The order models are tried in for one generation.
 *
 * The deployment's configured model comes first, then its configured fallbacks,
 * then models the provider confirmed are live for this key, preferring the same
 * family (a flash model falling back to another flash model keeps output shape
 * and latency predictable).
 */
export async function resolveChain(capability: Capability = "site"): Promise<string[]> {
  const configured = primary();
  const fallbacks = (Deno.env.get("SHINZORA_AI_MODEL_FALLBACKS") ?? "")
    .split(",")
    .map((model) => model.trim())
    .filter(Boolean);

  const live = await availableModels(capability);
  const liveIds = live.map((model) => model.id);

  return [configured, ...fallbacks, ...liveIds].filter(
    (model, index, all) => Boolean(model) && all.indexOf(model) === index
  );
}

/** Test seam: clear the discovery cache. */
export function __resetModelCache(): void {
  cache = null;
}
