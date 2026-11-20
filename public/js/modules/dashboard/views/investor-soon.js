/* ==========================================================================
   Shinzora — investor Messages and Requests (phase 2 placeholder)
   These two pages are built in phase 3. Until then they say plainly what is
   not ready. They show no sample conversations and no sample pitches.
   ========================================================================== */

import { pageHead, emptyState, chip } from "../components.js";

const COPY = {
  "investor-messages": {
    title: "Messages",
    desc: "Real-time conversations with investors you are connected with, and owners who have pitched you.",
    title2: "Messaging opens in the next update",
    desc2: "Conversations will appear here once messaging is switched on. Until then, nothing is sent or stored from this page."
  },
  "investor-requests": {
    title: "Requests",
    desc: "Pitches from business owners, with the status of each one.",
    title2: "Pitches open in the next update",
    desc2: "Pitches from owners will appear here once the pitch flow is switched on. Until then, no pitches are received."
  }
};

export default async function render(root) {
  const view = currentViewId();
  const copy = COPY[view] || COPY["investor-messages"];
  root.innerHTML = `<div class="investor-view inv-page">
    ${pageHead({ title: copy.title, desc: copy.desc, badge: chip("Coming next", { tone: "neutral", iconName: "clock" }) })}
    ${emptyState({ iconName: "clock", title: copy.title2, desc: copy.desc2 })}
  </div>`;
}

function currentViewId() {
  return new URLSearchParams(location.search).get("view") || "investor-messages";
}
