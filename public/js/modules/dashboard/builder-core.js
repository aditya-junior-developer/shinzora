/* ==========================================================================
   Shinzora — builder engine (shared by Website Builder and App Builder)
   --------------------------------------------------------------------------
   Five stages, in this order, for both builders:

     1 Brief         what it is for, who it is for, how it should feel
     2 Information   business/app details, pages, brand, assets, target
     3 Build         structure → code → assets → responsiveness → validation,
                     with a progress bar that counts completed tasks only
     4 Preview       interactive preview, every page, desktop/tablet/phone,
                     the validation report, and a change box for the AI
     5 Save          confirmation, a new version, and the full version history

   The output is exactly one `index.html`. Multiple pages live inside it behind
   hash routes (see lib/single-file.js), so a downloaded file works on its own.

   Generated documents are rendered inside <iframe sandbox="allow-scripts
   allow-forms"> without allow-same-origin, so generated JavaScript cannot read
   the session, cookies or localStorage of the authenticated app.
   ========================================================================== */

import { qs, qsa, esc, on, safeSet } from "../../lib/dom.js";
import { icon } from "../../lib/icons.js";
import { timeAgo, slugify } from "../../lib/format.js";
import { state, plan, canCreateProject } from "../../lib/store.js";
import { sb, normalizeError } from "../../lib/supabase.js";
import { api, runtimeConfig } from "../../lib/api.js";
import { toast, toastError } from "../../ui/toast.js";
import { confirmDialog, openModal } from "../../ui/modal.js";
import { pageHead, emptyState, setupNotice } from "./components.js";
import {
  stagesFor,
  computeProgress,
  validateStage,
  GENERATION_TASKS,
  researchUsable
} from "./builder/stages.js";
import { toSingleFile, singleFileDownload } from "../../lib/single-file.js";
import { validateSiteDocument, validationSummary } from "../../lib/site-validate.js";
import {
  packageOptions,
  resolveTarget,
  describeConversionJob,
  signingRequirements,
  validateMobileApp,
  packageReadiness,
  suggestPackageId
} from "../../lib/app-package.js";

const TYPES = {
  website: {
    title: "Website Builder",
    icon: "panels-top-left",
    desc: "Five stages: a brief, the business details, a real build, a preview you can walk through, and a saved version you confirmed.",
    pageOptions: ["Home", "About", "Services", "Pricing", "Gallery", "Contact", "Booking", "FAQ", "Journal", "Testimonials"],
    defaults: ["Home", "About", "Contact"],
    stageLabel: "Website preview"
  },
  app: {
    title: "App Builder",
    icon: "blocks",
    desc: "A mobile app, built in five stages. The output is a phone app — never a desktop website with a small window.",
    pageOptions: ["Home", "List", "Detail", "Create", "Search", "Profile", "Settings", "Checkout", "Confirmation"],
    defaults: ["Home", "List", "Create"],
    stageLabel: "App preview"
  }
};

const ASSET_LIMIT_BYTES = 900 * 1024;

export function createBuilder(type) {
  const config = TYPES[type];
  const stages = stagesFor(type);
  const isApp = type === "app";

  return async function render(root, ctx) {
    const runtime = await runtimeConfig();
    const aiReady = Boolean(runtime?.ai?.configured);
    const projectId = ctx.params.get("id");
    const viewSlug = type === "app" ? "app-builder" : "website-builder";

    /* --------------------------------------------------------------- state */
    const S = {
      stage: "brief",
      answers: { brief: {}, information: {} },
      completedStages: [],
      completedTasks: [],
      project: null,
      versions: [],
      activeVersion: null,
      generated: null,
      validation: null,
      research: null,
      platformSlots: 1,
      target: null,
      busy: false,
      lastError: null
    };

    root.innerHTML = `
      ${pageHead({
        title: config.title,
        desc: config.desc,
        actions: `<a class="btn btn-ghost btn-sm" href="/app/?view=projects">${icon("folder-git-2", { size: 14 })}All projects</a>
                  <a class="btn btn-secondary btn-sm" href="/app/?view=${isApp ? "website-builder" : "app-builder"}">
                    ${icon(isApp ? "panels-top-left" : "blocks", { size: 14 })}
                    ${isApp ? "Website builder" : "App builder"}
                  </a>`
      })}
      ${!aiReady ? setupNotice({ code: "functions_unavailable", message: "AI generation is not configured on this deployment.", hint: "Deploy the `ai` Edge Function and set GEMINI_API_KEY as a secret. Saved projects, their versions, downloads and previews all work without it." }, "The builder") : ""}
      <div class="builder">
        <div class="builder-panel">
          <div class="card">
            <div class="card-head">
              <div class="card-title" id="stage-title">${esc(stages[0].title)}</div>
              <span class="badge badge-violet">${icon("sparkles", { size: 11 })}${esc(plan().name)}</span>
            </div>
            <div class="card-body stack gap-4">
              <div class="wz-steps" id="wz-steps"></div>
              <div id="stage-host"></div>
            </div>
          </div>

          <div class="card" id="versions-card" hidden>
            <div class="card-head">
              <div class="card-title">Version history</div>
              <span class="card-sub" id="version-count"></span>
            </div>
            <div class="card-body"><div class="version-list" id="version-list"></div></div>
          </div>

          <div class="card" id="publish-card" hidden>
            <div class="card-head"><div class="card-title">Publish</div></div>
            <div class="card-body stack gap-3">
              <div id="publish-state"></div>
              <div class="field">
                <label class="field-label" for="slug-input">Shinzora address</label>
                <div class="row gap-2">
                  <input class="input" id="slug-input" placeholder="studio-aria" />
                  <span class="dim" style="font-size:var(--fs-xs);white-space:nowrap">.shinzora.in</span>
                </div>
                <div class="field-hint">Letters, numbers and dashes. Published sites are served read-only.</div>
              </div>
              <p class="muted" id="branding-note" style="font-size:var(--fs-2xs);line-height:1.6"></p>
              <div class="row gap-2 wrap">
                <button class="btn btn-primary btn-sm" id="publish-button">${icon("rocket", { size: 14 })}Publish</button>
                <button class="btn btn-secondary btn-sm" id="github-push">${icon("git-branch", { size: 14 })}Push to GitHub</button>
                <button class="btn btn-secondary btn-sm" id="vercel-deploy">${icon("cloud-upload", { size: 14 })}Deploy to Vercel</button>
              </div>
            </div>
          </div>
        </div>

        <div class="builder-stage">
          <div class="stage-bar">
            <div class="stage-url">${icon("lock", { size: 11 })}<span id="stage-url">preview.shinzora.in</span></div>
            <div class="segmented" id="viewport-toggle">
              <button data-viewport="desktop" aria-pressed="${isApp ? "false" : "true"}">${icon("monitor", { size: 13 })}</button>
              <button data-viewport="tablet" aria-pressed="false">${icon("tablet", { size: 13 })}</button>
              <button data-viewport="mobile" aria-pressed="${isApp ? "true" : "false"}">${icon("smartphone", { size: 13 })}</button>
            </div>
            <button class="btn btn-ghost btn-sm" id="open-fullscreen">${icon("maximize-2", { size: 13 })}Expand</button>
          </div>

          <div class="row gap-2 wrap" id="page-tabs" hidden></div>

          <div class="preview-frame" id="preview-frame">
            <div class="preview-empty" id="preview-empty">
              ${icon(config.icon, { size: 26 })}
              <p>Your generated ${isApp ? "app" : "website"} will appear here.</p>
              <span class="dim" style="font-size:var(--fs-2xs)">Start with the brief. The preview fills in after the build stage.</span>
            </div>
            <iframe id="preview" sandbox="allow-scripts allow-forms allow-popups" title="${esc(config.stageLabel)}" hidden></iframe>
          </div>

          <div class="card" id="report-card" hidden>
            <div class="card-head">
              <div class="card-title">Validation</div>
              <span class="card-sub" id="report-summary"></span>
            </div>
            <div class="card-body"><div id="report-body"></div></div>
          </div>
        </div>
      </div>`;

    /* ------------------------------------------------------------ elements */
    const host = qs("#stage-host");
    const stepsEl = qs("#wz-steps");
    const preview = qs("#preview");
    const previewEmpty = qs("#preview-empty");
    const versionList = qs("#version-list");
    const pageTabs = qs("#page-tabs");

    /* --------------------------------------------------------- entitlements */
    /* The plan decides how many platforms the app may target, and the answer
       comes from the database function, not from a list in the browser. */
    async function loadSlots() {
      if (!isApp) return;
      /* The per-format answer is the most precise one: it comes from the
         database rule that will also refuse the request, so the UI and the
         server cannot disagree. */
      try {
        const { data, error } = await sb.rpc("app_package_options");
        if (!error && Array.isArray(data) && data.length) {
          S.targetOptions = data;
          const ios = data.find((row) => row.target === "ipa");
          S.platformSlots = ios?.allowed ? 2 : 1;
          return;
        }
      } catch {
        /* fall through to the slot count */
      }
      try {
        const { data, error } = await sb.rpc("app_platform_slots");
        if (error) throw error;
        S.platformSlots = Number(data) >= 2 ? 2 : 1;
      } catch {
        /* A failed lookup must not grant the wider entitlement. */
        S.platformSlots = 1;
      }
    }
    await loadSlots();

    /* ------------------------------------------------------------- existing */
    if (projectId) {
      await loadProject(projectId);
    } else {
      /* A fresh build has to paint its first stage. Without this the panel kept
         the "Brief" heading and an empty body — the empty Website Builder screen
         that looked like a feature that had not been built. `loadProject` paints
         the stage itself for an existing project. */
      goStage("brief");
    }

    async function loadProject(id) {
      try {
        const { data, error } = await sb.from("projects").select("*").eq("id", id).maybeSingle();
        if (error) throw normalizeError(error);
        if (!data) {
          previewEmpty.innerHTML = emptyState({
            icon: "circle-alert",
            title: "Project not found",
            desc: "It may have been deleted, or it belongs to another account."
          });
          return;
        }
        S.project = data;
        qs("#publish-card").hidden = false;
        qs("#slug-input").value = data.slug || slugify(data.name);
        paintPublishState();

        const { data: rows, error: versionError } = await sb
          .from("project_versions")
          .select("*")
          .eq("project_id", id)
          .order("version_number", { ascending: false });
        if (versionError) throw normalizeError(versionError);
        S.versions = rows || [];
        qs("#versions-card").hidden = S.versions.length === 0;
        qs("#version-count").textContent = S.versions.length ? `${S.versions.length} saved` : "";
        paintVersions();

        if (isApp) await loadLatestPackageJob();

        if (S.versions.length) {
          /* Editing an existing project starts from what it already is: the
             current version is loaded and shown, nothing is regenerated. */
          showVersion(S.versions[0]);
          S.completedStages = ["brief", "information", "generate", "review"];
          goStage("review", { keepPreview: true });
        } else {
          goStage("brief");
        }
      } catch (error) {
        previewEmpty.innerHTML = setupNotice(error, "This project");
      }
    }

    /* ----------------------------------------------------------- stage rail */
    function paintSteps() {
      const progress = computeProgress({ stage: S.stage, completedStages: S.completedStages, completedTasks: S.completedTasks });
      stepsEl.innerHTML = `
        <div class="wz-bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${progress.percent}"
             aria-label="Builder progress">
          <span style="width:${progress.percent}%"></span>
        </div>
        <div class="wz-ticks">
          ${stages
            .map((stage) => {
              const done = S.completedStages.includes(stage.id);
              const active = S.stage === stage.id;
              return `<button class="wz-tick ${done ? "is-done" : ""} ${active ? "is-active" : ""}"
                        data-goto="${stage.id}" ${active ? 'aria-current="step"' : ""}
                        ${done || active ? "" : "disabled"}>
                        <span class="wz-num">${done ? icon("check", { size: 10, stroke: 3 }) : stage.number}</span>
                        <span class="wz-label">${esc(stage.title)}</span>
                      </button>`;
            })
            .join("")}
        </div>
        <p class="wz-hint">${progress.percent}% complete${S.stage === "generate" ? ` · stage ${progress.stagePercent}%` : ""}</p>`;
    }

    function goStage(id, options = {}) {
      if (!stages.some((stage) => stage.id === id)) return;
      S.stage = id;
      if (!options.keepPreview) qs("#report-card").hidden = id !== "review" || !S.validation;
      paintSteps();
      paintStage();
    }

    function paintStage() {
      const stage = stages.find((entry) => entry.id === S.stage);
      qs("#stage-title").textContent = `${stage.number}. ${stage.title}`;
      if (S.stage === "brief") paintBrief(stage);
      else if (S.stage === "information") paintInformation(stage);
      else if (S.stage === "generate") paintBuild(stage);
      else if (S.stage === "review") paintReview(stage);
      else paintSave(stage);
    }

    /* --------------------------------------------------------------- fields */
    function fieldMarkup(field) {
      const value = S.answers[S.stage]?.[field.id];
      const label = `<label class="field-label" for="f-${field.id}">${esc(field.label)}${field.required ? "" : ' <span class="dim">optional</span>'}</label>`;
      const hint = field.hint ? `<div class="field-hint">${esc(field.hint)}</div>` : "";

      if (field.type === "textarea") {
        return `<div class="field">${label}
          <textarea class="textarea" id="f-${field.id}" rows="4" data-field="${field.id}"
            placeholder="${esc(field.placeholder || "")}">${esc(value || "")}</textarea>${hint}</div>`;
      }
      if (field.type === "text") {
        return `<div class="field">${label}
          <input class="input" id="f-${field.id}" data-field="${field.id}" value="${esc(value || "")}"
            placeholder="${esc(field.placeholder || "")}" />${hint}</div>`;
      }
      if (field.type === "chips") {
        const chosen = Array.isArray(value) ? value : [];
        return `<div class="field">${label}
          <div class="row gap-2 wrap" id="chips-${field.id}">
            ${config.pageOptions
              .map(
                (option) =>
                  `<button type="button" class="chip ${chosen.includes(option) ? "is-active" : ""}"
                     data-choice="${esc(option)}">${esc(option)}</button>`
              )
              .join("")}
          </div>${hint}</div>`;
      }
      if (field.type === "colours") {
        const colours = value || {};
        return `<div class="field">${label}
          <div class="row gap-3 wrap">
            <label class="row gap-2" style="align-items:center;font-size:var(--fs-xs)">Primary
              <input type="color" id="f-colour-primary" data-colour="primary" value="${esc(colours.primary || "#7c3aed")}" /></label>
            <label class="row gap-2" style="align-items:center;font-size:var(--fs-xs)">Accent
              <input type="color" id="f-colour-accent" data-colour="accent" value="${esc(colours.accent || "#f59e0b")}" /></label>
            <label class="row gap-2" style="align-items:center;font-size:var(--fs-xs)">Background
              <input type="color" id="f-colour-bg" data-colour="bg" value="${esc(colours.bg || "#0b0914")}" /></label>
          </div>${hint}</div>`;
      }
      if (field.type === "asset") {
        const assets = S.answers.information?.assets || {};
        const attached = field.multiple ? assets[field.id] || [] : assets[field.id] ? [assets[field.id]] : [];
        return `<div class="field">${label}
          <input class="input" type="file" id="f-${field.id}" data-asset="${field.id}"
                 accept="${esc(field.accept || "image/*")}" ${field.multiple ? "multiple" : ""} />
          <div class="field-hint">${attached.length ? `${attached.length} file(s) attached and embedded in the page.` : "Images are embedded directly into the single file, so nothing can go missing."} Files over ${Math.round(ASSET_LIMIT_BYTES / 1024)} KB are refused.</div>
          <div class="row gap-2 wrap" id="assets-${field.id}">
            ${attached
              .map(
                (asset, index) =>
                  `<span class="badge badge-muted">${esc(asset.name)}<button class="btn-icon" data-drop-asset="${field.id}" data-index="${index}" aria-label="Remove ${esc(asset.name)}">${icon("x", { size: 10 })}</button></span>`
              )
              .join("")}
          </div>${hint}</div>`;
      }
      if (field.type === "package") {
        const value = S.answers.information.packageId || "";
        const suggestion = suggestPackageId(S.answers.information.name || "");
        return `<div class="field">${label}
          <input class="input mono" id="f-${field.id}" data-field="${field.id}" value="${esc(value)}"
                 placeholder="${esc(suggestion)}" spellcheck="false" autocapitalize="off" />
          <div class="field-hint">${esc(field.hint || "")} ${value ? "" : `Suggestion: <span class="mono">${esc(suggestion)}</span>.`}</div>${hint}</div>`;
      }
      if (field.type === "platform") {
        const options = packageOptions(S.platformSlots);
        const chosen = S.target ? resolveTarget(S.target) : null;
        return `<div class="field">${label}
          <div class="stack gap-2" id="platform-options">
            ${options
              .map(
                (option) => `<label class="wz-option ${S.target === option.target ? "is-active" : ""} ${option.locked ? "is-locked" : ""}">
                  <input type="radio" name="app-target" value="${option.target}"
                         ${S.target === option.target ? "checked" : ""} ${option.locked ? "disabled" : ""} />
                  <span><strong>${esc(option.label)} <span class="mono dim">${esc(option.extension)}</span></strong>
                    <span class="dim">${esc(option.note)}</span>
                    ${option.locked ? `<span class="dim">${esc(option.reason)} <a href="/app/?view=billing">See plans</a></span>` : ""}
                  </span>
                </label>`
              )
              .join("")}
          </div>
          <div class="field-hint">APK and AAB are Android builds of the same app; IPA is the iOS build. The app itself is a phone layout in every case.</div>
          ${
            chosen
              ? `<div class="wz-details" style="margin-top:8px">
                   <div class="field-label">What a ${esc(chosen.label)} needs before it can exist</div>
                   <ul class="wz-sources">${signingRequirements(chosen.target)
                     .map((need) => `<li><strong>${esc(need.label)}</strong> — ${esc(need.detail)}</li>`)
                     .join("")}</ul>
                   <p class="field-hint">None of these are configured on this deployment yet, so the build stage will produce the app, and the package will stay queued until they are.</p>
                 </div>`
              : ""
          }
          ${hint}</div>`;
      }
      return "";
    }

    /* ---------------------------------------------------------- stage 1 & 2 */
    function paintBrief(stage) {
      host.innerHTML = `
        <p class="muted" style="font-size:var(--fs-xs);line-height:1.6">${esc(stage.summary)}</p>
        ${stage.fields.map(fieldMarkup).join("")}
        <div class="row gap-2 wrap">
          <button class="btn btn-primary" id="stage-next">Continue to information ${icon("arrow-right", { size: 14 })}</button>
          ${S.versions.length ? `<button class="btn btn-ghost btn-sm" id="stage-back-review">Back to preview</button>` : ""}
        </div>
        <div id="stage-error"></div>`;
      wireFields();
      on(qs("#stage-next"), "click", () => {
        const problems = validateStage(stage, S.answers.brief);
        if (problems.length) return showStageError(problems);
        S.completedStages = unique([...S.completedStages, "brief"]);
        goStage("information");
      });
      if (S.versions.length) on(qs("#stage-back-review"), "click", () => goStage("review", { keepPreview: true }));
    }

    function paintInformation(stage) {
      host.innerHTML = `
        <p class="muted" style="font-size:var(--fs-xs);line-height:1.6">${esc(stage.summary)}</p>
        ${stage.fields.map(fieldMarkup).join("")}
        ${needsDatabase() ? databasePanel() : ""}
        <details class="wz-details">
          <summary>Research this industry (optional)</summary>
          <p class="field-hint">Asks the research service what is publicly known about this industry and its competitors, and shows every source it used. Nothing is returned if there are no sources.</p>
          <button class="btn btn-secondary btn-sm" id="research-button">${icon("search", { size: 13 })}Research industry and competitors</button>
          <div id="research-out"></div>
        </details>
        <div class="row gap-2 wrap">
          <button class="btn btn-ghost btn-sm" id="stage-back">Back</button>
          <button class="btn btn-primary" id="stage-next" ${aiReady ? "" : "disabled"}>Build it ${icon("sparkles", { size: 14 })}</button>
        </div>
        <div id="stage-error"></div>`;
      wireFields();
      wireDatabasePanel();
      on(qs("#stage-back"), "click", () => goStage("brief"));
      on(qs("#research-button"), "click", runResearch);
      on(qs("#stage-next"), "click", () => {
        const problems = validateStage(stage, S.answers.information);
        if (problems.length) return showStageError(problems);
        if (isApp) {
          const problemsForPackage = packageReadiness({
            target: S.target,
            appName: S.answers.information.name,
            packageId: S.answers.information.packageId,
            icon: S.answers.information.assets?.logo || null
          });
          if (problemsForPackage.length) return showStageError(problemsForPackage);
        }
        S.completedStages = unique([...S.completedStages, "brief", "information"]);
        goStage("generate");
        runBuild();
      });
    }

    function showStageError(problems) {
      const hostEl = qs("#stage-error");
      if (!hostEl) return;
      hostEl.innerHTML = `<div class="alert alert-warning"><span><span class="alert-title">Before continuing</span>
        <ul style="margin:6px 0 0 16px">${problems.map((p) => `<li>${esc(p.message)}</li>`).join("")}</ul></span></div>`;
      hostEl.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }

    /** Keep the answer object in sync with the controls as they change. */
    function wireFields() {
      const bucket = S.answers[S.stage] || (S.answers[S.stage] = {});
      qsa("[data-field]").forEach((node) => {
        node.addEventListener("input", () => {
          bucket[node.getAttribute("data-field")] = node.value;
        });
      });
      qsa("[data-choice]").forEach((node) => {
        node.addEventListener("click", () => {
          node.classList.toggle("is-active");
          const field = node.closest("[id^='chips-']").id.replace("chips-", "");
          bucket[field] = qsa(`#chips-${field} .chip.is-active`).map((chip) => chip.getAttribute("data-choice"));
        });
      });
      qsa("[data-colour]").forEach((node) => {
        node.addEventListener("input", () => {
          bucket.colours = { ...(bucket.colours || {}), [node.getAttribute("data-colour")]: node.value };
        });
      });
      qsa("[data-asset]").forEach((node) => {
        node.addEventListener("change", () => attachAssets(node));
      });
      qsa("[data-drop-asset]").forEach((node) => {
        node.addEventListener("click", () => {
          const field = node.getAttribute("data-drop-asset");
          const index = Number(node.getAttribute("data-index"));
          const assets = bucket.assets || {};
          if (Array.isArray(assets[field])) assets[field].splice(index, 1);
          else delete assets[field];
          bucket.assets = assets;
          paintStage();
        });
      });
      qsa("input[name='app-target']").forEach((node) => {
        node.addEventListener("change", () => {
          const chosen = node.value;
          const option = packageOptions(S.platformSlots).find((entry) => entry.target === chosen);
          /* The plan is enforced by the database (0012) and again here; this
             branch only explains the refusal the server would give anyway. */
          if (!option || option.locked) {
            toast(
              {
                title: "Not on this plan",
                message: option?.reason || `Your ${plan().name} plan targets one platform.`
              },
              { tone: "warning", duration: 7000 }
            );
            paintStage();
            return;
          }
          S.target = chosen;
          paintStage();
        });
      });
    }

    async function attachAssets(input) {
      const bucket = S.answers.information || (S.answers.information = {});
      const field = input.getAttribute("data-asset");
      const multiple = input.hasAttribute("multiple");
      const files = [...(input.files || [])];
      if (!files.length) return;

      const accepted = [];
      for (const file of files) {
        if (file.size > ASSET_LIMIT_BYTES) {
          toast(
            { title: `${file.name} is too large`, message: `Keep images under ${Math.round(ASSET_LIMIT_BYTES / 1024)} KB so the single page stays fast.` },
            { tone: "warning", duration: 6000 }
          );
          continue;
        }
        if (!/^image\//.test(file.type)) {
          toast({ title: `${file.name} is not an image`, message: "Use PNG, JPEG, WebP or SVG." }, { tone: "warning" });
          continue;
        }
        const dataUrl = await readAsDataUrl(file);
        if (dataUrl) accepted.push({ name: file.name, dataUrl, bytes: file.size });
      }

      const assets = bucket.assets || {};
      if (multiple) assets[field] = [...(assets[field] || []), ...accepted];
      else assets[field] = accepted[0] || null;
      bucket.assets = assets;
      paintStage();
    }

    /* ------------------------------------------------------------- research */
    async function runResearch() {
      const out = qs("#research-out");
      const button = qs("#research-button");
      button.disabled = true;
      out.innerHTML = `<p class="field-hint">${icon("loader", { size: 12 })} Asking the research service…</p>`;
      try {
        const result = await api.ai.research({
          industry: S.answers.brief.industry || S.answers.information.name || "",
          business: S.answers.information.name || "",
          audience: S.answers.brief.audience || "",
          references: S.answers.brief.references || "",
          type
        });
        const usable = researchUsable(result);
        S.research = usable;
        if (!usable) {
          out.innerHTML = `<div class="alert alert-info"><span><span class="alert-title">No sources returned</span>
            The research service answered without citations, so nothing from it will be used in the build. Research is only applied when it can be traced to a source.</span></div>`;
          S.research = null;
          return;
        }
        out.innerHTML = `<div class="stack gap-2" style="margin-top:8px">
          <p class="muted" style="font-size:var(--fs-xs);line-height:1.6">${esc(usable.summary)}</p>
          ${usable.patterns.length ? `<ul class="wz-sources">${usable.patterns.map((p) => `<li>${esc(p)}</li>`).join("")}</ul>` : ""}
          <div class="field-label">Sources used</div>
          <ul class="wz-sources">${usable.sources
            .map((source) => `<li><a href="${esc(source.url)}" target="_blank" rel="noopener nofollow">${esc(source.title || source.url)}</a></li>`)
            .join("")}</ul>
          <p class="field-hint">These links are shown to you and stored with the version, so you can check exactly what informed the build.</p>
        </div>`;
      } catch (error) {
        const normalized = normalizeError(error);
        S.research = null;
        out.innerHTML = `<div class="alert alert-warning"><span><span class="alert-title">Research unavailable</span>
          ${esc(normalized.message || "The research service did not answer.")}
          ${normalized.code === "unknown_action" || normalized.code === "fn_400" ? " Web research is not deployed on this instance yet, so the site will be built from your brief alone." : ""}
        </span></div>`;
      } finally {
        button.disabled = false;
      }
    }

    /* -------------------------------------------------------------- build */
    function paintBuild(stage) {
      const progress = computeProgress({ stage: "generate", completedStages: S.completedStages, completedTasks: S.completedTasks });
      host.innerHTML = `
        <p class="muted" style="font-size:var(--fs-xs);line-height:1.6">${esc(stage.summary)}</p>
        <div class="wz-progress">
          <div class="wz-bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${progress.stagePercent}">
            <span style="width:${progress.stagePercent}%"></span>
          </div>
          <div class="wz-progress-label"><span id="build-status">${esc(buildStatusText())}</span><span id="build-elapsed">0s</span></div>
        </div>
        <div class="trace" id="trace">
          ${GENERATION_TASKS.map(
            (task) => `<div class="trace-step ${S.completedTasks.includes(task.id) ? "done" : ""}" data-task="${task.id}">
              <span class="ts-dot">${S.completedTasks.includes(task.id) ? icon("check", { size: 9, stroke: 3 }) : ""}</span>
              <span>${esc(task.label)}</span>
              <span class="ts-time" data-time></span>
            </div>`
          ).join("")}
          <div class="trace-note" data-trace-note hidden></div>
        </div>
        <div id="stage-error"></div>
        <div class="row gap-2 wrap">
          ${S.busy ? `<button class="btn btn-secondary btn-sm" id="build-cancel">Cancel the run</button>` : ""}
          ${!S.busy && S.generated ? `<button class="btn btn-secondary" id="stage-next">Go to preview ${icon("arrow-right", { size: 14 })}</button>` : ""}
          ${!S.busy && !S.generated ? `<button class="btn btn-ghost btn-sm" id="stage-back">Back</button>` : ""}
        </div>`;
      if (qs("#stage-back")) on(qs("#stage-back"), "click", () => goStage("information"));
      if (qs("#stage-next")) on(qs("#stage-next"), "click", () => goStage("review", { keepPreview: true }));
      if (qs("#build-cancel")) on(qs("#build-cancel"), "click", cancelBuild);
    }

    function buildStatusText() {
      if (S.lastError) return S.lastError;
      const pending = GENERATION_TASKS.find((task) => !S.completedTasks.includes(task.id));
      return pending ? pending.label + "…" : "Build finished.";
    }

    let cancelRequested = false;
    function cancelBuild() {
      cancelRequested = true;
      S.busy = false;
      S.lastError = "Cancelled. Nothing was saved.";
      paintStage();
      toast({ title: "Build cancelled", message: "Nothing was saved. You can adjust the brief and build again." }, { tone: "warning" });
    }

    /** Mark a task complete. Progress is recomputed from these, never from a clock. */
    function completeTask(id) {
      if (S.completedTasks.includes(id)) return;
      S.completedTasks = [...S.completedTasks, id];
      const node = qs(`[data-task="${id}"]`);
      if (node) {
        node.classList.add("done");
        node.classList.remove("active");
        node.querySelector(".ts-dot").innerHTML = icon("check", { size: 9, stroke: 3 });
      }
      const progress = computeProgress({ stage: "generate", completedStages: S.completedStages, completedTasks: S.completedTasks });
      const bar = qs(".wz-progress .wz-bar > span");
      if (bar) bar.style.width = `${progress.stagePercent}%`;
      const status = qs("#build-status");
      if (status) status.textContent = buildStatusText();
      paintSteps();
    }

    function startTask(id) {
      const node = qs(`[data-task="${id}"]`);
      if (node) node.classList.add("active");
    }

    async function runBuild() {
      if (S.busy) return;
      S.busy = true;
      S.lastError = null;
      cancelRequested = false;
      S.completedTasks = [];
      S.generated = null;
      S.validation = null;
      paintStage();

      const startedAt = Date.now();
      const ticker = setInterval(() => {
        const seconds = Math.round((Date.now() - startedAt) / 1000);
        const el = qs("#build-elapsed");
        if (el) el.textContent = `${seconds}s`;
        const note = qs("[data-trace-note]");
        if (note && S.busy) {
          note.hidden = false;
          note.textContent =
            seconds > 45
              ? `${seconds}s elapsed. Large pages take longer; the run continues while this tab stays open.`
              : `${seconds}s elapsed`;
        }
      }, 500);

      try {
        /* 1 — the brief is read, normalised and turned into the instruction set */
        startTask("read_brief");
        const instruction = buildInstruction();
        completeTask("read_brief");

        /* 2 — the page plan is computed here, before any model is called */
        startTask("plan_structure");
        const plannedPages = plannedRoutes();
        completeTask("plan_structure");

        if (cancelRequested) return;

        /* 3/4/5 — the model returns layouts and code in one response, so those
           three tasks complete together when the response lands. The bar does
           not pretend they finish at different times. */
        startTask("generate_layouts");
        /* `project` was never declared in this scope: every build threw
           "project is not defined" at this line, which is why the Website
           Builder produced nothing at all. The state lives on S.project. */
        const response = S.project
          ? await api.ai.revise({
              type,
              projectType: type,
              instruction,
              files: S.activeVersion?.files || null,
              projectId: S.project.id,
              versionId: S.activeVersion?.id || null,
              singleFile: true,
              mobileOnly: isApp
            })
          : await api.ai.generate(buildPayload(instruction, plannedPages));
        if (cancelRequested) return;
        completeTask("generate_layouts");
        startTask("write_code");

        const rawFiles = response?.files || (response?.html ? { "index.html": response.html } : {});
        if (!Object.keys(rawFiles).length) throw new Error("The AI response did not contain any files. Try again or describe the pages more specifically.");
        completeTask("write_code");

        /* 5 — assets: uploaded images are embedded, local css/js are inlined */
        startTask("add_assets");
        const single = toSingleFile(rawFiles, { entry: response?.entry || "index.html" });
        const withAssets = embedAssets(single.html);
        completeTask("add_assets");

        /* 6 — responsiveness is measured on the document that would be saved */
        startTask("check_responsive");
        const responsive = checkResponsive(withAssets);
        completeTask("check_responsive");

        /* 7 — the real validation report */
        startTask("validate");
        const validation = validateSiteDocument(withAssets, { requiredRoutes: plannedPages });
        /* The app tests are measured on the same document, and their findings
           join one report so the customer reads one list, not two. */
        if (isApp) {
          const mobileCheck = validateMobileApp(withAssets);
          S.mobileCheck = mobileCheck;
          for (const issue of mobileCheck.issues) {
            validation.issues.push(issue);
            validation.counts[issue.level] += 1;
          }
          validation.ok = validation.counts.error === 0;
        }
        if (!responsive.viewport) {
          validation.issues.unshift({
            level: "error",
            code: "viewport",
            title: "Not mobile-ready",
            detail: "The document has no viewport meta tag, so it will not scale on a phone."
          });
          validation.counts.error += 1;
          validation.ok = false;
        }
        completeTask("validate");

        S.generated = {
          html: withAssets,
          files: { "index.html": withAssets },
          pages: single.pages,
          warnings: single.warnings,
          validation,
          responsive,
          model: response?.model || null,
          notes: response?.notes || "",
          sources: S.research?.sources || [],
          plannedPages,
          instruction,
          target: S.target,
          mobileCheck: S.mobileCheck || null,
          createdAt: new Date().toISOString()
        };
        S.validation = validation;

        S.completedStages = unique([...S.completedStages, "brief", "information", "generate"]);
        S.busy = false;
        showGenerated();
        paintStage();
        goStage("review", { keepPreview: true });

        if (validation.counts.error) {
          toast(
            { title: "Built, with problems", message: validationSummary(validation) + " — read the validation panel." },
            { tone: "warning", duration: 8000 }
          );
        } else {
          toast({ title: "Build finished", message: "Walk through the pages, then confirm to save a version." }, { tone: "success" });
        }
      } catch (error) {
        S.busy = false;
        const normalized = normalizeError(error);
        S.lastError = describeFailure(normalized);
        paintStage();
        toastError(normalized);
      } finally {
        clearInterval(ticker);
      }
    }

    function describeFailure(error) {
      const code = String(error?.code || "");
      if (code === "functions_unavailable") return "The AI function is not deployed on this deployment.";
      if (code === "quota_exceeded" || code === "ai_quota_exhausted") return "This plan's AI allowance for the cycle is used up.";
      if (code === "timeout") return "The AI service did not answer in time.";
      return error?.message || "The build did not finish.";
    }

    /**
     * Does this site actually have to store anything? A contact form that posts
     * nowhere is the single most common broken promise on a generated site, so
     * the connection fields appear only when the brief asks for one, and the
     * generated page is told exactly where to send the data or told to say the
     * form is not connected yet.
     */
    function needsDatabase() {
      const text = [
        S.answers.brief.purpose,
        S.answers.brief.design,
        S.answers.information.launch,
        S.answers.information.description
      ]
        .filter(Boolean)
        .join(" ");
      return /form|enquir|inquir|book|reserv|submit|sign\s?up|newsletter|order|save|database|supabase|crm/i.test(text);
    }

    function databasePanel() {
      const db = S.answers.information.database || {};
      return `<details class="wz-details" ${db.url ? "open" : ""}>
        <summary>Save form submissions (optional)</summary>
        <p class="field-hint" style="margin-top:6px">
          The brief mentions a form or a booking flow. Without a database the page will say the form is not connected yet — it will not pretend to send anything.
        </p>
        <div class="field">
          <label class="field-label" for="db-url">Supabase project URL</label>
          <input class="input" id="db-url" data-db="url" value="${esc(db.url || "")}" placeholder="https://your-project.supabase.co" />
        </div>
        <div class="field">
          <label class="field-label" for="db-key">Publishable (anon) key</label>
          <input class="input" id="db-key" data-db="key" value="${esc(db.key || "")}" placeholder="sb_publishable_…" />
          <div class="field-hint">Only the publishable key is used, and only inside the generated page. A service-role key is refused here: it would hand every visitor full access to your data.</div>
        </div>
      </details>`;
    }

    function wireDatabasePanel() {
      const bucket = S.answers.information || (S.answers.information = {});
      qsa("[data-db]").forEach((node) => {
        node.addEventListener("input", () => {
          const next = { ...(bucket.database || {}) };
          next[node.getAttribute("data-db")] = node.value.trim();
          bucket.database = next;
          if (/service_role/i.test(next.key || "")) {
            toast(
              { title: "That key is refused", message: "A service-role key in a public page gives every visitor full access to your database. Use the publishable key." },
              { tone: "error", duration: 9000 }
            );
            node.value = "";
            delete bucket.database.key;
          }
        });
      });
    }

    function buildInstruction() {
      const brief = S.answers.brief;
      const info = S.answers.information;
      const lines = [
        `Purpose: ${brief.purpose}`,
        `Industry: ${brief.industry}`,
        `Audience: ${brief.audience}`,
        brief.design ? `Desired design and function: ${brief.design}` : "",
        brief.references ? `References: ${brief.references}` : "",
        `Name: ${info.name}`,
        info.description ? `Description: ${info.description}` : "",
        `Contact: ${info.contact}`,
        info.colours ? `Brand colours: ${Object.entries(info.colours).map(([key, value]) => `${key} ${value}`).join(", ")}` : "",
        info.launch ? `Before launch: ${info.launch}` : "",
        info.database?.url
          ? `Forms should save to Supabase at ${info.database.url} using the publishable key supplied by the customer.`
          : "No database is connected: any form must say it is not connected yet instead of pretending to submit.",
        "Return exactly one index.html file. Every page must live inside it behind hash routes (#/about). No separate CSS, JS or extra HTML files.",
        S.research
          ? `Use only these researched facts, and keep their sources in a comment at the end: ${S.research.summary}`
          : ""
      ];
      return lines.filter(Boolean).join("\n");
    }

    function plannedRoutes() {
      const pages = S.answers.information.pages || config.defaults;
      return pages.map((page) => (page.toLowerCase() === "home" ? "/" : `/${slugify(page) || page.toLowerCase()}`));
    }

    function buildPayload(instruction, plannedPages) {
      const payload = {
        type,
        name: S.answers.information.name || "Untitled project",
        brief: instruction,
        pages: S.answers.information.pages || config.defaults,
        style: S.answers.brief.design || null,
        business: state.business || null,
        /* The single-file contract is stated to the server, and enforced again
           on the way back by lib/single-file.js. */
        singleFile: true,
        mobileOnly: isApp,
        target: S.target,
        research: S.research
          ? { summary: S.research.summary, patterns: S.research.patterns, sources: S.research.sources }
          : null,
        model: null
      };
      return payload;
    }

    /** Embed uploaded images into the document as data URIs. */
    function embedAssets(html) {
      let doc = html;
      const assets = S.answers.information.assets || {};
      const logo = assets.logo;
      const images = Array.isArray(assets.images) ? assets.images : [];

      if (logo?.dataUrl) {
        doc = doc.replace(/<img\b([^>]*?)src=["'][^"']*logo[^"']*["']([^>]*)>/gi, `<img$1src="${logo.dataUrl}"$2>`);
      }
      images.forEach((asset, index) => {
        const pattern = new RegExp(`<img\\b([^>]*?)src=["'][^"']*(?:hero|image|photo|img|slide)[^"']*["']([^>]*)>`, "i");
        doc = doc.replace(pattern, `<img$1src="${asset.dataUrl}"$2>`);
        void index;
      });
      return doc;
    }

    /* ------------------------------------------------------------- preview */
    function showVersion(version) {
      S.activeVersion = version;
      paintVersions();
      const files = version.files || {};
      const html = files["index.html"] || Object.values(files).find((value) => /<html/i.test(String(value))) || "";
      if (!html) {
        preview.hidden = true;
        previewEmpty.hidden = false;
        previewEmpty.innerHTML = `<p>This version has no stored page.</p>`;
        return;
      }
      /* A stored version is a file set: index.html, styles.css, app.js. Dropped
         into a srcdoc frame unchanged, its relative <link> and <script src> tags
         resolve against the console's own URL, so the preview showed an unstyled
         page whose script 404'd. Build the single self-contained document —
         exactly what the published site is served from. */
      const document_ = buildPreviewDocument(files, version.meta?.entry || "index.html", { allowForms: false, branding: false });
      paintPreview(document_, { pages: version.meta?.pages || [], meta: version.meta || {} });
      if (version.meta?.validation) {
        S.validation = version.meta.validation;
        paintReport(version.meta.validation);
      }
      qs("#report-card").hidden = !version.meta?.validation;
    }

    function showGenerated() {
      const generated = S.generated;
      paintPreview(generated.html, { pages: generated.pages, meta: { model: generated.model, notes: generated.notes } });
      paintReport(generated.validation);
      qs("#report-card").hidden = false;
    }

    function paintPreview(html, options = {}) {
      previewEmpty.hidden = true;
      preview.hidden = false;
      S.previewHtml = html;
      preview.srcdoc = html;
      const routes = options.pages?.length
        ? options.pages.map((page) => (typeof page === "string" ? { route: page, title: page } : page))
        : [];
      pageTabs.hidden = routes.length < 2;
      pageTabs.innerHTML = routes
        .map(
          (page, index) =>
            `<button class="chip ${index === 0 ? "is-active" : ""}" data-route="${esc(page.route)}">${esc(
              page.title || page.route
            )}</button>`
        )
        .join("");
      applyViewport(isApp ? "mobile" : "desktop");
      qs("#stage-url").textContent = `${S.project?.slug || "preview"}.shinzora.in`;
    }

    /**
     * Show a specific page of the generated document. The hash is set by a
     * script inside the sandbox, so this works with the same permissions the
     * downloaded file has.
     */
    function previewAt(route) {
      const html = S.previewHtml;
      if (!html) return;
      const escaped = JSON.stringify(String(route || "/")).replace(/</g, "\\u003c");
      const jump = `<script data-shinzora-jump>location.hash=${escaped};</script>`;
      preview.srcdoc = /<\/body>/i.test(html) ? html.replace(/<\/body>/i, `${jump}</body>`) : `${html}${jump}`;
    }

    function paintReport(validation) {
      if (!validation) return;
      qs("#report-summary").textContent = validationSummary(validation);
      const order = { error: 0, warning: 1, info: 2 };
      const issues = [...(validation.issues || [])].sort((a, b) => order[a.level] - order[b.level]);
      safeSet("#report-body", issues.length
        ? `<div class="stack gap-2">${issues
            .map(
              (issue) => `<div class="wz-issue is-${esc(issue.level)}">
                <span class="wz-issue-icon">${icon(issue.level === "error" ? "circle-x" : issue.level === "warning" ? "triangle-alert" : "info", { size: 14 })}</span>
                <span><strong>${esc(issue.title)}</strong><span class="dim">${esc(issue.detail)}</span></span>
              </div>`
            )
            .join("")}</div>`
        : `<div class="alert alert-ok"><span><span class="alert-title">No problems found</span>
             Every internal link resolves, no asset is missing, and the inline scripts parse.</span></div>`);
    }

    function applyViewport(mode) {
      qsa("#viewport-toggle button").forEach((node) => node.setAttribute("aria-pressed", String(node.getAttribute("data-viewport") === mode)));
      const frame = qs("#preview-frame");
      frame.style.maxWidth = mode === "mobile" ? "390px" : mode === "tablet" ? "768px" : "100%";
      frame.style.margin = mode === "desktop" ? "0" : "0 auto";
      frame.style.aspectRatio = mode === "mobile" ? "9 / 16" : mode === "tablet" ? "3 / 4" : "16 / 11";
      frame.style.minHeight = mode === "mobile" ? "640px" : "380px";
    }

    /* --------------------------------------------------------- stage 4 & 5 */
    function paintReview() {
      const validation = S.validation || S.activeVersion?.meta?.validation || null;
      const html = S.generated?.html || S.activeVersion?.files?.["index.html"] || "";
      const pages = S.generated?.pages || S.activeVersion?.meta?.pages || [];
      const sources = S.generated?.sources || S.activeVersion?.meta?.sources || [];

      host.innerHTML = `
        <p class="muted" style="font-size:var(--fs-xs);line-height:1.6">
          Walk through every page in the preview. Desktop, tablet and phone are all available on the right.
        </p>
        <div class="wz-review">
          <div class="kv"><dt>Pages</dt><dd>${pages.length ? pages.length : "1"} inside one index.html</dd></div>
          <div class="kv"><dt>Validation</dt><dd>${validation ? esc(validationSummary(validation)) : "Not run yet"}</dd></div>
          ${isApp && S.target ? `<div class="kv"><dt>Package</dt><dd>${esc(resolveTarget(S.target)?.label || S.target)} · <span class="mono">${esc(S.answers.information.packageId || "")}</span></dd></div>` : ""}
          ${isApp && S.mobileCheck ? `<div class="kv"><dt>Mobile layout</dt><dd>${S.mobileCheck.mobile ? "Phone-sized, fluid, with touch handling" : "Not a phone layout"}</dd></div>` : ""}
          ${S.generated?.model ? `<div class="kv"><dt>Model</dt><dd class="mono">${esc(S.generated.model)}</dd></div>` : ""}
        </div>
        ${
          isApp && S.target
            ? `<details class="wz-details">
                 <summary>What the ${esc(resolveTarget(S.target)?.label || S.target)} still needs</summary>
                 <ul class="wz-sources">${signingRequirements(S.target)
                   .map((need) => `<li><strong>${esc(need.label)}</strong> — ${esc(need.detail)}</li>`)
                   .join("")}</ul>
                 <p class="field-hint">These are server-side requirements. Until they exist, the app itself can be built and previewed, but no package file can be produced.</p>
               </details>`
            : ""
        }
        ${
          sources.length
            ? `<div class="field"><div class="field-label">Research sources used</div>
                 <ul class="wz-sources">${sources
                   .map((source) => `<li><a href="${esc(source.url)}" target="_blank" rel="noopener nofollow">${esc(source.title || source.url)}</a></li>`)
                   .join("")}</ul></div>`
            : ""
        }
        <div class="field">
          <label class="field-label" for="revision">Ask the AI for a change</label>
          <textarea class="textarea" id="revision" rows="3" placeholder="Make the hero shorter, add a testimonials section, and switch the accent to warm sand."></textarea>
          <div class="field-hint">A change is applied to this document and previewed. Nothing is saved until you confirm on the next stage.</div>
          <div class="row gap-2 wrap" style="margin-top:8px">
            <button class="btn btn-secondary btn-sm" id="revise-button" ${aiReady && html ? "" : "disabled"}>${icon("wand-sparkles", { size: 13 })}Apply the change</button>
          </div>
        </div>
        <div class="row gap-2 wrap">
          <button class="btn btn-ghost btn-sm" id="stage-back">Back to brief</button>
          <button class="btn btn-primary" id="stage-next" ${html ? "" : "disabled"}>Save this as a new version ${icon("arrow-right", { size: 14 })}</button>
        </div>
        <div id="stage-error"></div>`;

      on(qs("#stage-back"), "click", () => goStage("brief"));
      on(qs("#stage-next"), "click", () => {
        S.completedStages = unique([...S.completedStages, "review"]);
        goStage("save");
      });
      on(qs("#revise-button"), "click", applyRevision);
    }

    async function applyRevision() {
      const instruction = qs("#revision").value.trim();
      if (instruction.length < 4) {
        toast({ title: "Describe the change", message: "One sentence is enough." }, { tone: "warning" });
        return;
      }
      const base = S.generated?.html || S.activeVersion?.files?.["index.html"];
      if (!base) return;
      const button = qs("#revise-button");
      button.disabled = true;
      button.innerHTML = `<span class="spinner"></span><span>Applying…</span>`;
      try {
        const response = await api.ai.revise({
          type,
          projectType: type,
          instruction,
          files: { "index.html": base },
          singleFile: true,
          mobileOnly: isApp
        });
        const rawFiles = response?.files || (response?.html ? { "index.html": response.html } : {});
        if (!Object.keys(rawFiles).length) throw new Error("The change came back empty. Try describing it differently.");
        const single = toSingleFile(rawFiles, { entry: "index.html" });
        const html = embedAssets(single.html);
        const plannedPages = plannedRoutes();
        const validation = validateSiteDocument(html, { requiredRoutes: plannedPages });

        /* The change is staged, not saved: the save stage still needs a
           confirmation, and the previous version is untouched until then. */
        S.generated = {
          ...(S.generated || {}),
          html,
          files: { "index.html": html },
          pages: single.pages,
          validation,
          model: response?.model || null,
          notes: response?.notes || "",
          sources: S.generated?.sources || [],
          plannedPages,
          revised: instruction,
          createdAt: new Date().toISOString()
        };
        S.validation = validation;
        paintPreview(html, { pages: single.pages });
        paintReport(validation);
        qs("#report-card").hidden = false;
        paintReview();
        toast({ title: "Change applied", message: validationSummary(validation) + ". Review it, then confirm to save." }, { tone: "success" });
      } catch (error) {
        toastError(normalizeError(error));
        paintReview();
      }
    }

    function paintSave() {
      const html = S.generated?.html || S.activeVersion?.files?.["index.html"] || "";
      const validation = S.validation;
      const nextNumber = (S.versions[0]?.version_number || 0) + 1;
      host.innerHTML = `
        <p class="muted" style="font-size:var(--fs-xs);line-height:1.6">
          Saving stores this as version ${nextNumber}. Every earlier version stays exactly as it is.
        </p>
        <div class="wz-review">
          <div class="kv"><dt>Project</dt><dd>${esc(S.project?.name || S.answers.information.name || "New project")}</dd></div>
          <div class="kv"><dt>Version</dt><dd>v${nextNumber} · one file, index.html</dd></div>
          <div class="kv"><dt>Validation</dt><dd>${validation ? esc(validationSummary(validation)) : "Not run"}</dd></div>
        </div>
        ${
          validation && validation.counts.error
            ? `<div class="alert alert-warning"><span><span class="alert-title">${validation.counts.error} problem(s) in this version</span>
                 You can save it and keep editing, but the preview will show the same problems.</span></div>`
            : ""
        }
        <div class="row gap-2 wrap">
          <button class="btn btn-ghost btn-sm" id="stage-back">Back to preview</button>
          <button class="btn btn-primary" id="save-button" ${html ? "" : "disabled"}>${icon("save", { size: 14 })}Save version ${nextNumber}</button>
          <button class="btn btn-secondary btn-sm" id="download-button" ${html ? "" : "disabled"}>${icon("download", { size: 14 })}Download the app (index.html)</button>
        </div>
        ${isApp ? packageSection() : ""}
        <div id="stage-error"></div>`;
      on(qs("#stage-back"), "click", () => goStage("review", { keepPreview: true }));
      on(qs("#save-button"), "click", saveVersion);
      on(qs("#download-button"), "click", () => downloadGenerated());
      if (isApp && qs("#request-package")) on(qs("#request-package"), "click", requestPackage);
    }

    /**
     * The package half of the app builder.
     *
     * It asks the database for the real state of the build, and says only what
     * is true: a queued request is not an APK, and nothing here can produce one
     * until a toolchain and signing credentials exist on the server.
     */
    function packageSection() {
      const target = S.target ? resolveTarget(S.target) : null;
      if (!target) {
        return `<div class="wz-details"><p class="field-hint">Choose a package format on the information stage to request a build.</p></div>`;
      }
      const job = S.packageJob;
      const status = job ? describeConversionJob(job) : null;
      return `<div class="wz-details" id="package-section">
        <div class="field-label">${esc(target.label)}</div>
        ${
          status
            ? `<div class="wz-review" style="margin-top:6px">
                 <div class="kv"><dt>Status</dt><dd>${esc(status.label)}</dd></div>
                 <div class="kv"><dt>Package id</dt><dd class="mono">${esc(job.package_id || "")}</dd></div>
                 <div class="kv"><dt>Requested</dt><dd>${esc(timeAgo(job.created_at))}</dd></div>
               </div>
               <p class="field-hint">${esc(status.detail)}</p>
               ${
                 status.downloadable
                   ? `<button class="btn btn-secondary btn-sm" id="download-package">${icon("download", { size: 13 })}Download the ${esc(target.extension)}</button>`
                   : `<p class="field-hint">${icon("info", { size: 12 })} No package file exists yet, so there is nothing to download and nothing is claimed to be ready.</p>`
               }`
            : `<p class="field-hint">Saving a version stores the app. Requesting the package asks the build service for the ${esc(target.extension)} file; it does not create one on its own.</p>
               <button class="btn btn-secondary btn-sm" id="request-package" ${S.activeVersion || S.generated ? "" : "disabled"}>
                 ${icon("package", { size: 13 })}Request the ${esc(target.label)}
               </button>
               <p class="field-hint">The request is saved in the database against this version, so it is never lost and never invented.</p>`
        }
      </div>`;
    }

    async function requestPackage() {
      if (!S.project) {
        toast({ title: "Save the version first", message: "A package is built from a saved version, so save one before requesting it." }, { tone: "warning" });
        return;
      }
      const version = S.activeVersion;
      if (!version) {
        toast({ title: "Save the version first", message: "The package is attached to a specific version." }, { tone: "warning" });
        return;
      }
      const target = resolveTarget(S.target);
      if (!target) return;
      const problems = packageReadiness({
        target: S.target,
        appName: S.answers.information.name,
        packageId: S.answers.information.packageId,
        icon: S.answers.information.assets?.logo || null
      });
      if (problems.length) {
        showStageError(problems);
        return;
      }

      const button = qs("#request-package");
      if (button) {
        button.disabled = true;
        button.innerHTML = `<span class="spinner"></span><span>Requesting…</span>`;
      }
      try {
        const { data, error } = await sb
          .from("conversion_jobs")
          .insert({
            user_id: state.user.id,
            project_id: S.project.id,
            version_id: version.id,
            platform: target.platform,
            target: target.target,
            app_name: S.answers.information.name,
            package_id: S.answers.information.packageId,
            permissions: [],
            meta: {
              screens: S.generated?.pages || version.meta?.pages || [],
              requested_from: "app-builder",
              app_size_hint: "WebView wrapper"
            }
          })
          .select("*")
          .single();
        if (error) throw error;
        S.packageJob = data;
        const described = describeConversionJob(data);
        toast(
          {
            title: described.label,
            message: described.detail
          },
          { tone: described.downloadable ? "success" : "info", duration: 9000 }
        );
        paintStage();
      } catch (error) {
        const normalized = normalizeError(error);
        const message = String(normalized.message || "");
        if (/Enterprise|one platform/i.test(message)) {
          toast({ title: "Not on this plan", message }, { tone: "warning", duration: 9000 });
        } else if (/duplicate|unique/i.test(message)) {
          toast({ title: "Already requested", message: "A build for this format is already open for this project." }, { tone: "info" });
        } else if (/checksum|artifact/i.test(message)) {
          toast({ title: "Refused by the database", message }, { tone: "error", duration: 9000 });
        } else {
          toastError(normalized);
        }
        paintStage();
      }
    }

    /** Read the newest request for this project, so a reload never forgets it. */
    async function loadLatestPackageJob() {
      if (!isApp || !S.project) return;
      try {
        const { data } = await sb
          .from("conversion_jobs")
          .select("*")
          .eq("project_id", S.project.id)
          .order("created_at", { ascending: false })
          .limit(1);
        S.packageJob = data?.[0] || null;
      } catch {
        /* Nothing to show is better than inventing a state. */
        S.packageJob = null;
      }
    }

    async function saveVersion() {
      const generated = S.generated;
      if (!generated) return;

      if (!S.project) {
        const limit = await canCreateProject();
        if (!limit.allowed) {
          toast(
            { title: "Project limit reached", message: `Your ${plan().name} plan allows ${limit.limit} projects. Upgrade in Billing to add more.` },
            { tone: "warning", duration: 7000 }
          );
          return;
        }
      }

      const nextNumber = (S.versions[0]?.version_number || 0) + 1;
      /* Never overwrite anything without asking, and say exactly what changes. */
      const ok = await confirmDialog({
        title: `Save version ${nextNumber}?`,
        desc: S.project
          ? `“${S.project.name}” keeps version${nextNumber > 2 ? "s" : ""} 1–${nextNumber - 1} exactly as they are. Version ${nextNumber} becomes the current preview.`
          : `A new project is created with version ${nextNumber}. You can revise it afterwards without losing this one.`,
        confirmLabel: `Save version ${nextNumber}`
      });
      if (!ok) return;

      const button = qs("#save-button");
      button.disabled = true;
      button.innerHTML = `<span class="spinner"></span><span>Saving…</span>`;

      try {
        if (!S.project) {
          const name = S.answers.information.name || "Untitled project";
          const slug = slugify(name) || `project-${Date.now().toString(36)}`;
          const { data, error } = await sb
            .from("projects")
            .insert({
              owner_id: state.user.id,
              business_id: state.business?.id || null,
              name,
              description: (S.answers.brief.purpose || "").slice(0, 280),
              type,
              status: "ready",
              slug: `${slug}-${Math.random().toString(36).slice(2, 6)}`,
              framework: "html",
              preview_data: { pages: generated.plannedPages, single_file: true }
            })
            .select("*")
            .single();
          if (error) throw normalizeError(error);
          S.project = data;
          qs("#publish-card").hidden = false;
          qs("#slug-input").value = data.slug;
          history.replaceState({}, "", `/app/?view=${viewSlug}&id=${data.id}`);
          paintPublishState();
        }

        const { data: savedVersion, error: versionError } = await sb
          .from("project_versions")
          .insert({
            project_id: S.project.id,
            version_number: nextNumber,
            prompt: generated.revised || generated.instruction || S.answers.brief.purpose || "",
            files: generated.files,
            meta: {
              entry: "index.html",
              single_file: true,
              pages: generated.pages,
              planned_pages: generated.plannedPages,
              validation: generated.validation,
              sources: generated.sources,
              target: generated.target || null,
              mobile_check: generated.mobileCheck || null,
              model: generated.model,
              notes: generated.notes,
              stages: S.completedStages,
              reviewed_at: new Date().toISOString()
            },
            created_by: state.user.id
          })
          .select("*")
          .single();
        if (versionError) throw normalizeError(versionError);

        await sb
          .from("projects")
          .update({ status: "ready", version_count: nextNumber, updated_at: new Date().toISOString() })
          .eq("id", S.project.id);

        S.versions = [savedVersion, ...S.versions];
        qs("#versions-card").hidden = false;
        qs("#version-count").textContent = `${S.versions.length} saved`;
        paintVersions();
        S.activeVersion = savedVersion;
        S.completedStages = unique([...S.completedStages, "save"]);
        if (isApp) await loadLatestPackageJob();
        paintSteps();
        toast({ title: `Version ${nextNumber} saved`, message: "Earlier versions are untouched. Download, revise or publish from here." }, { tone: "success" });
        paintStage();

        /* Announce it once, in the customer's own notification list. */
        await sb.from("notifications").insert({
          user_id: state.user.id,
          type: "website",
          title: `${config.title.replace(" Builder", "")} version ${nextNumber} saved`,
          body: S.project.name,
          link: `/app/?view=${viewSlug}&id=${S.project.id}`
        });
      } catch (error) {
        toastError(normalizeError(error));
        button.disabled = false;
        button.innerHTML = `${icon("save", { size: 14 })}Save version ${nextNumber}`;
      }
    }

    /* ------------------------------------------------------ versions/history */
    function paintVersions() {
      if (!versionList) return;
      versionList.innerHTML = S.versions
        .map(
          (version) => `<div class="wz-version ${S.activeVersion?.id === version.id ? "is-current" : ""}">
            <button class="version-item" data-version="${esc(version.id)}">
              <span class="vi-num">v${version.version_number}</span>
              <span class="truncate">${esc(version.prompt ? version.prompt.slice(0, 44) : "Initial generation")}</span>
              <span class="vi-time">${esc(timeAgo(version.created_at))}</span>
            </button>
            <div class="row gap-1">
              <button class="btn-icon" data-download-version="${esc(version.id)}" aria-label="Download version ${version.version_number}">${icon("download", { size: 12 })}</button>
              <button class="btn-icon" data-restore-version="${esc(version.id)}" aria-label="Restore version ${version.version_number}">${icon("rotate-cw", { size: 12 })}</button>
            </div>
          </div>`
        )
        .join("");
    }

    function downloadGenerated() {
      const html = S.generated?.html || S.activeVersion?.files?.["index.html"];
      if (!html) {
        toast({ title: "Nothing to download", message: "Build or open a version first." }, { tone: "warning" });
        return;
      }
      const { filename, content } = singleFileDownload(S.project?.name || S.answers.information.name || "site", html);
      const blob = new Blob([content], { type: "text/html;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = filename;
      link.rel = "noopener";
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
      toast({ title: "Downloaded", message: `${filename} contains the whole site and opens in any browser.` }, { tone: "success" });
    }

    async function restoreVersion(version) {
      const ok = await confirmDialog({
        title: `Restore version ${version.version_number}?`,
        desc: "A new version is created from it. Nothing is deleted, so you can go back to any version again.",
        confirmLabel: "Restore"
      });
      if (!ok) return;
      const nextNumber = (S.versions[0]?.version_number || 0) + 1;
      const { data, error } = await sb
        .from("project_versions")
        .insert({
          project_id: S.project.id,
          version_number: nextNumber,
          prompt: `Restored from version ${version.version_number}`,
          files: version.files,
          meta: { ...(version.meta || {}), restored_from: version.version_number },
          created_by: state.user.id
        })
        .select("*")
        .single();
      if (error) return toastError(normalizeError(error));
      S.versions = [data, ...S.versions];
      await sb.from("projects").update({ version_count: nextNumber, updated_at: new Date().toISOString() }).eq("id", S.project.id);
      paintVersions();
      showVersion(data);
      qs("#version-count").textContent = `${S.versions.length} saved`;
      goStage("review", { keepPreview: true });
      toast({ title: `Version ${nextNumber} created`, message: `Restored from version ${version.version_number}.` }, { tone: "success" });
    }

    /* ------------------------------------------------------------ publishing */
    function brandingRemovableLocal() {
      return Boolean(plan()?.removeBranding);
    }

    function paintPublishState() {
      const note = qs("#branding-note");
      if (note) {
        note.innerHTML = brandingRemovableLocal()
          ? `${icon("badge-check", { size: 12 })} Your plan removes the Shinzora badge from published sites.`
          : `${icon("info", { size: 12 })} On the Free plan, published sites carry a small “Made with Shinzora” badge. Pro and Enterprise remove it.`;
      }
      const host2 = qs("#publish-state");
      if (!host2 || !S.project) return;
      host2.innerHTML =
        S.project.status === "published"
          ? `<div class="alert alert-ok"><span><span class="alert-title">Published</span>
               Live at <a href="/site/?p=${esc(S.project.slug)}" target="_blank" rel="noopener">${esc(S.project.slug)}.shinzora.in</a>
               · last published ${esc(timeAgo(S.project.published_at))}</span></div>`
          : `<div class="alert alert-info"><span><span class="alert-title">Not published</span>The preview is private to your account until you publish.</span></div>`;
    }

    async function publish() {
      if (!S.project || !S.activeVersion) {
        toast({ title: "Save a version first" }, { tone: "warning" });
        return;
      }
      const slug = slugify(qs("#slug-input").value) || slugify(S.project.name);
      if (slug.length < 3) {
        toast({ title: "Address too short", message: "Use at least 3 characters." }, { tone: "warning" });
        return;
      }
      try {
        const { error } = await sb
          .from("projects")
          .update({
            slug,
            status: "published",
            published_at: new Date().toISOString(),
            published_version_id: S.activeVersion.id,
            updated_at: new Date().toISOString()
          })
          .eq("id", S.project.id);
        if (error) throw normalizeError(error);
        S.project.status = "published";
        S.project.slug = slug;
        paintPublishState();
        toast({ title: "Published", message: `${slug}.shinzora.in is live.` }, { tone: "success" });
      } catch (error) {
        const normalized = normalizeError(error);
        toast(
          { title: normalized.code === "conflict" ? "That address is taken" : "Could not publish", message: normalized.message },
          { tone: "error", duration: 7000 }
        );
      }
    }

    /* ----------------------------------------------------------- listeners */
    on(stepsEl, "click", (event) => {
      const button = event.target.closest("[data-goto]");
      if (!button || button.disabled) return;
      const target = button.getAttribute("data-goto");
      if (target === "generate" && !S.answers.information.name) return;
      goStage(target, { keepPreview: target === "review" });
    });

    on(pageTabs, "click", (event) => {
      const chip = event.target.closest("[data-route]");
      if (!chip) return;
      qsa("#page-tabs .chip").forEach((node) => node.classList.toggle("is-active", node === chip));
      const route = chip.getAttribute("data-route");
      qs("#stage-url").textContent = `${S.project?.slug || "preview"}.shinzora.in${route === "/" ? "" : route}`;
      /* The preview is sandboxed without allow-same-origin, so the parent
         cannot touch its location. It can, however, reload the document with a
         script inside it that does the navigating — which is exactly how the
         router behaves for the customer. */
      previewAt(route);
    });

    on(qs("#viewport-toggle"), "click", (event) => {
      const button = event.target.closest("[data-viewport]");
      if (!button) return;
      const mode = button.getAttribute("data-viewport");
      if (isApp && mode === "desktop") {
        toast({ title: "Mobile only", message: "An app is laid out for phones; the desktop frame is not offered here." }, { tone: "info" });
        return;
      }
      applyViewport(mode);
    });

    on(qs("#open-fullscreen"), "click", () => {
      const html = S.generated?.html || S.activeVersion?.files?.["index.html"];
      if (!html) return;
      openModal({
        title: `${S.project?.name || config.stageLabel} — full preview`,
        size: "xl",
        body: `<div style="height:70vh;border-radius:12px;overflow:hidden;border:1px solid var(--line)">
          <iframe sandbox="allow-scripts allow-forms" style="width:100%;height:100%;border:0;background:#fff" srcdoc="${escapeAttr(html)}"></iframe></div>`,
        footer: `<span class="dim" style="font-size:var(--fs-2xs);margin-right:auto">Sandboxed preview · scripts cannot reach your session</span>`
      });
    });

    on(versionList, "click", async (event) => {
      const show = event.target.closest("[data-version]");
      const download = event.target.closest("[data-download-version]");
      const restore = event.target.closest("[data-restore-version]");
      if (show) {
        const version = S.versions.find((row) => row.id === show.getAttribute("data-version"));
        if (version) showVersion(version);
      }
      if (download) {
        const version = S.versions.find((row) => row.id === download.getAttribute("data-download-version"));
        const html = version?.files?.["index.html"];
        if (!html) return toast({ title: "Nothing to download for that version" }, { tone: "warning" });
        const { filename, content } = singleFileDownload(S.project?.name || "site", html);
        const blob = new Blob([content], { type: "text/html;charset=utf-8" });
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = url;
        link.download = filename;
        document.body.appendChild(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 4000);
      }
      if (restore) {
        const version = S.versions.find((row) => row.id === restore.getAttribute("data-restore-version"));
        if (version) restoreVersion(version);
      }
    });

    on(qs("#publish-button"), "click", publish);
    on(qs("#github-push"), "click", async () => {
      if (!S.project || !S.activeVersion) return toast({ title: "Save a version first" }, { tone: "warning" });
      try {
        const result = await api.integrations.githubPush({
          projectId: S.project.id,
          versionId: S.activeVersion.id,
          name: S.project.name,
          files: S.activeVersion.files
        });
        toast({ title: "Pushed to GitHub", message: result?.repo || "" }, { tone: "success" });
      } catch (error) {
        toastError(normalizeError(error));
      }
    });
    on(qs("#vercel-deploy"), "click", async () => {
      if (!S.project) return;
      try {
        const result = await api.integrations.vercelDeploy({ projectId: S.project.id });
        toast({ title: "Deployment requested", message: result?.url || "Track status in Projects" }, { tone: "info" });
      } catch (error) {
        toastError(normalizeError(error));
      }
    });
    on(qs("#slug-input"), "input", (event) => {
      event.target.value = event.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "-");
    });

    applyViewport(isApp ? "mobile" : "desktop");
  };
}

/* --------------------------------------------------------------------------
   Helpers
   -------------------------------------------------------------------------- */

function unique(list) {
  return [...new Set(list)];
}

/** Is the document actually laid out for more than one screen width? */
export function checkResponsive(html) {
  const doc = String(html || "");
  const viewport = /<meta[^>]+name\s*=\s*["']viewport["'][^>]*width\s*=\s*device-width/i.test(doc);
  const mediaQueries = (doc.match(/@media[^{]*\([^)]*(max|min)-width/gi) || []).length;
  const fluidUnits = (doc.match(/(\d+(\.\d+)?)(%|vw|rem|em|fr)\b/gi) || []).length;
  const fixedWide = [...doc.matchAll(/(?:^|[;{\s])width\s*:\s*(\d{3,4})px/gi)]
    .map((match) => Number(match[1]))
    .filter((pixels) => pixels > 480);
  return {
    viewport,
    mediaQueries,
    fluidUnits,
    fixedWide: fixedWide.length,
    /* Honest verdict: a document needs a viewport plus either media queries or
       fluid sizing to survive both a 390px phone and a 1440px desktop. */
    responsive: viewport && (mediaQueries > 0 || fluidUnits > 6)
  };
}

function readAsDataUrl(file) {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => resolve("");
    reader.readAsDataURL(file);
  });
}

function escapeAttr(value = "") {
  return String(value).replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}

/* --------------------------------------------------------------------------
   Public document helpers — used by the public renderer (boot/site.js)
   -------------------------------------------------------------------------- */

/**
 * The badge shown on published sites for plans without `removeBranding`.
 * Deliberately inline-styled and dependency-free: it must render identically
 * inside the sandboxed iframe (no network, no parent stylesheet).
 */
export function brandingBadge() {
  return `<a href="https://shinzora.in/?ref=badge" target="_blank" rel="noopener"
     style="position:fixed;right:14px;bottom:14px;z-index:2147483000;display:inline-flex;align-items:center;gap:7px;
            padding:7px 12px;border-radius:999px;background:rgba(11,9,20,.82);border:1px solid rgba(168,85,247,.42);
            color:#efe9ff;font:500 11.5px/1 ui-sans-serif,system-ui,-apple-system,'Segoe UI',sans-serif;
            letter-spacing:.02em;text-decoration:none;backdrop-filter:blur(8px);box-shadow:0 6px 20px rgba(0,0,0,.35)">
     <span style="width:7px;height:7px;border-radius:2px;background:linear-gradient(135deg,#c4b5fd,#7c3aed)"></span>
     Made with Shinzora</a>`;
}

/**
 * Inline a project's JavaScript into the page that shows it.
 *
 * Generated files are authored for a bundler and end with `export default App;`
 * or start with `import`. Pasted into a classic `<script>` that single keyword is
 * a parse error, and the browser discards the *whole* file — which is how a
 * published site kept its design but lost its cart, its menu toggle and every
 * other line of behaviour, while printing one cryptic message to the console.
 *
 * So: drop the module plumbing that a standalone page has no use for, and keep
 * the code. Anything that still needs a module (a real import of another file,
 * or JSX) is left whole and marked as one, because stripping it would change
 * what the code does.
 */
function inlineScript(raw, wasModule = false) {
  const source = String(raw == null ? "" : raw);
  if (wasModule) return `<script type="module">\n${source}\n</script>`;

  /* `export default function f(){}` / `export default class C {}` — the
     declaration is what runs; only the two leading words have to go. */
  let body = source.replace(
    /^([ \t]*)export\s+default\s+(?=(?:async\s+function|function\*?|class)\b)/gm,
    "$1"
  );
  /* `export default Identifier;` names something the file already defines. */
  body = body.replace(/^[ \t]*export\s+default\s+[A-Za-z_$][\w$]*\s*;?[ \t]*$/gm, "");
  /* Any other `export default <expression>` becomes an ordinary binding. */
  body = body.replace(/^([ \t]*)export\s+default\s+/gm, "$1const __exportDefault = ");
  /* `export { a, b };` and `export * from "./x.js";` */
  body = body.replace(/^[ \t]*export\s*\{[^}]*\}\s*(?:from\s*["'][^"']+["'])?\s*;?[ \t]*$/gm, "");
  /* `export const x`, `export function f`, `export class C` … */
  body = body.replace(/^([ \t]*)export\s+(?=(?:const|let|var|function|async|class)\b)/gm, "$1");

  /* Whatever still needs a module — an import of another file, a leftover
     export, or JSX — is left exactly as written and marked as a module,
     because rewriting it would change what the code does. */
  const stillModule =
    /(^|\n)\s*(?:import\s+[\w{*"'$]|export\s)/.test(body) || /<\/?[A-Z][\w.]*[\s/>]/.test(body);
  if (stillModule) return `<script type="module">\n${source}\n</script>`;
  return `<script>\n${body}\n</script>`;
}

/**
 * Give a sandboxed page the storage API it expects.
 *
 * Previews and published sites render inside `sandbox="allow-scripts"`, which
 * deliberately withholds same-origin access — so the plain `localStorage` read
 * that every generated site performs throws a SecurityError, and with it dies
 * the cart, the drawer state and anything else the page saved. An in-memory
 * stand-in keeps the code working inside the sandbox without widening it: the
 * page still cannot reach the parent's real storage, cookies or DOM.
 *
 * Runs only when the real API is genuinely blocked, so a page outside the
 * sandbox keeps using the browser's own storage.
 */
function storageShim() {
  return `<script>
(function () {
  function memory() {
    var map = new Map();
    return {
      getItem: function (k) { return map.has(String(k)) ? map.get(String(k)) : null; },
      setItem: function (k, v) { map.set(String(k), String(v)); },
      removeItem: function (k) { map.delete(String(k)); },
      clear: function () { map.clear(); },
      key: function (i) { return Array.from(map.keys())[i] || null; },
      get length() { return map.size; }
    };
  }
  ["localStorage", "sessionStorage"].forEach(function (name) {
    var blocked = false;
    try { window[name].getItem("shinzora.probe"); } catch (error) { blocked = true; }
    if (!blocked) return;
    try { Object.defineProperty(window, name, { value: memory(), configurable: true }); } catch (error) {}
  });
})();
</script>`;
}

/**
 * Compose the document shown in the preview and on the public site.
 *
 * A single-file project already contains everything, so it is returned as-is
 * apart from the badge. Older multi-file versions (generated before single-file
 * output) are still rendered, with their local CSS and JS inlined.
 */
export function buildPreviewDocument(files, entry = "index.html", options = {}) {
  const html = files[entry] || files["index.html"] || Object.values(files).find((value) => /<html/i.test(String(value))) || "";
  let doc = html;

  doc = doc.replace(/<link[^>]+href=["']([^"']+)["'][^>]*>/gi, (match, href) => {
    const key = href.replace(/^\.?\//, "");
    if (files[key] && key.endsWith(".css")) return `<style>\n${files[key]}\n</style>`;
    return match;
  });

  doc = doc.replace(/<script([^>]*)src=["']([^"']+)["'][^>]*><\/script>/gi, (match, before, src) => {
    const key = src.replace(/^\.?\//, "");
    if (!files[key] || !key.endsWith(".js")) return match;
    return inlineScript(files[key], /type\s*=\s*["']module["']/i.test(match));
  });

  /* Sandboxed previews must not be able to navigate the tab or post a form
     anywhere. A published page is different: if the site was built with a
     working form, blocking form-action would silently break the one thing the
     customer asked for, so the caller decides. */
  const guard = options.allowForms
    ? `<meta http-equiv="Content-Security-Policy" content="base-uri 'none'">`
    : `<meta http-equiv="Content-Security-Policy" content="base-uri 'none'; form-action 'none'">`;
  /* The shim has to run before anything the page itself would execute. */
  const prefix = `${guard}${storageShim()}`;
  if (/<head[^>]*>/i.test(doc)) doc = doc.replace(/<head([^>]*)>/i, `<head$1>${prefix}`);
  else doc = `${prefix}${doc}`;

  if (options.branding) {
    const badge = brandingBadge();
    doc = /<\/body>/i.test(doc) ? doc.replace(/<\/body>/i, `${badge}</body>`) : `${doc}${badge}`;
  }

  return doc;
}

/** True when the current account's plan keeps the Shinzora badge off published sites. */
export function brandingRemovable() {
  return Boolean(plan()?.removeBranding);
}
