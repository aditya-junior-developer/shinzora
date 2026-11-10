// ============================================================================
// Shinzora · Edge Function `ai`
// ----------------------------------------------------------------------------
// Every Gemini call in the product passes through here.
//
//   POST /functions/v1/ai   { action, ... }
//
//   action: chat            { message, conversationId?, context? }
//   action: generate        { type, name, brief, pages[], style, projectId?, business? }
//   action: build_start     { type, name, brief, pages[], style, business? }
//                           → creates the project + job, answers immediately
//   action: build_step      { jobId }  → runs one unit of work, saves, returns
//   action: build_status    { jobId }  → honest progress for the builder UI
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
  buildPagePrompt,
  buildPlanPrompt,
  buildStylesPrompt,
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

    /* Reading a build is free, and stepping one must never spend a second
       credit: one build is one generation from the owner's allowance. */
    if (action === "build_status") return await handleBuildStatus(caller, body);
    if (action === "build_step") return await handleBuildStep(caller, req, body);

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
      case "build_start":
        return await handleBuildStart(caller, body, req, quota);
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
    .select("plan, ai_credits_used, ai_credits_limit, ai_period_start, current_period_end, bonus_credits")
    .eq("user_id", userId)
    .maybeSingle();

  /* The allowance is base-for-the-plan plus whatever referrals have earned; the
     `subscriptions_allowance` trigger (0032) keeps `ai_credits_limit` equal to
     exactly that, so the stored number is used as-is and the bonus is only
     reported for the label beside it. Re-deriving it here would be a second
     source of truth that could disagree with the RPC that actually charges. */
  const bonus = Number((data as { bonus_credits?: number } | null)?.bonus_credits ?? 0);

  if (!data) return { plan: "free", used: 0, limit: 30, remaining: 30, bonus: 0 };

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
    /* Credits per month that came from referrals rather than the plan. The UI
       shows it as a note, never as a separate allowance to spend. */
    bonus,
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

/* ============================================================================
   Chunked, resumable build
   ----------------------------------------------------------------------------
   Why this exists: one call that generated the whole site — plan, every page,
   the stylesheet and the script — produced a response bigger than the runtime
   can parse, and the invocation was killed with HTTP 546 ("Function failed due
   to not having enough compute resources"). The owner saw a red line instead of
   a website.

   The build is therefore split into small steps that are each saved before the
   next one starts:

     plan    → design system, page list, section outline          (one small call)
     styles  → styles.css + app.js                                (one small call)
     page N  → one HTML document                                  (one small call)
     finish  → mark the job done, notify the owner

   Each step is claimed with a compare-and-set on `updated_at`, so two tabs (or
   the background chain and a polling client) can never run the same step twice.
   The state lives in `ai_generation_jobs.meta`, so a step that fails — provider
   hiccup, rate limit, killed invocation — resumes exactly where it stopped
   instead of throwing the work away.
   ========================================================================== */

const BUILD_MAX_PAGES = 3;
const BUILD_MAX_ATTEMPTS = 3;
const BUILD_STEPS = ["plan", "styles", "pages", "finish"] as const;

type BuildJob = Record<string, any>;

function buildProgress(meta: BuildJob, plan: BuildJob | null, done = false): number {
  if (done) return 100;
  if (!plan) return Math.min(8, 2 + Number(meta.attempts || 0));
  const pages: any[] = plan.pages || [];
  const totalPages = Math.max(pages.length, 1);
  const pageIndex = Number(meta.page_index || 0);
  if (!meta.styles) return 20;
  if (pageIndex < pages.length) return 20 + Math.round((pageIndex / totalPages) * 65);
  return 92;
}

function buildStages(meta: BuildJob, plan: BuildJob | null, done = false) {
  const pages: any[] = plan?.pages || [];
  const pageIndex = Number(meta.page_index || 0);
  return [
    { id: "plan", label: "Reading the brief and planning the pages", done: Boolean(plan) },
    { id: "styles", label: "Designing the shared stylesheet", done: Boolean(meta.styles) },
    ...pages.map((page: any, index: number) => ({
      id: `page-${index + 1}`,
      label: `Writing ${page.name || page.file}`,
      done: done || index < pageIndex
    })),
    { id: "finish", label: "Checking the result and saving the version", done }
  ];
}

function buildPayload(job: BuildJob, extra: Record<string, unknown> = {}) {
  const meta = job.meta || {};
  return {
    jobId: job.id,
    projectId: job.project_id,
    status: job.status,
    stage: job.stage,
    progress: Number(job.progress || 0),
    stages: buildStages(meta, meta.plan || null, job.status === "succeeded"),
    pagesTotal: (meta.plan?.pages || []).length,
    pagesDone: Number(meta.page_index || 0),
    notes: meta.plan?.notes || null,
    error: job.error || null,
    updatedAt: job.updated_at,
    ...extra
  };
}

/** Queue the next step of a build so it continues without a browser open. */
function scheduleBuildStep(req: Request, jobId: string) {
  const url = `${Deno.env.get("SUPABASE_URL") ?? ""}/functions/v1/ai`;
  const authorization = req.headers.get("authorization") ?? "";
  const apikey = Deno.env.get("SUPABASE_ANON_KEY") ?? req.headers.get("apikey") ?? "";
  if (!url.startsWith("http") || !authorization) return;

  const run = fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", authorization, apikey },
    body: JSON.stringify({ action: "build_step", jobId })
  }).then((response) => response.text()).catch(() => undefined);

  /* On Supabase the request finishes as soon as the response is written, unless
     the work is handed to waitUntil. Without it the chain would be cut off at
     the first step. */
  const runtime = (globalThis as any).EdgeRuntime;
  if (runtime?.waitUntil) runtime.waitUntil(run);
  else void run;
}

/* --------------------------------------------------------------- build_start */

async function handleBuildStart(
  caller: Caller,
  body: Record<string, unknown>,
  req: Request,
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
  const pages = cleanList(body.pages, 8).slice(0, BUILD_MAX_PAGES);

  const chosen = clean(body.model, 80);
  if (chosen && !(await isUsable(chosen, "site"))) {
    return fail(400, "model_unavailable", "That model is not available on this deployment right now.", {
      hint: "Pick another model, or leave it on Automatic."
    });
  }

  const db = admin();

  /* One website, one app, one store per account.
     A second build would leave the owner with two half-finished sites and no
     clear answer to "which one is mine?" — so the server refuses it and sends
     the builder to the project that already exists, where the same work becomes
     an update. */
  const { data: existing } = await db
    .from("projects")
    .select("id, name, type, status, version_count, slug")
    .eq("owner_id", caller.user.id)
    .eq("type", type)
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();

  if (existing) {
    /* A build already running for this account: hand back its id instead of
       starting a second one. Two jobs writing to one project would each think
       they own the result. */
    const { data: live } = await db
      .from("ai_generation_jobs")
      .select("id, status, progress")
      .eq("project_id", existing.id)
      .in("status", ["queued", "running"])
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (live) {
      return fail(409, "build_in_progress", "A build for this project is already running.", {
        hint: "The builder is following it. It continues on the server even if the tab is closed.",
        job: { id: live.id, status: live.status, progress: live.progress },
        project: { id: existing.id, name: existing.name, status: existing.status, slug: existing.slug }
      });
    }

    /* Anything already produced — a saved version, or a build that finished but
       was never confirmed — is the owner's project. A second one would split
       their work in two, so the answer is "update that one". */
    const { data: finished } = await db
      .from("ai_generation_jobs")
      .select("id")
      .eq("project_id", existing.id)
      .eq("status", "succeeded")
      .limit(1)
      .maybeSingle();

    if (Number(existing.version_count || 0) > 0 || finished) {
      return fail(409, "project_exists", `You already have a ${type === "app" ? "app" : "website"} called “${existing.name}”.`, {
        hint: "Open it and update it: a new project would replace nothing and divide your work in two.",
        project: { id: existing.id, name: existing.name, status: existing.status, slug: existing.slug }
      });
    }
  }

  /* An interrupted earlier build leaves a project with no saved version. That
     project is reused rather than duplicated. */
  let project = existing;
  if (!project) {
    const slug = `${(name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "project").slice(0, 40)}-${Math.random().toString(36).slice(2, 6)}`;
    const { data: created, error } = await db
      .from("projects")
      .insert({
        owner_id: caller.user.id,
        business_id: null,
        name,
        description: brief.slice(0, 280),
        type,
        status: "building",
        slug,
        framework: "html",
        preview_data: { pages, chunked: true }
      })
      .select("id, name, type, status, version_count, slug")
      .single();
    if (error) throw new Error(`Could not create the project: ${error.message}`);
    project = created;
  } else {
    await db.from("projects").update({ name, status: "building", updated_at: new Date().toISOString() }).eq("id", project.id);
  }

  const { data: job, error: jobError } = await db
    .from("ai_generation_jobs")
    .insert({
      user_id: caller.user.id,
      project_id: project.id,
      kind: type,
      status: "running",
      stage: "plan",
      stages: [],
      progress: 2,
      prompt: brief,
      meta: {
        name,
        type,
        brief,
        style,
        pages,
        model: chosen || null,
        plan: null,
        styles: null,
        page_index: 0,
        attempts: 0,
        files: {},
        started_by: "builder"
      }
    })
    .select("*")
    .single();
  if (jobError) throw new Error(`Could not queue the build: ${jobError.message}`);

  /* The first step starts immediately in the background; the answer above did
     not wait for any model call, which is why the builder now responds at once. */
  scheduleBuildStep(req, job.id);

  return json(
    {
      ...buildPayload(job),
      project: { id: project.id, name: project.name, slug: project.slug },
      reused_project: Boolean(existing),
      usage: quota && quota.ok ? { used: quota.used, limit: quota.limit, plan: quota.plan } : null
    },
    202
  );
}

/* ---------------------------------------------------------------- build_step */

async function handleBuildStep(caller: Caller, req: Request, body: Record<string, unknown>) {
  const jobId = clean(body.jobId, 60);
  if (!jobId) return fail(400, "invalid_input", "jobId is required.");

  const db = admin();
  const { data: job, error } = await db
    .from("ai_generation_jobs")
    .select("*")
    .eq("id", jobId)
    .eq("user_id", caller.user.id)
    .maybeSingle();
  if (error || !job) return fail(404, "not_found", "That build does not exist.");
  if (job.status !== "running") return json(buildPayload(job, { files: job.meta?.files || null }));

  /* Claim the step: the update only succeeds while `updated_at` is still the
     value that was just read, so a second runner backs off instead of paying
     for the same model call twice. */
  const claim = new Date().toISOString();
  const { data: claimed } = await db
    .from("ai_generation_jobs")
    .update({ updated_at: claim })
    .eq("id", job.id)
    .eq("updated_at", job.updated_at)
    .select("id");
  if (!claimed?.length) {
    const { data: fresh } = await db.from("ai_generation_jobs").select("*").eq("id", job.id).maybeSingle();
    return json(buildPayload(fresh || job, { claimed: false }));
  }

  const meta: BuildJob = { ...(job.meta || {}) };
  const plan = meta.plan || null;

  try {
    let stage = "plan";
    let progress = 2;

    if (!plan) {
      /* --- plan -------------------------------------------------------- */
      const planned = await geminiJson<Record<string, any>>(
        buildPlanPrompt({ type: meta.type, name: meta.name, brief: meta.brief, pages: meta.pages || [], style: meta.style, business: await businessFor(caller.user.id, undefined) }),
        { maxOutputTokens: 2048, thinkingBudget: 0, timeoutMs: 40000, temperature: 0.7 }
      );
      const pages = Array.isArray(planned?.pages) ? planned.pages : [];
      if (!pages.length) throw new GeminiError("The plan came back empty.", "ai_bad_json", 502);
      meta.plan = {
        design_system: planned.design_system ?? {},
        pages: pages.slice(0, BUILD_MAX_PAGES).map((page: any, index: number) => ({
          name: clean(page?.name, 60) || `Page ${index + 1}`,
          file: clean(page?.file, 60) || (index === 0 ? "index.html" : `page-${index + 1}.html`),
          title: clean(page?.title, 90) || clean(page?.name, 60) || `Page ${index + 1}`,
          purpose: clean(page?.purpose, 220),
          sections: Array.isArray(page?.sections) ? page.sections.slice(0, 8) : []
        })),
        nav: Array.isArray(planned?.nav) ? planned.nav.slice(0, 8) : [],
        seo: planned?.seo ?? null,
        notes: clean(planned?.notes, 500)
      };
      stage = "styles";
      progress = 12;
    } else if (!meta.styles) {
      /* --- styles ------------------------------------------------------ */
      stage = "styles";
      const sheet = await geminiJson<Record<string, any>>(
        buildStylesPrompt({ type: meta.type, name: meta.name, brief: meta.brief, pages: meta.pages || [], style: meta.style, business: null }, meta.plan),
        { maxOutputTokens: 4096, thinkingBudget: 0, timeoutMs: 50000, temperature: 0.6 }
      );
      const css = typeof sheet?.css === "string" ? sheet.css : "";
      if (!css.trim()) throw new GeminiError("The stylesheet came back empty.", "ai_bad_json", 502);
      meta.styles = { css: css.slice(0, 60_000), js: typeof sheet?.js === "string" ? sheet.js.slice(0, 30_000) : "" };
      stage = "pages";
      progress = 22;
    } else if (Number(meta.page_index || 0) < (meta.plan.pages || []).length) {
      /* --- one page ---------------------------------------------------- */
      stage = "pages";
      const pages: any[] = meta.plan.pages || [];
      const index = Number(meta.page_index || 0);
      const page = pages[index];
      const built = await geminiJson<Record<string, any>>(
        buildPagePrompt(
          { type: meta.type, name: meta.name, brief: meta.brief, pages: meta.pages || [], style: meta.style, business: null },
          meta.plan,
          page,
          index,
          pages.length
        ),
        { maxOutputTokens: 6144, thinkingBudget: 0, timeoutMs: 55000, temperature: 0.7 }
      );
      const html = typeof built?.html === "string" ? built.html : "";
      if (!html.trim()) throw new GeminiError(`The page ${page.file} came back empty.`, "ai_bad_json", 502);
      meta.files = { ...(meta.files || {}), [page.file]: html };
      meta.page_index = index + 1;
      progress = buildProgress(meta, meta.plan);
    }

    /* --- finish --------------------------------------------------------- */
    const pages: any[] = meta.plan?.pages || [];
    const finished = Number(meta.page_index || 0) >= pages.length && Boolean(meta.styles);

    if (!finished) {
      const { data: updated } = await db
        .from("ai_generation_jobs")
        .update({ stage, progress, meta, updated_at: new Date().toISOString() })
        .eq("id", job.id)
        .select("*")
        .single();
      scheduleBuildStep(req, job.id);
      return json(buildPayload(updated || job, { running: true }));
    }

    const files: Record<string, string> = {
      ...(meta.files || {}),
      "styles.css": meta.styles.css,
      ...(meta.styles.js ? { "app.js": meta.styles.js } : {})
    };

    const { data: done } = await db
      .from("ai_generation_jobs")
      .update({
        status: "succeeded",
        stage: "finish",
        progress: 100,
        finished_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        meta: { ...meta, files }
      })
      .eq("id", job.id)
      .select("*")
      .single();

    await db
      .from("projects")
      .update({ status: "ready", updated_at: new Date().toISOString() })
      .eq("id", job.project_id);

    /* Tell the owner, in the app and in the browser, that the build they walked
       away from is finished. The row is written by the server so it is there
       even if the tab was closed. */
    await db.from("notifications").insert({
      user_id: caller.user.id,
      type: type_notification(meta.type),
      title: `Your ${meta.type === "app" ? "app" : "website"} is ready`,
      body: meta.name,
      link: `/app/?view=${meta.type === "app" ? "app-builder" : "website-builder"}&id=${job.project_id}`,
      meta: { job_id: job.id, kind: "build_finished" }
    });

    await logUsage(caller.user.id, "generate", String(meta.brief || "").slice(0, 2000), JSON.stringify(Object.keys(files)));

    return json(buildPayload(done || job, { files, projectId: job.project_id, done: true }));
  } catch (error) {
    const attempts = Number(meta.attempts || 0) + 1;
    const message = (error as Error)?.message || "The build step failed.";
    const exhausted = attempts >= BUILD_MAX_ATTEMPTS;

    const { data: failed } = await db
      .from("ai_generation_jobs")
      .update({
        status: exhausted ? "failed" : "running",
        error: message.slice(0, 400),
        progress: Number(job.progress || 0),
        meta: { ...meta, attempts },
        updated_at: new Date().toISOString(),
        finished_at: exhausted ? new Date().toISOString() : null
      })
      .eq("id", job.id)
      .select("*")
      .single();

    if (exhausted) {
      /* Nothing was produced, so nothing is charged. */
      await refundCredit(caller.user.id, "generate");
      await db.from("projects").update({ status: "draft" }).eq("id", job.project_id);
      await db.from("notifications").insert({
        user_id: caller.user.id,
        type: type_notification(meta.type),
        title: `The ${meta.type === "app" ? "app" : "website"} build could not finish`,
        body: "Nothing was saved and your AI credit was returned. Open the builder to try again.",
        link: `/app/?view=${meta.type === "app" ? "app-builder" : "website-builder"}&id=${job.project_id}`,
        meta: { job_id: job.id, kind: "build_failed" }
      });
      return fail(502, "build_failed", "The build could not finish.", {
        hint: "Your credit was returned. The parts that were already written are kept, so trying again resumes from there.",
        job: failed ? buildPayload(failed) : null
      });
    }

    /* Retryable: schedule the next server-side step from the persisted point.
       The browser may be closed; relying on its polling loop here would strand
       the job in `running` with no one left to nudge it. */
    scheduleBuildStep(req, job.id);
    return json(
      buildPayload(failed || job, {
        retrying: true,
        attempt: attempts,
        retry_after_seconds: 3
      }),
      200
    );
  }
}

function type_notification(type: string) {
  return type === "app" ? "app" : type === "store" ? "store" : "website";
}

/* -------------------------------------------------------------- build_status */

async function handleBuildStatus(caller: Caller, body: Record<string, unknown>) {
  const jobId = clean(body.jobId, 60);
  const requestedKind = clean(body.type, 20);
  if (requestedKind && !["website", "app", "store"].includes(requestedKind)) {
    return fail(400, "invalid_input", "type must be website, app or store.");
  }
  const db = admin();

  if (!jobId) {
    /* No id means "what is the newest build for this account?" — the builder
       asks this on load so a refresh, a different tab or a revisit picks up an
       unfinished build instead of starting a second one. */
    const { data: latest } = await db
      .from("ai_generation_jobs")
      .select("*")
      .eq("user_id", caller.user.id)
      .in("kind", requestedKind ? [requestedKind] : ["website", "app", "store"])
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (!latest) return json({ job: null });
    return json({ job: buildPayload(latest, { files: latest.meta?.files || null }) });
  }

  const { data: job } = await db
    .from("ai_generation_jobs")
    .select("*")
    .eq("id", jobId)
    .eq("user_id", caller.user.id)
    .maybeSingle();
  if (!job || (requestedKind && job.kind !== requestedKind)) return fail(404, "not_found", "That build does not exist.");
  return json({ job: buildPayload(job, { files: job.meta?.files || null }) });
}
