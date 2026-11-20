/* ==========================================================================
   Shinzora — investor dashboard (phase 2)
   Numbers come from investor_dashboard(). Recommendations are the listed
   businesses in the investor's own preferred industries. Recent messages and
   notifications are the investor's own rows. Each block fails on its own.
   ========================================================================== */

import { qs, esc } from "../../../lib/dom.js";
import { icon } from "../../../lib/icons.js";
import { sb } from "../../../lib/supabase.js";
import { pageHead, statCard, skeletonView, setupNotice, chip, emptyState } from "../components.js";
import {
  rpc, settle, unwrap, investorUid, loadProfile, listingCard, greeting, investorName, fmtTime
} from "./investor-kit.js";

export default async function render(host) {
  host.innerHTML = skeletonView(4);
  const uid = investorUid();

  const [dash, profile, market, notes, convs] = await Promise.all([
    settle(() => rpc("investor_dashboard")),
    settle(() => loadProfile(uid)),
    settle(() => rpc("investor_marketplace")),
    settle(async () =>
      unwrap(
        await sb
          .from("notifications")
          .select("id, title, message, is_read, created_at, link")
          .eq("user_id", uid)
          .order("created_at", { ascending: false })
          .limit(5)
      )
    ),
    settle(() => rpc("my_conversations"))
  ]);

  const d = dash.value || {};
  const p = profile.value;
  const industries = p?.preferred_industries || [];
  const matches = market.ok
    ? (market.value || []).filter((b) => industries.includes(b.category)).slice(0, 3)
    : [];

  host.innerHTML = `<div class="investor-view inv-page">
    ${pageHead({
      title: "Dashboard",
      desc: `${greeting()}, ${esc(investorName())}. Here is what is happening across your investor portal.`,
      badge: chip("Investor", { tone: "violet", iconName: "briefcase" })
    })}

    ${
      profile.ok && !p
        ? `<a class="inv-banner inv-rise" href="/app/?view=investor-profile">
            ${icon("id-card", { size: 18 })}
            <span><strong>Create your investor profile</strong><span class="field-hint">Founders and investors can find you once you have a public or connections-only profile.</span></span>
            ${icon("chevron-right", { size: 16 })}
          </a>`
        : ""
    }

    <section class="inv-section" aria-labelledby="inv-opps">
      <h2 class="inv-section-title" id="inv-opps">Opportunities</h2>
      ${
        dash.ok
          ? `<div class="inv-stats">
              ${statCard({ label: "Active opportunities", value: String(d.listed_businesses ?? 0), foot: "Businesses open to investors", iconName: "target", href: "/app/?view=investor-explore" })}
              ${statCard({ label: "Open pitches", value: String(d.open_pitches ?? 0), foot: "Pitches waiting for your reply", iconName: "send", href: "/app/?view=investor-requests" })}
            </div>`
          : setupNotice(dash.error, "Opportunities")
      }
    </section>

    <section class="inv-section" aria-labelledby="inv-net">
      <h2 class="inv-section-title" id="inv-net">Investor network</h2>
      ${
        dash.ok
          ? `<div class="inv-stats">
              ${statCard({ label: "Investors open to connect", value: String(d.public_investors ?? 0), foot: "Public profiles", iconName: "users-round", href: "/app/?view=investor-network" })}
              ${statCard({ label: "My connections", value: String(d.connections ?? 0), foot: "Accepted", iconName: "users", href: "/app/?view=investor-connections" })}
              ${statCard({ label: "Requests waiting", value: String(d.pending_requests_in ?? 0), foot: d.pending_requests_in ? "Accept or decline" : "None right now", iconName: "inbox", tone: d.pending_requests_in ? "warn" : "", href: "/app/?view=investor-connections" })}
            </div>`
          : setupNotice(dash.error, "Investor network")
      }
    </section>

    <div class="inv-two">
      <section class="card inv-panel" aria-labelledby="inv-rec">
        <div class="card-head"><h2 class="card-title" id="inv-rec">${icon("sparkles", { size: 15 })} Recommended for you</h2></div>
        ${
          !market.ok
            ? setupNotice(market.error, "Recommendations")
            : !industries.length
              ? `<p class="field-hint">Add your preferred industries in <a href="/app/?view=investor-profile">Profile</a> to see businesses that fit your interests.</p>`
              : matches.length
                ? `<div class="inv-grid inv-grid-compact">${matches.map((b) => listingCard(b)).join("")}</div>`
                : `<p class="field-hint">No listed business matches your industries yet. <a href="/app/?view=investor-explore">Browse all businesses</a>.</p>`
        }
      </section>

      <section class="card inv-panel" aria-labelledby="inv-msg">
        <div class="card-head">
          <h2 class="card-title" id="inv-msg">${icon("messages-square", { size: 15 })} Recent messages</h2>
          ${convs.ok && d.unread_messages ? chip(`${d.unread_messages} unread`, { tone: "violet" }) : ""}
        </div>
        ${
          !convs.ok
            ? setupNotice(convs.error, "Messages")
            : (convs.value || []).length
              ? `<ul class="inv-list">${(convs.value || []).slice(0, 3).map(
                  (c) => `<li><a class="inv-list-row" href="/app/?view=investor-messages&conversation=${esc(c.conversation_id)}">
                      <span class="inv-avatar">${esc((c.other_name || "?").charAt(0).toUpperCase())}</span>
                      <span class="inv-list-main"><strong class="truncate">${esc(c.other_name || "Member")}</strong><span class="field-hint truncate">${esc(c.last_body || "")}</span></span>
                      <span class="field-hint">${esc(fmtTime(c.last_message_at))}</span>
                      ${c.unread_count ? `<span class="link-badge">${c.unread_count}</span>` : ""}
                    </a></li>`
                ).join("")}</ul>`
              : emptyState({ iconName: "messages-square", title: "No conversations yet", desc: "You can message investors you are connected with, and owners who have pitched you." })
        }
      </section>
    </div>

    <section class="card inv-panel" aria-labelledby="inv-notes">
      <div class="card-head">
        <h2 class="card-title" id="inv-notes">${icon("bell", { size: 15 })} Recent notifications</h2>
        <a class="btn btn-ghost btn-sm" href="/app/?view=notifications">See all</a>
      </div>
      ${
        !notes.ok
          ? setupNotice(notes.error, "Notifications")
          : (notes.value || []).length
            ? `<ul class="inv-list">${(notes.value || []).map(
                (n) => `<li><a class="inv-list-row ${n.is_read ? "" : "is-unread"}" href="${esc(n.link || "/app/?view=notifications")}">
                    <span class="inv-list-main"><strong class="truncate">${esc(n.title || "Notification")}</strong><span class="field-hint truncate">${esc(n.message || "")}</span></span>
                    <span class="field-hint">${esc(fmtTime(n.created_at))}</span>
                  </a></li>`
              ).join("")}</ul>`
            : emptyState({ iconName: "bell", title: "No notifications", desc: "Connection requests, pitches and messages show up here." })
      }
    </section>
  </div>`;
}
