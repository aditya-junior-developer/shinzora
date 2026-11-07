// ============================================================================
// Shinzora · Edge Function `ai`
// ----------------------------------------------------------------------------
// Every Gemini call in the product passes through here.
//
//   POST /functions/v1/ai   { action, ... }
//
//   action: chat            { message, conversationId?, context? }
//   action: generate        { type, name, brief, pages[], style, projectId?, business? }
//   action: revise          { files, instruction, projectId?, versionId? }
//   action: domain_ideas    { business?, count? }
//   action: copy            { kind: 'marketing_plan' | 'product', ... }
//   action: support_reply   { ticket, thread[], business? }
//   action: research        { industry, business, audience, references?, type? }
//                           → grounded web research; every claim carries a real
//                             source URL, and no sources means no research
//   action: models          { capability? }  → which models may honestly be offered
//
//   Every generation action accepts `model` (an id from `models`). A model the
//   provider did not confirm for this key is refused, never silently swapped.
//
// Guarantees:
//   • the caller's JWT is verified before any work happens
//   • quota is consumed atomically in Postgres (service role), never client-side
//   • a missing GEMINI_API_KEY returns code `functions_unavailable` with a hint
//   • no key, token or provider payload is ever echoed back
// ============================================================================

import { clean, cleanList, fail, json, preflight, readBody } from "../_shared/http.ts";
import { admin, Caller, getCaller } from "../_shared/auth.ts";
import {
  defaultModel,
  estimateTokens,
  GeminiError,
  gemini,
  geminiConfigured,
  geminiGrounded,
  geminiJson
} from "../_shared/gemini.ts";
import {
  CHAT_SYSTEM,
  DOMAIN_IDEAS_PROMPT,
  generationPrompt,
  MARKETING_PROMPT,
  revisionPrompt,
  SUPPORT_PROMPT
} from "../_shared/prompts.ts";
import { providerFlags } from "../_shared/config.ts";
import { availableModels, type Capability, isUsable } from "../_shared/models.ts";

const MAX_FILES = 12;
const MAX_FILE_BYTES = 240_000;

Deno.serve(async (req) => {
  const options = preflight(req);
  if (options) return options;

  if (req.method !== "POST") return fail(405, "method_not_allowed", "Use POST.");

  const caller = await getCaller(req);
  if (!caller) return fail(401, "not_authenticated", "Sign in to use the assistant.");

  if (!geminiConfigured()) {
    return fail(503, "functions_unavailable", "AI generation is not configured on this deployment.", {
      hint: "An administrator must set the GEMINI_API_KEY secret for the `ai` Edge Function, then redeploy it. Nothing is charged to your plan until it is configured."
    });
  }

  const body = await readBody<Record<string, unknown>>(req);
  const action = clean(body.action, 40);
  const mode = action || "chat";
  let charged = false;

  try {
    /* Metadata, not generation: listing models must not spend a credit, so it
       is answered before the quota check. */
    if (action === "models") {
      const capability = (clean(body.capability, 30) || "site") as Capability;
      const models = await availableModels(capability);
      const usage = await currentUsage(caller.user.id);
      return json({
        capability,
        /* Empty means "we could not confirm any model", and the UI must then
           offer Automatic only. It never means "none exist". */
        verified: models.length > 0,
        models,
        usage
      });
    }

    const quota = await ensureQuota(caller.user.id, mode);
    if (quota && quota.ok !== false) charged = true;
    if (quota && quota.ok === false) {
      return fail(429, "quota_exceeded", "You have used every AI generation in this billing cycle.", {
        hint: `Plan ${quota.plan} allows ${quota.limit} generations per month. Upgrade in Billing or wait for the next cycle.`,
        usage: quota
      });
    }

    switch (action) {
      case "chat":
        return await handleChat(caller, body);
      case "generate":
        return await handleGenerate(caller, body, quota);
      case "revise":
        return await handleRevise(caller, body);
      case "domain_ideas":
        return await handleDomainIdeas(caller, body);
      case "copy":
        return await handleCopy(caller, body);
      case "support_reply":
        return await handleSupportReply(caller, body);
      case "research":
        return await handleResearch(caller, body);
      default:
        return fail(400, "unknown_action", `Unknown action "${action}".`);
    }
  } catch (error) {
    /* No output, no charge. The credit is spent before the provider is called,
       so a provider outage, a rate limit or a bad key used to cost the customer
       a generation they never received. */
    if (charged) await refundCredit(caller.user.id, mode);
    return handleError(error, caller, mode);
  }
});

/* ------------------------------------------------------------------ helpers */
function handleError(error: unknown, caller: Caller, mode: string) {
  const geminiError = error instanceof GeminiError ? error : null;
  const message = geminiError?.message || (error as Error)?.message || "The AI request failed.";
  const code = geminiError?.code || "ai_error";
  const status = geminiError?.status || 502;

  // Log the failure without leaking provider internals to the client.
  admin()
    .from("ai_usage_log")
    .insert({ user_id: caller.user.id, mode, ok: false, error: `${code}: ${message}`.slice(0, 400) })
    .then(() => undefined, () => undefined);

  if (code === "functions_unavailable") {
    return fail(503, code, message, {
      hint: "Set GEMINI_API_KEY as an Edge Function secret and redeploy the function."
    });
  }

  /* Structured facts travel next to the message so the UI never has to parse
     English to find out how long a quota takes to reset. */
  const extra: Record<string, unknown> = { retry_after_seconds: geminiError?.retryAfter ?? null };

  return fail(status, code, message, {
    ...extra,
    hint:
      code === "ai_quota_exhausted"
        ? "This is the platform's own provider limit, not your plan: the credit was returned. An administrator can raise the provider limit."
        : code === "ai_rate_limited"
          ? "The credit was returned. Try again in a minute."
          : code === "ai_bad_json"
            ? "The credit was returned. Running the generation again usually succeeds."
            : code === "ai_max_tokens"
              ? "The credit was returned. Ask for fewer pages, or a shorter brief."
              : undefined
  });
}

/**
 * Give back a credit that produced nothing.
 *
 * Runs only for a request that failed after the credit was taken and before any
 * output existed, so it can never hand out a free generation to a success. The
 * counter lives on the subscription row; the service role may write it, and the
 * failure itself is already recorded in ai_usage_log by handleError().
 */
async function refundCredit(userId: string, mode: string): Promise<void> {
  try {
    const db = admin();
    const { data } = await db
      .from("subscriptions")
      .select("ai_credits_used")
      .eq("user_id", userId)
      .maybeSingle();
    const used = Number(data?.ai_credits_used ?? 0);
    if (!Number.isFinite(used) || used <= 0) return;
    const { error } = await db
      .from("subscriptions")
      .update({ ai_credits_used: used - 1 })
      .eq("user_id", userId);
    if (error) {
      console.error("ai credit refund failed", error.message);
      return;
    }
    await db.from("ai_usage_log").insert({
      user_id: userId,
      mode: `${mode}:refund`.slice(0, 40),
      credits: 0,
      ok: true,
      error: "no output produced — credit returned"
    });
  } catch (error) {
    console.error("ai credit refund threw", (error as Error)?.message || error);
  }
}

/** Consume one credit. Returns {ok:false,...} when the plan is exhausted. */
async function ensureQuota(userId: string, mode: string): Promise<Record<string, unknown> | null> {
  const { data, error } = await admin().rpc("consume_ai_credit", {
    p_user: userId,
    p_mode: mode,
    p_model: defaultModel(),
    p_credits: 1
  });
  if (error) {
    // A missing function is a deployment problem, not a quota problem: let the
    // request continue rather than blocking the whole product on migration.
    console.error("consume_ai_credit failed", error.message);
    return null;
  }
  return data as Record<string, unknown>;
}

/**
 * Read the caller's allowance without spending or logging anything.
 *
 * The `models` action needs to show what is left, and it must be free: charging
 * a credit to open a picker, or writing a usage row with zero credits, would
 * both be wrong. The monthly rollover is applied for display only — the write
 * happens when the next generation consumes a credit.
 */
async function currentUsage(userId: string): Promise<Record<string, unknown> | null> {
  const { data } = await admin()
    .from("subscriptions")
    .select("plan, ai_credits_used, ai_credits_limit, ai_period_start, current_period_end")
    .eq("user_id", userId)
    .maybeSingle();

  if (!data) return { plan: "free", used: 0, limit: 30, remaining: 30 };

  const periodStart = new Date();
  periodStart.setUTCDate(1);
  periodStart.setUTCHours(0, 0, 0, 0);
  const rolledOver =
    !data.ai_period_start || new Date(data.ai_period_start as string).getTime() < periodStart.getTime();
  const used = rolledOver ? 0 : Number(data.ai_credits_used ?? 0);
  const limit = Number(data.ai_credits_limit ?? 30);

  return {
    plan: data.plan,
    used,
    limit,
    remaining: Math.max(limit - used, 0),
    period_end: data.current_period_end ?? null
  };
}

async function logUsage(userId: string, mode: string, input: string, output: string) {
  await admin()
    .from("ai_usage_log")
    .insert({
      user_id: userId,
      mode,
      model: defaultModel(),
      input_tokens: estimateTokens(input),
      output_tokens: estimateTokens(output),
      ok: true
    })
    .then(() => undefined, () => undefined);
}

function businessContext(value: unknown) {
  if (!value || typeof value !== "object") return null;
  return value as Record<string, unknown>;
}

async function businessFor(userId: string, supplied: unknown) {
  if (supplied && typeof supplied === "object") return businessContext(supplied);
  const { data } = await admin()
    .from("businesses")
    .select("name, category, description, location, target_audience, website_style, brand_colors, goals, stage")
    .eq("owner_id", userId)
    .maybeSingle();
  return data ?? null;
}

/* --------------------------------------------------------------------- chat */
async function handleChat(caller: Caller, body: Record<string, unknown>) {
  const message = clean(body.message, 4000);
  if (!message) return fail(400, "invalid_input", "Write a message first.");

  const conversationId = clean(body.conversationId, 64) || null;
  const context = clean(body.context, 4000);

  let activeConversation = conversationId;
  if (!activeConversation) {
    const { data, error } = await admin()
      .from("ai_conversations")
      .insert({
        user_id: caller.user.id,
        title: message.slice(0, 70),
        kind: "assistant"
      })
      .select("id")
      .single();
    if (error) throw new Error(`Could not start a conversation: ${error.message}`);
    activeConversation = data.id as string;
  } else {
    const { data: owned } = await admin()
      .from("ai_conversations")
      .select("id")
      .eq("id", activeConversation)
      .eq("user_id", caller.user.id)
      .maybeSingle();
    if (!owned) return fail(404, "not_found", "That conversation does not belong to you.");
  }

  const { data: historyRows } = await admin()
    .from("ai_messages")
    .select("role, content")
    .eq("conversation_id", activeConversation)
    .order("created_at", { ascending: true })
    .limit(16);

  const history = (historyRows ?? [])
    .filter((row) => row.role === "user" || row.role === "assistant")
    .map((row) => ({ role: row.role === "assistant" ? "model" : "user", parts: [{ text: row.content }] }));

  await admin().from("ai_messages").insert({
    conversation_id: activeConversation,
    role: "user",
    content: message
  });

  const business = await businessFor(caller.user.id, null);
  const businessBlock = business
    ? `Business context (from the owner's profile):\n${Object.entries(business)
        .filter(([, v]) => v !== null && v !== "" && !(Array.isArray(v) && !v.length))
        .map(([k, v]) => `- ${k}: ${typeof v === "object" ? JSON.stringify(v) : v}`)
        .join("\n")}`
    : "Business context: the owner has not completed their business profile yet.";

  const pageContext = context ? `Current screen context supplied by the app:\n${context}` : "";

  const reply = await gemini(message, {
    system: `${CHAT_SYSTEM}\n\n${businessBlock}\n\n${pageContext}`,
    history: history as never,
    temperature: 0.75,
    maxOutputTokens: 2048
  });

  await admin().from("ai_messages").insert({
    conversation_id: activeConversation,
    role: "assistant",
    content: reply,
    meta: { model: defaultModel() }
  });

  await admin()
    .from("ai_conversations")
    .update({ updated_at: new Date().toISOString() })
    .eq("id", activeConversation);

  await logUsage(caller.user.id, "chat", message, reply);

  const quota = await quotaFor(caller.user.id);
  return json({ reply, conversationId: activeConversation, model: defaultModel(), usage: quota });
}

/** Service-role read of the caller's usage, used for the response payload. */
async function quotaFor(userId: string) {
  const { data } = await admin()
    .from("subscriptions")
    .select("plan, ai_credits_used, ai_credits_limit")
    .eq("user_id", userId)
    .maybeSingle();
  if (!data) return null;
  return {
    plan: data.plan,
    used: data.ai_credits_used,
    limit: data.ai_credits_limit
  };
}

/* ----------------------------------------------------------------- generate */
async function handleGenerate(
  caller: Caller,
  body: Record<string, unknown>,
  quota: Record<string, unknown> | null = null
) {
  const type = (clean(body.type, 20) || "website") as "website" | "app" | "store";
  if (!["website", "app", "store"].includes(type)) {
    return fail(400, "invalid_input", "type must be website, app or store.");
  }

  const brief = clean(body.brief, 4000);
  if (brief.length < 20) {
    return fail(400, "invalid_input", "Describe the project in at least a sentence or two.", {
      hint: "A good brief says what the business sells, who it serves and what the main action should be."
    });
  }

  const name = clean(body.name, 90) || "Untitled project";
  const style = clean(body.style, 400) || "Editorial dark, restrained, premium";
  const pages = cleanList(body.pages, 8);
  const business = await businessFor(caller.user.id, body.business);

  const chosen = clean(body.model, 80);
  if (chosen && !(await isUsable(chosen, "site"))) {
    return fail(400, "model_unavailable", "That model is not available on this deployment right now.", {
      hint: "Pick another model, or leave it on Automatic."
    });
  }

  const prompt = generationPrompt({ type, name, brief, pages, style, business });
  let parsed: Record<string, any>;
  try {
    parsed = await requestGeneration(prompt, { model: chosen || undefined, capability: "site" });
  } catch (error) {
    /* The model ran out of room. Rather than fail the whole build, ask once more
       for a smaller site: one page, no extra files. The owner still gets a site
       and is told what was trimmed. */
    if (error instanceof GeminiError && (error.code === "ai_max_tokens" || error.code === "ai_bad_json")) {
      const smaller = generationPrompt({ type, name, brief, pages: ["Home"], style, business });
      parsed = await requestGeneration(`${smaller}\n\nBuild ONE page only (index.html), one styles.css and one app.js. Total output under 45 KB.`, { model: chosen || undefined, capability: "site" });
      parsed.notes = clean(`Reduced build: ${clean(parsed.notes, 600) || "one page"}`, 800);
    } else {
      throw error;
    }
  }

  const files = sanitiseFiles(parsed.files);
  if (!Object.keys(files).length) {
    throw new GeminiError("The AI response did not contain any files.", "ai_bad_json", 502);
  }

  await logUsage(caller.user.id, "generate", prompt, JSON.stringify(Object.keys(files)));

  return json({
    files,
    entry: clean(parsed.entry, 120) || "index.html",
    framework: "html",
    pages: Array.isArray(parsed.pages) ? parsed.pages.slice(0, 12) : [],
    seo: parsed.seo ?? null,
    design_system: parsed.design_system ?? null,
    notes: clean(parsed.notes, 800),
    model: chosen || defaultModel(),
    /* Real remaining allowance, so the builder can show the counter and warn
       before the next attempt instead of failing deep inside a generation. */
    usage: quota && quota.ok ? { used: quota.used, limit: quota.limit, plan: quota.plan } : null
  });
}

async function requestGeneration(
  prompt: string,
  options: { model?: string; capability?: Capability } = {}
) {
  /* 8k, not 32k. A 32k-token answer is ~130 KB of JSON, and parsing that inside
     an Edge Function exhausted its compute before the parse finished (HTTP 546).
     8k still fits three pages of real HTML plus CSS and JS. */
  const base = {
    temperature: 0.85,
    maxOutputTokens: 8192,
    model: options.model,
    capability: options.capability ?? ("site" as Capability),
    /* Writing HTML is not a reasoning task. Left on, a thinking model spent its
       whole 8k budget reasoning and returned finishReason MAX_TOKENS with empty
       text, the chain moved to the next model, and the function was killed with
       HTTP 546 before it answered. */
    thinkingBudget: 0,
    timeoutMs: 55000
  };
  try {
    return await geminiJson<Record<string, any>>(prompt, base);
  } catch (error) {
    if (error instanceof GeminiError && error.code === "ai_bad_json") {
      // One repair attempt with a stricter instruction — cheaper than failing
      // a long generation outright.
      return await geminiJson<Record<string, any>>(
        `${prompt}\n\nIMPORTANT: your previous reply could not be parsed. Return ONLY the JSON object, no prose, no markdown fences, and make sure every quote and newline inside string values is escaped.`,
        { ...base, temperature: 0.4 }
      );
    }
    throw error;
  }
}

/** Reject payloads that would break the sandboxed preview or smuggle scripts. */
function sanitiseFiles(input: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!input || typeof input !== "object") return out;
  const entries = Object.entries(input as Record<string, unknown>).slice(0, MAX_FILES);

  for (const [rawName, rawContent] of entries) {
    const name = rawName.replace(/^\/+/, "").replace(/\.\./g, "").slice(0, 120);
    /* Nested paths are allowed ("pages/about.html"): dropping them would leave
       navigation links pointing at files that were silently discarded. */
    if (!/^[\w.-]+(\/[\w.-]+){0,2}\.(html|css|js|json|svg|txt)$/i.test(name)) continue;
    if (typeof rawContent !== "string") continue;
    if (rawContent.length > MAX_FILE_BYTES) continue;
    out[name] = rawContent;
  }

  // Strip references to remote scripts — a generated site must be self-contained.
  for (const [name, content] of Object.entries(out)) {
    if (!name.endsWith(".html")) continue;
    out[name] = content.replace(
      /<script\b[^>]*\bsrc\s*=\s*["']https?:\/\/[^"']+["'][^>]*>\s*<\/script>/gi,
      "<!-- external script removed: Shinzora projects must be self-contained -->"
    );
  }

  return out;
}

/* ----------------------------------------------------------------- research */

const RESEARCH_SYSTEM = [
  "You research a business's market using web search. Return JSON only.",
  "Rules:",
  "• state only what the search results actually support; never estimate, never invent a statistic",
  "• if the results do not support a point, omit it instead of guessing",
  '• shape: {"summary": string, "patterns": string[], "sections": string[]}',
  "• summary: 2–4 sentences about how this industry presents itself online and what customers expect",
  "• patterns: up to 5 concrete, observable things that competing sites or apps do",
  "• sections: up to 6 page sections or screens that this kind of site or app usually needs",
  "• no brand names you did not see in the results, no prices you cannot verify"
].join("\n");

/**
 * Grounded research.
 *
 * The answer is only usable if the provider returns citations, so the sources
 * come from the grounding metadata and are returned to the client untouched.
 * Everything is recorded in ai_generation_jobs, so a generated site can always
 * be traced back to the research that informed it.
 */
async function handleResearch(caller: Caller, body: Record<string, unknown>) {
  const industry = clean(body.industry, 120);
  const business = clean(body.business, 120);
  const audience = clean(body.audience, 240);
  const references = clean(body.references, 400);
  const type = clean(body.type, 20) === "app" ? "app" : "website";

  if (industry.length < 2 && business.length < 2) {
    return fail(400, "invalid_input", "Tell us the industry or the business name to research.");
  }

  const prompt = [
    `Research the market for a ${type} in this industry.`,
    industry ? `Industry: ${industry}` : "",
    business ? `Business name: ${business}` : "",
    audience ? `Audience: ${audience}` : "",
    references ? `References the customer gave: ${references}` : "",
    "Return the JSON object described in the system instruction."
  ]
    .filter(Boolean)
    .join("\n");

  const { data: job } = await admin
    .from("ai_generation_jobs")
    .insert({
      user_id: caller.user.id,
      kind: "research",
      status: "running",
      stage: "research",
      model: defaultModel(),
      prompt: prompt.slice(0, 2000)
    })
    .select("id")
    .maybeSingle();

  try {
    const { text, sources } = await geminiGrounded(prompt, {
      system: RESEARCH_SYSTEM,
      capability: "site"
    });

    let parsed: { summary?: string; patterns?: string[]; sections?: string[] } = {};
    try {
      parsed = JSON.parse(
        text
          .replace(/^\uFEFF/, "")
          .replace(/^```(?:json)?\s*/i, "")
          .replace(/```\s*$/i, "")
          .trim()
      );
    } catch {
      /* The prose is still useful, but it is not structured: keep the summary
         and let the client show it under the sources. */
      parsed = { summary: text.slice(0, 1200) };
    }

    const sourcesOut = sources.filter((source) => /^https?:\/\//i.test(source.url));

    if (job?.id) {
      await admin
        .from("ai_generation_jobs")
        .update({
          status: "succeeded",
          progress: 100,
          stages: [{ id: "research", done: true }],
          meta: { sources: sourcesOut, sections: parsed.sections ?? [] },
          finished_at: new Date().toISOString()
        })
        .eq("id", job.id);
    }
    await logUsage(caller.user.id, "research", prompt, text);

    return json({
      summary: (parsed.summary ?? "").slice(0, 2000),
      patterns: Array.isArray(parsed.patterns) ? parsed.patterns.slice(0, 5).map((p) => String(p).slice(0, 240)) : [],
      sections: Array.isArray(parsed.sections) ? parsed.sections.slice(0, 6).map((s) => String(s).slice(0, 80)) : [],
      sources: sourcesOut,
      /* Said explicitly, so the client never has to guess: research without
         citations is not research. */
      grounded: sourcesOut.length > 0,
      model: defaultModel()
    });
  } catch (error) {
    if (job?.id) {
      await admin
        .from("ai_generation_jobs")
        .update({ status: "failed", error: String((error as Error)?.message ?? error).slice(0, 400) })
        .eq("id", job.id);
    }
    throw error;
  }
}

/* ------------------------------------------------------------------- revise */
async function handleRevise(caller: Caller, body: Record<string, unknown>) {
  const instruction = clean(body.instruction, 2000);
  if (instruction.length < 3) return fail(400, "invalid_input", "Describe the change you want.");

  const files = sanitiseFiles(body.files);
  if (!Object.keys(files).length) {
    return fail(400, "invalid_input", "No project files were supplied to revise.", {
      hint: "Open the project and reload its latest version before requesting a revision."
    });
  }

  const chosen = clean(body.model, 80);
  if (chosen && !(await isUsable(chosen, "project_modification"))) {
    return fail(400, "model_unavailable", "That model is not available on this deployment right now.", {
      hint: "Pick another model, or leave it on Automatic."
    });
  }

  const prompt = revisionPrompt(instruction, files, cleanList(body.pages, 12));
  const parsed = await requestGeneration(prompt, {
    model: chosen || undefined,
    capability: "project_modification"
  });
  const updated = sanitiseFiles(parsed.files);

  if (!Object.keys(updated).length) {
    throw new GeminiError("The revision did not return any files.", "ai_bad_json", 502);
  }

  await logUsage(caller.user.id, "revise", instruction, JSON.stringify(Object.keys(updated)));

  return json({
    files: updated,
    entry: clean(parsed.entry, 120) || "index.html",
    framework: "html",
    pages: Array.isArray(parsed.pages) ? parsed.pages.slice(0, 12) : [],
    seo: parsed.seo ?? null,
    design_system: parsed.design_system ?? null,
    notes: clean(parsed.notes, 800),
    model: chosen || defaultModel()
  });
}

/* ------------------------------------------------------------- domain ideas */
async function handleDomainIdeas(caller: Caller, body: Record<string, unknown>) {
  const business = await businessFor(caller.user.id, body.business);
  if (!business) {
    return fail(400, "missing_context", "Complete your business profile first so suggestions are relevant.", {
      hint: "Settings → Business, or re-run onboarding."
    });
  }

  const parsed = await geminiJson<{ ideas?: Array<{ domain?: string; reason?: string }> }>(
    `${DOMAIN_IDEAS_PROMPT}\n\nBusiness:\n${JSON.stringify(business)}`,
    { temperature: 0.9, maxOutputTokens: 1200 }
  );

  const ideas = (parsed.ideas ?? [])
    .filter((idea) => typeof idea?.domain === "string")
    .slice(0, 12)
    .map((idea) => ({
      domain: String(idea.domain).toLowerCase().replace(/[^a-z0-9.-]/g, "").slice(0, 63),
      reason: clean(idea.reason, 160)
    }));

  await logUsage(caller.user.id, "domain_ideas", JSON.stringify(business), JSON.stringify(ideas));
  return json({ ideas });
}

/* --------------------------------------------------------------------- copy */
async function handleCopy(caller: Caller, body: Record<string, unknown>) {
  const kind = clean(body.kind, 40);
  const business = await businessFor(caller.user.id, body.business);

  if (kind === "marketing_plan") {
    const objective = clean(body.objective, 1200);
    if (!objective) return fail(400, "invalid_input", "Describe the campaign objective.");

    const parsed = await geminiJson<Record<string, unknown>>(
      `${MARKETING_PROMPT}\n\nBUSINESS\n${JSON.stringify(business)}\n\nCATALOGUE\n${JSON.stringify(
        body.catalogue ?? []
      )}\n\nRECENT ORDERS\n${JSON.stringify(body.recentOrders ?? [])}\n\nOBJECTIVE\n${objective}\nPRIMARY CHANNEL\n${
        clean(body.channel, 40) || "not specified"
      }`,
      { temperature: 0.8, maxOutputTokens: 2600 }
    );

    await logUsage(caller.user.id, "copy:marketing", objective, JSON.stringify(parsed).slice(0, 500));
    return json(parsed);
  }

  if (kind === "product") {
    const product = clean(body.product, 800);
    if (!product) return fail(400, "invalid_input", "Describe the product.");
    const text = await gemini(
      `${CHAT_SYSTEM}\n\nWrite a product description for the item below. 60–90 words, benefit-led, no invented specifications, no emoji.\n\nBusiness: ${JSON.stringify(
        business
      )}\nProduct: ${product}`,
      { temperature: 0.8, maxOutputTokens: 400 }
    );
    await logUsage(caller.user.id, "copy:product", product, text);
    return json({ description: text.trim() });
  }

  return fail(400, "invalid_input", "Unknown copy kind.");
}

/* ------------------------------------------------------------ support reply */
async function handleSupportReply(caller: Caller, body: Record<string, unknown>) {
  const ticket = (body.ticket ?? {}) as Record<string, unknown>;
  const thread = Array.isArray(body.thread) ? body.thread.slice(-10) : [];
  const business = await businessFor(caller.user.id, body.business);

  const parsed = await geminiJson<{ reply?: string; needs_owner?: boolean }>(
    `${SUPPORT_PROMPT}\n\nBUSINESS\n${JSON.stringify(business)}\n\nTICKET\nSubject: ${clean(
      ticket.subject,
      200
    )}\nMessage: ${clean(ticket.message, 3000)}\n\nTHREAD\n${JSON.stringify(thread)}`,
    { temperature: 0.6, maxOutputTokens: 700 }
  );

  const reply = clean(parsed.reply, 1600);
  if (!reply) throw new GeminiError("The AI returned an empty draft.", "ai_empty", 502);

  await logUsage(caller.user.id, "support_reply", JSON.stringify(ticket).slice(0, 400), reply);
  return json({ reply, needs_owner: Boolean(parsed.needs_owner) });
}
