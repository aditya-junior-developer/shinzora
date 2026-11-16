/* ==========================================================================
   Business summary (brief 2 of 16 Nov) — pure checks, no network
     - the summary reads only the sections the owner ticks, and refuses none
     - it is free: no charge is taken for it
     - the PowerPoint file is a real zip with one slide per summary slide
   ========================================================================== */

import { readFileSync } from "node:fs";
import { buildDeckPptx } from "../supabase/functions/_shared/deck-pptx.js";

let pass = 0;
let fail = 0;
const check = (name, cond, extra = "") =>
  cond ? (pass++, console.log(`  ✓ ${name}`)) : (fail++, console.log(`  ✗ ${name}${extra ? ` — ${extra}` : ""}`));

const deck = readFileSync("supabase/functions/deck/index.ts", "utf8");
const summaryBody = deck.slice(deck.indexOf("async function summary("), deck.indexOf("async function summary(") + 3500);

console.log("summary: ticked parts only");
check("the summary requires at least one ticked part", /requested\.length/.test(summaryBody) && /invalid_input/.test(summaryBody));
check("the summary keeps only allowed sections", /filter\(\(s\) => SECTIONS\.includes\(s\)\)/.test(summaryBody));
check("the snapshot is read with the ticked sections, not all of them", /p_sections: requested/.test(summaryBody) && !/p_sections: SECTIONS/.test(summaryBody));
check("progress is not read unless ticked", !/onboarding_progress/.test(summaryBody));
check("the prompt carries only the ticked sections", /JSON\.stringify\(\{ sections \}\)/.test(summaryBody));

console.log("summary: free");
check("the summary takes no payment", !/payments|payment_id|amount_paise|paise/.test(summaryBody));

console.log("PowerPoint file");
const bytes = buildDeckPptx({
  title: "Test business summary",
  slides: [
    { title: "Overview", bullets: ["Two orders this week", "Stock is steady"] },
    { title: "Next steps", bullets: ["Add a product photo"] }
  ]
});
const text = Buffer.from(bytes).toString("latin1");
check("the file starts as a zip", bytes[0] === 0x50 && bytes[1] === 0x4b);
check("it holds one slide part per slide", /ppt\/slides\/slide1\.xml/.test(text) && /ppt\/slides\/slide2\.xml/.test(text) && !/ppt\/slides\/slide3\.xml/.test(text));
check("the slide text is in the file", text.includes("Two orders this week") && text.includes("Next steps"));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
