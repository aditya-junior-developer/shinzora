/* ==========================================================================
   Shinzora — Overview
   The first screen after sign in: what is happening in the business right now,
   built entirely from live rows (no invented metrics).
   ========================================================================== */

import { qs, esc } from "../../../lib/dom.js";
import { icon } from "../../../lib/icons.js";
import { money, timeAgo, date, statusLabel, compact } from "../../../lib/format.js";
import { state, plan, aiCredits, hasCompletedOnboarding, displayName } from "../../../lib/store.js";
import { overview, isSchemaMissing } from "../data.js";
import { pageHead, statCard, statusBadge, emptyState, setupNotice, dataTable, skeletonView } from "../components.js";

const ACTION_LABELS = {
  signed_in: "Signed in",
  onboarding_completed: "Onboarding completed",
  project_created: "Project created",
  project_generated: "Project generated",
  project_published: "Project published",
  payment_submitted: "Payment submitted",
  domain_requested: "Domain requested",
  support_ticket_created: "Support ticket opened",
  campaign_created: "Campaign created",
  product_created: "Product added",
  order_updated: "Order updated"
};

export default async function render(root) {
  root.innerHTML = `${skeletonView(5)}`;

  let data;
  try {
    data = await overview();
  } catch (error) {
    const missing = isSchemaMissing(error);
    root.innerHTML = `${pageHead({
      title: "Overview",
      desc: "Your business at a glance."
    })}${setupNotice(error, "The overview")}`;
    if (!missing) console.error(error);
    return;
  }

  const credits = aiCredits();
  const creditPercent = Math.min(100, Math.round((credits.used / Math.max(1, credits.limit)) * 100));
  const firstName = (state.profile?.full_name || displayName()).split(" ")[0];
  const hour = new Date().getHours();
  const greeting = hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening";

  const quickActions = [
    { label: "Generate a website", desc: "Describe it, get a working site", href: "/app/?view=website-builder", icon: "panels-top-left" },
    { label: "Build an application", desc: "Define features and preview", href: "/app/?view=app-builder", icon: "blocks" },
    { label: "Ask the assistant", desc: "Strategy, copy, analysis", href: "/app/?view=assistant", icon: "sparkles" },
    { label: "Add a product", desc: "Stock and pricing live", href: "/app/?view=inventory", icon: "boxes" }
  ];

  root.innerHTML = `
    ${pageHead({
      title: `${greeting}, ${firstName}`,
      desc: hasCompletedOnboarding()
        ? `${state.business?.name || "Your business"} · ${plan().name} plan · ${credits.used} of ${credits.limit} AI generations used this month`
        : "Finish setting up your business profile so the AI has context to work with.",
      actions: `<a class="btn btn-primary btn-sm" href="/app/?view=website-builder">${icon("sparkles", { size: 14 })}Generate a website</a>
                <a class="btn btn-secondary btn-sm" href="/app/?view=assistant">${icon("message-square", { size: 14 })}Ask the assistant</a>`
    })}

    <div class="grid-4" style="margin-bottom:var(--s-4)">
      ${statCard({
        label: "Revenue (last 50 orders)",
        value: money(data.revenue),
        iconName: "indian-rupee",
        foot: `<span class="trend-flat">${icon("package", { size: 12 })}${data.orderCount} order${data.orderCount === 1 ? "" : "s"} recorded</span>`
      })}
      ${statCard({
        label: "Customers",
        value: compact(data.customerCount),
        iconName: "users",
        foot: `<span class="trend-flat">${icon("user-plus", { size: 12 })}From your store records</span>`
      })}
      ${statCard({
        label: "Products",
        value: compact(data.productCount),
        iconName: "boxes",
        foot:
          data.lowStock.length > 0
            ? `<span class="trend-down">${icon("triangle-alert", { size: 12 })}${data.lowStock.length} low on stock</span>`
            : `<span class="trend-flat">${icon("circle-check", { size: 12 })}Stock levels healthy</span>`
      })}
      ${statCard({
        label: "Open support",
        value: String(data.openTickets),
        iconName: "life-buoy",
        foot:
          data.openTickets > 0
            ? `<a href="/app/?view=support" class="trend-flat">${icon("arrow-right", { size: 12 })}Review tickets</a>`
            : `<span class="trend-flat">${icon("circle-check", { size: 12 })}Nothing waiting</span>`
      })}
    </div>

    <div class="grid-main-side">
      <div class="stack gap-4">
        <div class="card">
          <div class="card-head">
            <div>
              <div class="card-title">Recent projects</div>
              <div class="card-sub">Websites, applications and stores you have generated</div>
            </div>
            <a class="btn btn-ghost btn-sm" href="/app/?view=projects">All projects ${icon("arrow-right", { size: 13 })}</a>
          </div>
          ${
            data.projects.length
              ? `<div class="table-wrap"><table class="table">
                  <thead><tr><th>Project</th><th>Type</th><th>Status</th><th>Updated</th><th></th></tr></thead>
                  <tbody>${data.projects
                    .map(
                      (project) => `<tr>
                        <td><div class="cell-strong">${esc(project.name)}</div>${
                        project.slug ? `<div class="cell-sub mono">${esc(project.slug)}</div>` : ""
                      }</td>
                        <td>${esc(project.type)}</td>
                        <td>${statusBadge(project.status)}</td>
                        <td class="dim">${esc(timeAgo(project.updated_at))}</td>
                        <td class="cell-actions"><a class="btn btn-ghost btn-sm" href="/app/?view=${
                          project.type === "app" ? "app-builder" : "website-builder"
                        }&id=${esc(project.id)}">Open</a></td>
                      </tr>`
                    )
                    .join("")}</tbody>
                </table></div>`
              : emptyState({
                  icon: "folder-git-2",
                  title: "No projects yet",
                  desc: "Describe what you want to build and the AI will generate a first version you can revise.",
                  action: `<a class="btn btn-primary btn-sm" href="/app/?view=website-builder">${icon("sparkles", { size: 14 })}Create your first project</a>`
                })
          }
        </div>

        <div class="grid-2">
          <div class="card">
            <div class="card-head">
              <div class="card-title">Recent orders</div>
              <a class="btn btn-ghost btn-sm" href="/app/?view=orders">View all</a>
            </div>
            ${dataTable({
              columns: [
                { key: "order_number", label: "Order", render: (row) => `<span class="cell-strong">${esc(row.order_number || "—")}</span>` },
                { key: "customer_name", label: "Customer" },
                { key: "total_amount", label: "Total", render: (row) => esc(money(row.total_amount, row.currency || "INR")) },
                { key: "status", label: "Status", render: (row) => statusBadge(row.status) }
              ],
              rows: data.orders.slice(0, 5),
              empty: "Orders placed through your store appear here."
            })}
          </div>

          <div class="card">
            <div class="card-head">
              <div class="card-title">Activity</div>
              <a class="btn btn-ghost btn-sm" href="/app/?view=analytics">Insights</a>
            </div>
            <div class="card-body">
              ${
                data.activity.length
                  ? `<div class="timeline">${data.activity
                      .slice(0, 6)
                      .map(
                        (row) => `<div class="timeline-item is-new">
                          ${esc(ACTION_LABELS[row.action] || row.action)}
                          <div class="timeline-time">${esc(timeAgo(row.created_at))}${row.entity_type ? ` · ${esc(row.entity_type)}` : ""}</div>
                        </div>`
                      )
                      .join("")}</div>`
                  : `<p class="muted" style="font-size:var(--fs-xs)">Your activity log will appear here once you start creating.</p>`
              }
            </div>
          </div>
        </div>

        <div class="card">
          <div class="card-head"><div class="card-title">Quick actions</div></div>
          <div class="card-body">
            <div class="grid-4">
              ${quickActions
                .map(
                  (action) => `<a class="choice" href="${esc(action.href)}" style="text-decoration:none">
                    <span class="choice-mark">${icon(action.icon, { size: 17 })}</span>
                    <span><span class="choice-title">${esc(action.label)}</span><span class="choice-desc">${esc(action.desc)}</span></span>
                  </a>`
                )
                .join("")}
            </div>
          </div>
        </div>
      </div>

      <div class="stack gap-4">
        <div class="card">
          <div class="card-head">
            <div class="card-title">AI usage</div>
            <span class="badge badge-violet">${esc(plan().name)}</span>
          </div>
          <div class="card-body">
            <div class="row between" style="margin-bottom:8px">
              <span class="muted" style="font-size:var(--fs-xs)">${credits.used} used</span>
              <span class="dim" style="font-size:var(--fs-xs)">${credits.limit} included</span>
            </div>
            <div class="progress"><span style="width:${creditPercent}%"></span></div>
            <p class="dim" style="font-size:var(--fs-2xs);margin-top:10px;line-height:1.6">
              ${creditPercent}% of this month's generations used. Counters reset on the first day of each month.
            </p>
            ${
              creditPercent > 85
                ? `<a class="btn btn-primary btn-sm btn-block" style="margin-top:10px" href="/app/?view=billing">Upgrade for more</a>`
                : `<a class="btn btn-secondary btn-sm btn-block" style="margin-top:10px" href="/app/?view=billing">Manage plan</a>`
            }
          </div>
        </div>

        <div class="card">
          <div class="card-head"><div class="card-title">Notifications</div><a class="btn btn-ghost btn-sm" href="/app/?view=notifications">All</a></div>
          <div class="card-body">
            ${
              data.notifications.length
                ? `<div class="stack gap-3">${data.notifications
                    .slice(0, 4)
                    .map(
                      (row) => `<div class="row gap-3" style="align-items:flex-start">
                        <span class="notif-icon">${icon("bell", { size: 13 })}</span>
                        <div class="grow">
                          <div style="font-size:var(--fs-xs);color:var(--text);font-weight:550">${esc(row.title)}</div>
                          <div class="dim" style="font-size:var(--fs-2xs);margin-top:2px">${esc(timeAgo(row.created_at))}</div>
                        </div>
                      </div>`
                    )
                    .join("")}</div>`
                : `<p class="muted" style="font-size:var(--fs-xs)">Nothing yet. We notify you about generation, deployments and payments.</p>`
            }
          </div>
        </div>

        ${
          data.pendingPayments.length
            ? `<div class="card" style="border-color:rgba(251,191,36,.3)">
                <div class="card-head"><div class="card-title">Payment awaiting verification</div></div>
                <div class="card-body">
                  <p style="font-size:var(--fs-xs);color:var(--text-2);line-height:1.6">
                    ${data.pendingPayments.length} payment${data.pendingPayments.length === 1 ? "" : "s"} submitted and waiting for administrator approval.
                    Your payment is awaiting verification — we will notify you once it is confirmed.
                  </p>
                  <a class="btn btn-secondary btn-sm btn-block" style="margin-top:10px" href="/app/?view=billing">View billing</a>
                </div>
              </div>`
            : ""
        }

        <div class="card">
          <div class="card-head"><div class="card-title">Workspace</div></div>
          <div class="card-body">
            <dl>
              <div class="kv"><dt>Business</dt><dd>${esc(state.business?.name || "Not set")}</dd></div>
              <div class="kv"><dt>Category</dt><dd>${esc(state.business?.category || "—")}</dd></div>
              <div class="kv"><dt>Plan</dt><dd>${esc(plan().name)}</dd></div>
              <div class="kv"><dt>Member since</dt><dd>${esc(date(state.profile?.created_at))}</dd></div>
            </dl>
            <a class="btn btn-secondary btn-sm btn-block" style="margin-top:12px" href="/app/?view=settings">${icon("settings", { size: 14 })}Open settings</a>
          </div>
        </div>
      </div>
    </div>`;
}
