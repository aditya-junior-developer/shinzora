// Server-only Gemini keyring parser. The secret values are never returned to a
// browser or written to logs. Configure SHINZORA_AI_KEYRING as JSON entries:
// [{"id":"prod-a","key":"...","projectId":"google-project-a","priority":10,"enabled":true}].
// Keys without a projectId are conservatively treated as one shared quota group.

export interface GeminiApiKey {
  id: string;
  key: string;
  projectId: string;
  priority: number;
}

const safeId = (value: unknown, fallback: string) => {
  const text = String(value ?? "").trim();
  return /^[a-zA-Z0-9_-]{1,48}$/.test(text) ? text : fallback;
};

const cleanKey = (value: unknown) => typeof value === "string" ? value.trim() : "";

function parseJsonRing(raw: string): GeminiApiKey[] {
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.slice(0, 32).flatMap((entry, index) => {
      if (!entry || typeof entry !== "object" || entry.enabled === false) return [];
      const key = cleanKey(entry.key ?? entry.apiKey);
      if (key.length < 10) return [];
      const project = String(entry.projectId ?? entry.project_id ?? "").trim();
      const priorityValue = Number(entry.priority);
      return [{
        id: safeId(entry.id ?? entry.name, `ring-${index + 1}`),
        key,
        projectId: project ? safeId(project, `project-${index + 1}`) : "unclassified-shared",
        priority: Number.isFinite(priorityValue) ? priorityValue : index
      }];
    });
  } catch {
    return [];
  }
}

/** All enabled keys, ordered by operator priority, with legacy secret support. */
export function configuredGeminiKeys(): GeminiApiKey[] {
  const entries: GeminiApiKey[] = [];
  const seen = new Set<string>();
  const add = (entry: GeminiApiKey) => {
    if (entry.key.length < 10 || seen.has(entry.key) || entries.length >= 32) return;
    seen.add(entry.key);
    entries.push(entry);
  };

  const configuredRing = parseJsonRing(Deno.env.get("SHINZORA_AI_KEYRING") ?? "");
  for (const entry of configuredRing) add(entry);

  // A delimited secret is a migration path for operators who haven't moved to
  // the structured keyring. Unknown project identity is not treated as extra
  // capacity: every such key shares the same conservative quota group.
  const sharedProject = (Deno.env.get("SHINZORA_AI_KEY_PROJECT_ID") ?? "").trim() || "legacy-unclassified";
  const list = Deno.env.get("SHINZORA_AI_API_KEYS") ?? "";
  let listValues: string[] = [];
  try {
    const json = JSON.parse(list);
    if (Array.isArray(json)) listValues = json.filter((v) => typeof v === "string");
  } catch {
    listValues = list.split(/[\n,;]+/);
  }
  listValues.slice(0, 32).forEach((key, index) => add({
    id: `env-list-${index + 1}`, key: cleanKey(key), projectId: sharedProject, priority: 100 + index
  }));

  for (let index = 1; index <= 16; index++) {
    for (const name of [`SHINZORA_AI_API_KEY_${index}`, `GEMINI_API_KEY_${index}`]) {
      const key = cleanKey(Deno.env.get(name));
      if (key) add({ id: `env-${index}`, key, projectId: sharedProject, priority: 200 + index });
    }
  }

  for (const [index, name] of ["SHINZORA_AI_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY"].entries()) {
    const key = cleanKey(Deno.env.get(name));
    if (key) add({ id: `legacy-${index + 1}`, key, projectId: sharedProject, priority: 300 + index });
  }

  return entries.sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));
}

export function primaryGeminiKey(): string {
  return configuredGeminiKeys()[0]?.key ?? "";
}
