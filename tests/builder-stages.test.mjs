/* ==========================================================================
   The five stages and the progress bar
   --------------------------------------------------------------------------
   A progress bar that is not tied to real work is a lie with a percentage on
   it. These tests pin the arithmetic: the number comes from tasks that
   reported completion, never from elapsed time, it never passes a stage's
   weight, and it only reaches 100 when every stage is finished.
   ========================================================================== */

import {
  stageWeights,
  computeProgress,
  stagesFor,
  validateStage,
  completedStagesFor,
  nextStage,
  nextTask,
  APP_TARGETS,
  targetsForSlots,
  platformsIn,
  GENERATION_TASKS,
  researchUsable
} from "../public/js/modules/dashboard/builder/stages.js";

let pass = 0;
let fail = 0;
const check = (name, cond, extra = "") =>
  cond ? (pass++, console.log(`  ✓ ${name}`)) : (fail++, console.log(`  ✗ ${name} ${extra}`));

console.log("the five stages exist, in order");
for (const kind of ["website", "app"]) {
  const stages = stagesFor(kind);
  check(`${kind}: exactly five stages`, stages.length === 5, String(stages.length));
  check(`${kind}: they are brief, information, build, preview, save`,
    stages.map((s) => s.id).join(",") === "brief,information,generate,review,save",
    stages.map((s) => s.id).join(","));
  check(`${kind}: they are numbered 1–5`, stages.map((s) => s.number).join(",") === "1,2,3,4,5");
  check(`${kind}: the first two stages collect fields`, stages[0].fields.length > 0 && stages[1].fields.length > 0);
}

const site = stagesFor("website");
const app = stagesFor("app");
check("the website brief asks about the business", site[0].fields.map((f) => f.id).join(",") === "purpose,industry,audience,design,references");
check("the website information stage asks for pages and assets",
  ["pages", "logo", "images", "colours", "contact"].every((id) => site[1].fields.some((f) => f.id === id)));
check("the app information stage asks which platform", app[1].fields.some((f) => f.id === "platform"));
check("the app brief is about the app, not a website", /app/i.test(app[0].fields[0].label));
check("the build stage carries the seven tasks", site[2].tasks.length === 7);

console.log("\nprogress comes from completed tasks");
const weights = stageWeights();
const total = Object.values(weights).reduce((a, b) => a + b, 0);
check("the weights cover every stage", Object.keys(weights).every((id) => ["brief", "information", "generate", "review", "save"].includes(id)));
check("nothing done is 0%", computeProgress({ stage: "brief" }).percent === 0);

const briefDone = computeProgress({ stage: "information", completedStages: ["brief"] });
check("finishing the brief moves the bar", briefDone.percent === Math.round((weights.brief / total) * 100), String(briefDone.percent));
check("and it does not jump to the end", briefDone.percent < 30, String(briefDone.percent));

const infoDone = computeProgress({ stage: "generate", completedStages: ["brief", "information"] });
check("information adds its share", infoDone.percent === Math.round(((weights.brief + weights.information) / total) * 100));

/* The middle of the build stage: some tasks done, some not. */
const half = computeProgress({
  stage: "generate",
  completedStages: ["brief", "information"],
  completedTasks: GENERATION_TASKS.slice(0, 4).map((t) => t.id)
});
check("the build stage reports its own percentage", half.stagePercent === 57, String(half.stagePercent));
check("four of seven tasks is more than the stage start", half.percent > infoDone.percent);
check("and less than the stage end",
  half.percent < computeProgress({ stage: "review", completedStages: ["brief", "information", "generate"] }).percent);

const allTasks = computeProgress({
  stage: "generate",
  completedStages: ["brief", "information"],
  completedTasks: GENERATION_TASKS.map((t) => t.id)
});
check("all tasks done is the whole build weight",
  allTasks.percent === Math.round(((weights.brief + weights.information + weights.generate) / total) * 100),
  String(allTasks.percent));

const reviewDone = computeProgress({ stage: "save", completedStages: ["brief", "information", "generate", "review"] });
check("preview adds its share", reviewDone.percent === 93, String(reviewDone.percent));

const finished = computeProgress({ stage: "save", completedStages: ["brief", "information", "generate", "review", "save"] });
check("only a finished run reaches 100%", finished.percent === 100);
check("and it is reported as done", finished.done === true);

check("progress never exceeds 100",
  computeProgress({ stage: "generate", completedStages: ["brief", "information", "generate", "review", "save"], completedTasks: GENERATION_TASKS.map((t) => t.id) }).percent === 100);
check("an unknown stage falls back to the first instead of crashing", computeProgress({ stage: "nonsense" }).stageId === "brief");
check("a stage that has not reported is not credited",
  computeProgress({ stage: "review", completedStages: ["brief"] }).percent === Math.round((weights.brief / total) * 100));

console.log("\ntask ordering");
check("the next task is the first unfinished one", nextTask(["read_brief"]).id === "plan_structure");
check("when everything is done there is no next task", nextTask(GENERATION_TASKS.map((t) => t.id)) === null);
check("the stage after brief is information", nextStage("brief") === "information");
check("the stage after save is nothing", nextStage("save") === null);

console.log("\ngating a stage");
const briefStage = site[0];
const problems = validateStage(briefStage, { purpose: "too short", industry: "", audience: "" });
check("empty required fields are named", problems.length === 3, JSON.stringify(problems.map((p) => p.field)));
check("a short purpose is refused with its length", problems.some((p) => p.field === "purpose" && p.message.includes("20")));
const okBrief = validateStage(briefStage, {
  purpose: "A calm editorial website that lets brides enquire about a wedding shoot.",
  industry: "Photography",
  audience: "Brides in Delhi"
});
check("a complete brief passes", okBrief.length === 0, JSON.stringify(okBrief));
check("optional fields are not demanded", okBrief.length === 0 && briefStage.fields.some((f) => !f.required));

const infoStage = site[1];
check("a chips field needs at least one choice",
  validateStage(infoStage, { name: "Aster", description: "Studio", contact: "hi", pages: [] }).some((p) => p.field === "pages"));
check("a platform field is required for an app",
  validateStage(app[1], { name: "Clinic", description: "Book slots", contact: "hi", screens: ["Home"] }).some((p) => p.field === "platform"));

check("completedStagesFor only credits stages that are finished",
  completedStagesFor("website", { brief: { purpose: "A calm editorial website for brides to enquire and book a shoot.", industry: "Photo", audience: "Brides" } }).join(",") === "brief");

console.log("\napp targets are technically correct");
const byTarget = Object.fromEntries(APP_TARGETS.map((t) => [t.target, t.platform]));
check("APK is Android", byTarget.apk === "android");
check("AAB is Android, never iOS", byTarget.aab === "android");
check("IPA is iOS, never Android", byTarget.ipa === "ios");
check("there is no AAB-for-iOS option", !APP_TARGETS.some((t) => t.target === "aab" && t.platform === "ios"));
check("every target states its file extension", APP_TARGETS.every((t) => t.extension.startsWith(".")));
check("the IPA option says what Apple credentials it needs", /Apple Developer/i.test(APP_TARGETS.find((t) => t.target === "ipa").note));

console.log("\nplan entitlement");
const free = targetsForSlots(1);
const enterprise = targetsForSlots(2);
check("one platform means Android only", platformsIn(free).join(",") === "android");
check("one platform still offers both Android formats", free.filter((t) => t.platform === "android").length === 2);
check("two platforms means Android and iOS", platformsIn(enterprise).sort().join(",") === "android,ios");
check("an unknown entitlement is treated as one, not two", platformsIn(targetsForSlots(0)).join(",") === "android");

console.log("\nresearch is only used when it can be traced");
check("research with real sources is usable",
  researchUsable({ summary: "Studios lead with a portfolio.", sources: [{ title: "A", url: "https://example.com/a" }] }) !== null);
check("research with no sources is refused",
  researchUsable({ summary: "Trust me.", sources: [] }) === null);
check("a source without a URL is not a source",
  researchUsable({ summary: "x", sources: [{ title: "no url" }] }) === null);
check("a non-http source is refused",
  researchUsable({ summary: "x", sources: [{ url: "javascript:alert(1)" }] }) === null);
check("research with no summary is refused",
  researchUsable({ sources: [{ url: "https://example.com" }] }) === null);
check("null research is handled", researchUsable(null) === null);
check("the usable shape keeps the sources",
  researchUsable({ summary: "s", patterns: ["p"], sources: [{ title: "t", url: "https://e.com" }] }).sources.length === 1);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);

/* --------------------------------------------------------------- research */
/* Appended so the file keeps one shape: the research rules are part of the
   stage model because stage 2 is where they are applied. */
