/* The words a customer reads for every request and build state. A status that
   falls through to a title-cased guess reads like a bug in the product. */
import { statusLabel, statusTone } from "../public/js/lib/format.js";

let pass = 0, fail = 0;
const check = (n, c, d = "") => (c ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${d}`)));

const cases = [
  ["draft", "Draft"],
  ["submitted", "Submitted"],
  ["under_review", "Under review"],
  ["more_information_required", "More information required"],
  ["approved", "Approved"],
  ["rejected", "Rejected"],
  ["in_progress", "In progress"],
  ["completed", "Completed"],
  ["queued", "Queued"],
  ["awaiting_toolchain", "Awaiting toolchain"],
  ["built", "Built"],
  ["expired", "Expired"],
  ["revoked", "Revoked"]
];
for (const [status, label] of cases) check(`'${status}' reads as a real label`, statusLabel(status) === label, statusLabel(status));

check("approval looks positive", statusTone("approved") === "ok");
check("submission is still waiting", statusTone("submitted") === "warn");
check("more information is a warning, not a failure", statusTone("more_information_required") === "warn");
check("rejection is a failure", statusTone("rejected") === "danger");
check("completion looks positive", statusTone("completed") === "ok");
check("a built package looks positive", statusTone("built") === "ok");
check("an expired artifact is a failure", statusTone("expired") === "danger");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
