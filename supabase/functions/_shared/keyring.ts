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

  /* Quota grouping.
     Google meters generation per Google Cloud project, and a free-tier API key
     created from a different Google account belongs to a different project with
     its own allowance. Treating such keys as one pool would throw away working
     capacity the moment the first account hits its daily limit, so the default
     is now "each slot is its own project".

     Set SHINZORA_AI_SHARED_QUOTA=1 when every key really does come from one
     project: they then share a single conservative pool, so one spent allowance
     parks the whole ring instead of pointlessly retrying siblings that would
     answer 429 too. Per-slot identity can also be stated outright with
     SHINZORA_AI_KEY_PROJECT_<n>, or per entry in SHINZORA_AI_KEYRING. */
  const sharedQuota = /^(1|true|yes|on)$/i.test((Deno.env.get("SHINZORA_AI_SHARED_QUOTA") ?? "").trim());
  const legacyProject = (Deno.env.get("SHINZORA_AI_KEY_PROJECT_ID") ?? "").trim();
  const sharedProject = legacyProject || "legacy-unclassified";
  const slotProject = (index: number, fallback: string) => {
    if (sharedQuota) return sharedProject;
    const explicit = (Deno.env.get(`SHINZORA_AI_KEY_PROJECT_${index}`) ?? "").trim();
    if (explicit) return safeId(explicit, fallback);
    return fallback;
  };
  const list = Deno.env.get("SHINZORA_AI_API_KEYS") ?? "";
  let listValues: string[] = [];
  try {
    const json = JSON.parse(list);
    if (Array.isArray(json)) listValues = json.filter((v) => typeof v === "string");
  } catch {
    listValues = list.split(/[\n,;]+/);
  }
  listValues.slice(0, 32).forEach((key, index) => add({
    id: `env-list-${index + 1}`,
    key: cleanKey(key),
    projectId: slotProject(index + 1, `list-slot-${index + 1}`),
    priority: 100 + index
  }));

  for (let index = 1; index <= 16; index++) {
    for (const name of [`SHINZORA_AI_API_KEY_${index}`, `GEMINI_API_KEY_${index}`]) {
      const key = cleanKey(Deno.env.get(name));
      if (key) add({
        id: `env-${index}`,
        key,
        projectId: slotProject(index, `slot-${index}`),
        priority: 200 + index
      });
    }
  }

  for (const [index, name] of ["SHINZORA_AI_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY"].entries()) {
    const key = cleanKey(Deno.env.get(name));
    if (key) add({
      id: `legacy-${index + 1}`, key, projectId: slotProject(1, "legacy-slot-1"), priority: 300 + index
    });
  }

  return entries.sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));
}

export function primaryGeminiKey(): string {
  return configuredGeminiKeys()[0]?.key ?? "";
}
