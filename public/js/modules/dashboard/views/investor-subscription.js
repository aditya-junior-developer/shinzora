/* ==========================================================================
   Shinzora — investor subscription (phase 2)
   Investor accounts have no paid plan, so this page says so. It offers no
   checkout, and it invents no plan. Billing stays unavailable to investors.
   ========================================================================== */

import { pageHead, chip } from "../components.js";
import { icon } from "../../../lib/icons.js";

export default async function render(root) {
  root.innerHTML = `<div class="investor-view inv-page">
    ${pageHead({
      title: "Subscription",
      desc: "Your plan for this account.",
      badge: chip("Investor", { tone: "violet", iconName: "briefcase" })
    })}
    <section class="card card-pad-lg inv-rise inv-plan">
      <div class="inv-plan-head">
        <span class="inv-plan-icon">${icon("badge-check", { size: 20 })}</span>
        <div>
          <strong class="inv-plan-name">Investor account · Free</strong>
          <span class="field-hint">No payment is needed and none is taken.</span>
        </div>
      </div>
      <ul class="inv-plain-list">
        <li>Browse businesses that have opted in to investor visibility</li>
        <li>Express interest, connect with investors, and receive pitches</li>
        <li>Read decks that founders share with you</li>
        <li>Message people you are connected with, or who have pitched you</li>
      </ul>
      <p class="field-hint inv-note">Investor accounts do not use AI credits or the paid business plans. If that changes, this page will say so before anything is charged.</p>
    </section>
  </div>`;
}
