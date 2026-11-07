/* ==========================================================================
   Shinzora — the five builder stages
   --------------------------------------------------------------------------
   One definition, used by both builders. The website stages ask about a
   business and a site; the app stages ask about an app, its screens and the
   package it will become. Everything else — the numbering, the progress bar,
   the validation screen, the save confirmation — is shared.

   The progress number is never a timer and never a guess: it is the share of
   tasks in the running stage that have actually reported completion. A stage
   that has not started contributes nothing, so the bar cannot reach 100% while
   work is still happening, and it cannot sit still while work is happening
   either, because every task reports.

   Pure module: no DOM, no network, so the arithmetic is testable.
   ========================================================================== */

/** The seven tasks the code-generation stage reports, in order. */
export const GENERATION_TASKS = [
  { id: "read_brief", label: "Reading the brief" },
  { id: "plan_structure", label: "Planning the page structure" },
  { id: "generate_layouts", label: "Generating layouts" },
  { id: "write_code", label: "Writing HTML, CSS and JavaScript" },
  { id: "add_assets", label: "Adding images, icons and type" },
  { id: "check_responsive", label: "Checking desktop, tablet and phone layouts" },
  { id: "validate", label: "Validating links, assets and scripts" }
];

export const STAGE_ORDER = ["brief", "information", "generate", "review", "save"];

export function stagesFor(kind) {
  const isApp = kind === "app";

  const brief = {
    id: "brief",
    number: 1,
    title: "Brief",
    summary: isApp ? "What the app is for and who uses it" : "What the site is for and who it is for",
    fields: isApp
      ? [
          { id: "purpose", label: "What should the app do?", type: "textarea", required: true, minLength: 20, hint: "The main job a user finishes in the app. One paragraph is enough." },
          { id: "industry", label: "Industry or category", type: "text", required: true, placeholder: "Healthcare, food, retail, fitness" },
          { id: "audience", label: "Who will use it", type: "text", required: true, placeholder: "Patients booking appointments from a phone" },
          { id: "design", label: "How should it feel and behave", type: "textarea", required: false, hint: "Tone, density, the one interaction that must feel good." },
          { id: "references", label: "Apps or references to learn from", type: "textarea", required: false, hint: "Names or links. The research stage will look at what is public." }
        ]
      : [
          { id: "purpose", label: "What should the website do?", type: "textarea", required: true, minLength: 20, hint: "What a visitor should be able to do: enquire, buy, book, read." },
          { id: "industry", label: "Industry or category", type: "text", required: true, placeholder: "Photography studio, bakery, law firm" },
          { id: "audience", label: "Who is it for", type: "text", required: true, placeholder: "Brides in Delhi NCR planning a 2027 wedding" },
          { id: "design", label: "Desired design and function", type: "textarea", required: false, hint: "Editorial and calm, or bold and loud. Mention booking forms, galleries, pricing tables." },
          { id: "references", label: "Sites or references you like", type: "textarea", required: false, hint: "Names or links. The research stage will look at what is public." }
        ]
  };

  const information = {
    id: "information",
    number: 2,
    title: "Information",
    summary: isApp ? "Name, identity, screens and build target" : "Business details, brand, pages and assets",
    fields: isApp
      ? [
          { id: "name", label: "App name", type: "text", required: true },
          { id: "description", label: "What it does, in one sentence", type: "text", required: true },
          { id: "screens", label: "Screens", type: "chips", required: true },
          { id: "packageId", label: "Package id", type: "package", required: true, hint: "The permanent identifier the store and the device use. It cannot change after the first release." },
          { id: "platform", label: "Which package should this app be built as?", type: "platform", required: true },
          { id: "logo", label: "Icon", type: "asset", accept: "image/*" },
          { id: "contact", label: "Support contact", type: "text", required: true, placeholder: "official.shinzora@proton.me" }
        ]
      : [
          { id: "name", label: "Business name", type: "text", required: true },
          { id: "description", label: "What the business does", type: "textarea", required: true },
          { id: "pages", label: "Pages", type: "chips", required: true },
          { id: "contact", label: "Contact details to show", type: "text", required: true, placeholder: "Phone, email, address" },
          { id: "colours", label: "Brand colours", type: "colours" },
          { id: "logo", label: "Logo", type: "asset", accept: "image/*" },
          { id: "images", label: "Images", type: "asset", accept: "image/*", multiple: true },
          { id: "launch", label: "Anything needed before launch", type: "textarea" }
        ]
  };

  const generate = {
    id: "generate",
    number: 3,
    title: "Build",
    summary: isApp ? "Screens, navigation and interaction" : "Structure, code and content",
    tasks: GENERATION_TASKS
  };

  const review = {
    id: "review",
    number: 4,
    title: "Preview",
    summary: "Walk through every page and read the validation report"
  };

  const save = {
    id: "save",
    number: 5,
    title: "Save",
    summary: "Confirm before a new version replaces the preview"
  };

  return [brief, information, generate, review, save];
}

/* ---------------------------------------------------------------- progress */

const TASK_WEIGHT = {};

/**
 * The weight of one stage, in "tasks". The build stage is the long one, so it
 * carries the largest share of the bar; the review and save stages are quick
 * confirmations and carry the smallest.
 */
export function stageWeights(kind) {
  return { brief: 2, information: 3, generate: 8, review: 1, save: 1 };
}

/**
 * Progress for the whole five-stage run.
 *
 * @param {object} state
 *   { stage: 'brief'|'information'|'generate'|'review'|'save',
 *     completedTasks: string[],            task ids that reported completion
 *     completedStages: string[],           stages already finished
 *     running: boolean }
 * @returns {{ percent:number, stagePercent:number, stageId:string, done:boolean }}
 */
export function computeProgress(state = {}) {
  const weights = stageWeights();
  const total = STAGE_ORDER.reduce((sum, id) => sum + weights[id], 0);
  const completedStages = Array.isArray(state.completedStages) ? state.completedStages : [];
  const completedTasks = Array.isArray(state.completedTasks) ? state.completedTasks : [];
  const stageId = STAGE_ORDER.includes(state.stage) ? state.stage : "brief";

  let done = 0;
  for (const id of STAGE_ORDER) {
    if (completedStages.includes(id)) done += weights[id];
  }

  /* The running stage counts only the tasks that actually finished. */
  if (stageId === "generate" && !completedStages.includes("generate")) {
    const finished = GENERATION_TASKS.filter((task) => completedTasks.includes(task.id)).length;
    done += (weights.generate * finished) / GENERATION_TASKS.length;
  }

  const stagePercent =
    stageId === "generate"
      ? Math.round(
          (GENERATION_TASKS.filter((task) => completedTasks.includes(task.id)).length /
            GENERATION_TASKS.length) *
            100
        )
      : completedStages.includes(stageId)
        ? 100
        : 0;

  const percent = Math.max(0, Math.min(100, Math.round((done / total) * 100)));

  return {
    percent,
    stagePercent,
    stageId,
    done: completedStages.length === STAGE_ORDER.length
  };
}

/** The stage that follows `id`, or null at the end. */
export function nextStage(id) {
  const index = STAGE_ORDER.indexOf(id);
  if (index === -1) return null;
  return STAGE_ORDER[index + 1] ?? null;
}

/** The task that should be running next, given what has reported completion. */
export function nextTask(completedTasks = []) {
  return GENERATION_TASKS.find((task) => !completedTasks.includes(task.id)) || null;
}

/* ----------------------------------------------------------------- gating */

/**
 * Can the customer leave this stage? Every required field must be answered.
 * Returns the list of problems, so the UI can name them instead of saying
 * "something is missing".
 */
export function validateStage(stage, values = {}) {
  const problems = [];
  for (const field of stage.fields || []) {
    if (!field.required) continue;
    const value = values[field.id];
    if (field.type === "chips") {
      if (!Array.isArray(value) || value.length === 0) problems.push({ field: field.id, message: `Choose at least one for “${field.label}”.` });
      continue;
    }
    if (field.type === "platform") {
      if (!value) problems.push({ field: field.id, message: "Choose the platform this app is for." });
      continue;
    }
    const text = String(value ?? "").trim();
    if (!text) {
      problems.push({ field: field.id, message: `“${field.label}” is required.` });
      continue;
    }
    if (field.minLength && text.length < field.minLength) {
      problems.push({ field: field.id, message: `“${field.label}” needs at least ${field.minLength} characters — you have ${text.length}.` });
    }
  }
  return problems;
}

/** Which stages are complete for a given set of answers. */
export function completedStagesFor(kind, answers = {}) {
  const stages = stagesFor(kind);
  const done = [];
  for (const stage of stages) {
    if (!stage.fields) continue;
    if (validateStage(stage, answers[stage.id] || {}).length === 0) done.push(stage.id);
  }
  return done;
}

/* ---------------------------------------------------------------- research */

/**
 * Research is only usable when it can be traced.
 *
 * The research service returns whatever it found; if it found nothing citable,
 * the answer must not reach the generated site. This function is the single
 * place that decision is made, so "use the research when it has sources, and
 * never otherwise" cannot drift between the UI and anything else.
 */
export function researchUsable(result) {
  if (!result || typeof result !== "object") return null;
  const sources = Array.isArray(result.sources)
    ? result.sources.filter((source) => source && /^https?:\/\//i.test(String(source.url || "")))
    : [];
  if (!sources.length) return null;
  const summary = String(result.summary || "").trim();
  if (!summary) return null;
  return {
    summary,
    patterns: Array.isArray(result.patterns) ? result.patterns.filter(Boolean).map(String) : [],
    sources
  };
}

/* --------------------------------------------------------------- platforms */

/**
 * The app targets, with the pairing the operating systems actually require.
 * An AAB is an Android bundle; an IPA is iOS. Offering "AAB for iOS" or
 * "IPA for Android" would produce a file that cannot install anywhere.
 */
export const APP_TARGETS = [
  {
    platform: "android",
    target: "apk",
    label: "Android APK",
    note: "A single installable file. Best for sharing a build and sideloading it on a phone.",
    extension: ".apk"
  },
  {
    platform: "android",
    target: "aab",
    label: "Android AAB",
    note: "The Play Store bundle format. Google Play converts it per device. Not installable by hand.",
    extension: ".aab"
  },
  {
    platform: "ios",
    target: "ipa",
    label: "iOS IPA",
    note: "Needs an Apple Developer account, a distribution certificate and a provisioning profile before a build can be signed.",
    extension: ".ipa"
  }
];

/** Targets allowed for a plan's platform-slot allowance. */
export function targetsForSlots(slots) {
  const allowedPlatforms = Number(slots) >= 2 ? ["android", "ios"] : ["android"];
  return APP_TARGETS.filter((option) => allowedPlatforms.includes(option.platform));
}

/** Which platforms a target list covers, for the entitlement message. */
export function platformsIn(targets = []) {
  const set = new Set(targets.map((entry) => (typeof entry === "string" ? entry : entry.platform)));
  return [...set];
}

void TASK_WEIGHT;
