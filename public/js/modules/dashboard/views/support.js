/* ==========================================================================
   Shinzora — Customer Support
   Support tickets with a threaded conversation, plus AI-drafted replies that a
   human reviews before anything is sent.
   ========================================================================== */

import { qs, qsa, esc, on, delegate, safeSet } from "../../../lib/dom.js";
import { icon } from "../../../lib/icons.js";
import { timeAgo, dateTime } from "../../../lib/format.js";
import { state } from "../../../lib/store.js";
import { sb, normalizeError } from "../../../lib/supabase.js";
import { actionPendingDeploy, api, runtimeConfig } from "../../../lib/api.js";
import { tickets as fetchTickets } from "../data.js";
import { pageHead, setupNotice, emptyState, skeletonView, statusBadge, statCard } from "../components.js";
import { formDialog, openModal, confirmDialog } from "../../../ui/modal.js";
import { toast, toastError } from "../../../ui/toast.js";

let rows = [];
let filter = "all";

const PRIORITIES = ["low", "normal", "high", "urgent"];

export default async function render(root) {
  root.innerHTML = skeletonView(3);
  const runtime = await runtimeConfig();
  const aiReady = Boolean(runtime?.ai?.configured);

  try {
    const { data } = await fetchTickets();
    rows = data;
  } catch (error) {
    root.innerHTML = `${pageHead({ title: "Customer Support" })}${setupNotice(error, "Support")}`;
    return;
  }

  const open = rows.filter((row) => row.status === "open");
  const resolved = rows.filter((row) => ["resolved", "closed"].includes(row.status));

  root.innerHTML = `
    ${pageHead({
      title: "Customer Support",
      desc: "Tickets from customers and messages to the Shinzora team, in one queue. AI drafts replies; you approve them.",
      actions: `<button class="btn btn-secondary btn-sm" id="auto-sweep" ${aiReady ? "" : "disabled"}>${icon("repeat", { size: 14 })}Answer waiting messages</button>
        <button class="btn btn-primary btn-sm" id="new-ticket">${icon("plus", { size: 14 })}New ticket</button>`
    })}

    <div class="grid-4" style="margin-bottom:var(--s-4)">
      ${statCard({ label: "Open", value: String(open.length), iconName: "message-square", foot: "Needs a reply" })}
      ${statCard({ label: "Resolved", value: String(resolved.length), iconName: "circle-check", foot: "Closed or resolved" })}
      ${statCard({ label: "Total", value: String(rows.length), iconName: "life-buoy", foot: "All time" })}
      ${statCard({ label: "AI drafting", value: aiReady ? "Ready" : "Not configured", iconName: "sparkles", foot: aiReady ? "Server-side Gemini" : "Set GEMINI_API_KEY" })}
    </div>

    <div class="toolbar">
      <div class="segmented" id="support-filter">
        <button data-status="all" aria-pressed="true">All</button>
        <button data-status="open" aria-pressed="false">Open</button>
        <button data-status="resolved" aria-pressed="false">Resolved</button>
        <button data-status="closed" aria-pressed="false">Closed</button>
      </div>
      <div class="toolbar-spacer"></div>
      <span class="dim" style="font-size:var(--fs-xs)" id="ticket-count"></span>
    </div>

    <div class="grid-main-side">
      <div class="card"><div class="card-body" style="padding:0" id="ticket-list"></div></div>
      <div class="stack gap-4">
        <div class="card">
          <div class="card-head"><div class="card-title">How this works</div></div>
          <div class="card-body">
            <ol class="pay-steps">
              <li class="pay-step">A customer writes in — from your storefront, or you create the ticket manually.</li>
              <li class="pay-step">Ask the assistant for a draft reply. It sees the ticket and your business context.</li>
              <li class="pay-step">Edit the draft, send it, and set the ticket to resolved. Nothing is auto-sent.</li>
            </ol>
            <div class="alert alert-info" style="margin-top:var(--s-4);font-size:var(--fs-2xs)">
              ${icon("shield-check", { size: 14 })}
              <span>Replies are stored in your database. Shinzora never emails customers on your behalf without your action.</span>
            </div>
          </div>
        </div>
        <div class="card">
          <div class="card-head"><div class="card-title">Need Shinzora help?</div></div>
          <div class="card-body">
            <p class="muted" style="font-size:var(--fs-xs);line-height:1.65">
              Tickets of type “Shinzora support” are routed to the platform team and answered by a person.
            </p>
            <button class="btn btn-secondary btn-sm btn-block" style="margin-top:10px" id="contact-team">
              ${icon("headphones", { size: 14 })}Message the platform team
            </button>
          </div>
        </div>
      </div>
    </div>`;

  paint();

  on(qs("#support-filter"), "click", (event) => {
    const button = event.target.closest("[data-status]");
    if (!button) return;
    filter = button.getAttribute("data-status");
    qsa("#support-filter button").forEach((node) => node.setAttribute("aria-pressed", String(node === button)));
    paint();
  });

  on(qs("#new-ticket"), "click", () => newTicket("customer"));

  /* Automatic replies only ever run for tickets the owner switched on. The
     server re-checks that, refuses escalated tickets, and only answers when the
     customer spoke last — this loop is a convenience, not the security model. */
  on(qs("#auto-sweep"), "click", () => sweepAutoReplies());

  async function sweepAutoReplies() {
    const button = qs("#auto-sweep");
    const candidates = rows.filter(
      (row) =>
        row.auto_reply &&
        !row.escalated_at &&
        !["closed", "resolved"].includes(row.status) &&
        row.ticket_type !== "platform"
    );
    if (!candidates.length) {
      toast(
        {
          title: "Nothing waiting",
          message: "No open customer ticket has automatic replies switched on. Open a ticket and turn it on to use this."
        },
        { tone: "info", duration: 4200 }
      );
      return;
    }

    button.disabled = true;
    let answered = 0;
    let needsHuman = 0;
    try {
      for (const row of candidates) {
        try {
          const result = await api.ai.supportAutoReply({ ticketId: row.id });
          if (result?.reply) answered += 1;
          if (result?.needsOwner) needsHuman += 1;
        } catch (error) {
          if (actionPendingDeploy(error)) {
            toast(
              {
                title: "Not deployed yet",
                message: "Automatic replies need the updated ai Edge Function. The switch is saved; nothing was sent."
              },
              { tone: "warning", duration: 5200 }
            );
            return;
          }
          if (normalizeError(error).code !== "auto_reply_off") console.warn(error);
        }
      }
      const { data } = await fetchTickets();
      rows = data;
      paint();
      toast({
        title: answered ? `${answered} repl${answered === 1 ? "y" : "ies"} sent` : "Nothing to answer",
        message: needsHuman
          ? `${needsHuman} needed a human decision — auto-reply was switched off on ${needsHuman === 1 ? "it" : "them"}.`
          : answered
            ? "Open a ticket to review or edit what was sent."
            : "Every automatic ticket is already answered."
      }, { tone: answered ? "success" : "info", duration: 4200 });
    } finally {
      button.disabled = false;
    }
  }
  on(qs("#contact-team"), "click", () => newTicket("platform"));

  /* Arriving from a service request: open the compose dialog straight away and
     drop the parameter so a refresh does not reopen it. */
  const handedOver = new URLSearchParams(location.search).get("subject");
  if (handedOver) {
    history.replaceState({}, "", "/app/?view=support");
    newTicket("platform");
  }

  delegate(qs("#ticket-list"), "click", "[data-open]", (_event, node) => {
    const row = rows.find((item) => item.id === node.getAttribute("data-open"));
    if (row) thread(row);
  });

  delegate(qs("#ticket-list"), "click", "[data-resolve]", async (event, node) => {
    event.stopPropagation();
    const row = rows.find((item) => item.id === node.getAttribute("data-resolve"));
    const ok = await confirmDialog({ title: "Mark as resolved?", desc: row?.subject, confirmLabel: "Resolve" });
    if (!ok) return;
    await setStatus(row, "resolved");
  });

  function paint() {
    const visible = rows.filter((row) => {
      if (filter === "all") return true;
      if (filter === "resolved") return ["resolved", "closed"].includes(row.status);
      return row.status === filter;
    });
    qs("#ticket-count").textContent = `${visible.length} tickets`;

    safeSet("#ticket-list", visible.length
      ? `<div class="table-wrap"><table class="table">
          <thead><tr><th>Subject</th><th>Type</th><th>Priority</th><th>Status</th><th>Updated</th><th></th></tr></thead>
          <tbody>${visible
            .map(
              (row) => `<tr data-open="${esc(row.id)}" style="cursor:pointer">
                <td>
                  <div class="cell-strong">${esc(row.subject)}
                    ${row.escalated_at ? `<span class="badge badge-warn">Escalated</span>` : ""}
                    ${row.auto_reply ? `<span class="badge badge-neutral">Auto-reply</span>` : ""}
                  </div>
                  <div class="cell-sub clamp-2" style="max-width:420px">${esc((row.message || "").slice(0, 120))}</div>
                </td>
                <td>${esc(row.ticket_type === "platform" ? "Shinzora" : "Customer")}</td>
                <td><span class="badge badge-${row.priority === "urgent" ? "danger" : row.priority === "high" ? "warn" : "neutral"}">${esc(row.priority || "normal")}</span></td>
                <td>${statusBadge(row.status)}</td>
                <td class="dim">${esc(timeAgo(row.updated_at || row.created_at))}</td>
                <td class="cell-actions">
                  ${row.status === "open" ? `<button class="btn btn-ghost btn-sm" data-resolve="${esc(row.id)}">Resolve</button>` : ""}
                </td>
              </tr>`
            )
            .join("")}</tbody>
        </table></div>`
      : emptyState({
          icon: "life-buoy",
          title: rows.length ? "No tickets in this view" : "No support tickets yet",
          desc: rows.length ? "Try another filter." : "Create a ticket to start a conversation, or let customers reach you through your storefront.",
          action: rows.length ? "" : `<button class="btn btn-primary btn-sm" id="empty-ticket">${icon("plus", { size: 14 })}New ticket</button>`
        }));
    qs("#empty-ticket")?.addEventListener("click", () => newTicket("customer"));
  }

  async function setStatus(row, status) {
    try {
      const { error } = await sb.from("support_tickets").update({ status, updated_at: new Date().toISOString() }).eq("id", row.id);
      if (error) throw normalizeError(error);
      row.status = status;
      paint();
      toast({ title: `Ticket ${status}` }, { tone: "success" });
    } catch (error) {
      toastError(normalizeError(error));
    }
  }

  /* Everything this customer has ever raised, so an owner is not answering the
     same person twice without knowing it. The server scopes it to this business. */
  async function showHistory(ticket) {
    const email = ticket.customer_email_used || ticket.customer_email || "";
    if (!email) {
      toast({ title: "No customer email on this ticket", message: "History is matched by the customer's email address." }, { tone: "warning" });
      return;
    }
    openModal({
      title: `History — ${email}`,
      desc: "Every ticket from this customer, newest first.",
      size: "lg",
      body: `<div id="history-body"><span class="dim" style="font-size:var(--fs-xs)">Loading…</span></div>`,
      footer: `<button class="btn btn-ghost" data-modal-close>Close</button>`,
      onMount: async (dialog) => {
        const box = qs("#history-body", dialog);
        try {
          const { data, error } = await sb.rpc("support_customer_history", { p_email: email, p_customer: null });
          if (error) throw normalizeError(error);
          const entries = Array.isArray(data) ? data : [];
          box.innerHTML = entries.length
            ? entries
                .map(
                  (entry) => `<div class="card" style="padding:var(--s-3);margin-bottom:var(--s-2)">
                    <div class="row between gap-2" style="align-items:baseline">
                      <strong style="font-size:var(--fs-sm)">${esc(entry.subject)}</strong>
                      <span class="dim" style="font-size:var(--fs-2xs)">${esc(timeAgo(entry.openedAt))}</span>
                    </div>
                    <div class="row gap-2 wrap" style="margin-top:6px">
                      ${statusBadge(entry.status)}
                      ${entry.escalatedAt ? `<span class="badge badge-warn">Escalated</span>` : ""}
                      <span class="badge badge-neutral">${(entry.replies || []).length} repl${(entry.replies || []).length === 1 ? "y" : "ies"}</span>
                    </div>
                    ${
                      (entry.replies || []).length
                        ? `<div class="stack gap-1" style="margin-top:8px">${entry.replies
                            .slice(-3)
                            .map(
                              (reply) => `<div style="font-size:var(--fs-2xs);color:var(--text-2)">
                                <strong>${esc(reply.role === "admin" ? "Shinzora" : reply.role === "system" ? "System" : "You")}:</strong>
                                ${esc(String(reply.body || "").slice(0, 160))}
                              </div>`
                            )
                            .join("")}</div>`
                        : ""
                    }
                  </div>`
                )
                .join("")
            : `<p class="muted" style="font-size:var(--fs-sm)">No other tickets for this customer.</p>`;
        } catch (error) {
          box.innerHTML = `<p class="muted" style="font-size:var(--fs-sm)">${esc(normalizeError(error).message)}</p>`;
        }
      }
    });
  }

  async function thread(ticket) {
    let replies = [];
    try {
      const { data } = await sb
        .from("support_replies")
        .select("*")
        .eq("ticket_id", ticket.id)
        .order("created_at", { ascending: true });
      replies = data || [];
    } catch {
      replies = [];
    }

    const modal = openModal({
      title: ticket.subject,
      desc: `${ticket.ticket_type === "platform" ? "Shinzora support" : "Customer ticket"} · ${dateTime(ticket.created_at)}`,
      size: "lg",
      body: `
        <div class="stack gap-3" id="thread-body">
          <div class="msg msg-user">
            <span class="msg-avatar">${esc((state.profile?.full_name || "You").slice(0, 2).toUpperCase())}</span>
            <div class="msg-bubble">${esc(ticket.message)}</div>
          </div>
          ${replies
            .map(
              (reply) => {
                /* Four voices now share the thread, and they must not look the
                   same: the customer, the owner, Shinzora staff, and a reply a
                   machine wrote while nobody was watching. */
                const voice = {
                  admin: { cls: "msg-ai", avatar: icon("shield-check", { size: 13 }), who: "Shinzora support" },
                  assistant: { cls: "msg-ai", avatar: icon("sparkles", { size: 13 }), who: "Automatic reply" },
                  system: { cls: "msg-ai", avatar: icon("info", { size: 13 }), who: "System" },
                  customer: { cls: "msg-user", avatar: "CU", who: "Customer" },
                  owner: { cls: "msg-user", avatar: "ME", who: "You" }
                }[reply.author_role] || { cls: "msg-user", avatar: "ME", who: "You" };
                return `<div class="msg ${voice.cls}">
                <span class="msg-avatar">${voice.avatar}</span>
                <div>
                  <div class="msg-bubble">${esc(reply.body)}</div>
                  <div class="msg-meta">${esc(voice.who)} · ${esc(timeAgo(reply.created_at))}</div>
                </div>
              </div>`;
              }
            )
            .join("")}
        </div>
        ${
          ticket.escalated_at
            ? `<div class="alert alert-info" style="margin-top:var(--s-3);font-size:var(--fs-2xs)">${icon("life-buoy", { size: 14 })}<span>Escalated to the Shinzora team on ${esc(dateTime(ticket.escalated_at))}${
                ticket.escalation_reason ? ` — ${esc(ticket.escalation_reason)}` : ""
              }.</span></div>`
            : ""
        }
        <label class="switch-row" style="margin-top:var(--s-3)">
          <input type="checkbox" id="auto-reply" ${ticket.auto_reply ? "checked" : ""} ${aiReady ? "" : "disabled"} />
          <span>
            <strong>Answer new messages automatically</strong>
            <span class="dim" style="display:block;font-size:var(--fs-2xs)">The assistant replies to this ticket and marks it for your review. Off by default; you can stop it at any time.</span>
          </span>
        </label>
        <div class="field" style="margin-top:var(--s-4)">
          <label class="field-label" for="reply-body">Reply</label>
          <textarea class="textarea" id="reply-body" rows="4" placeholder="Write a reply, or ask the assistant for a draft."></textarea>
          <div class="field-hint" id="draft-hint"></div>
        </div>`,
      footer: `<button class="btn btn-ghost" data-modal-close>Close</button>
        <button class="btn btn-secondary" id="escalate-ticket">${icon("life-buoy", { size: 14 })}${ticket.escalated_at ? "Escalated" : "Escalate to a human"}</button>
        <button class="btn btn-secondary" id="history-ticket">${icon("history", { size: 14 })}History</button>
        <button class="btn btn-secondary" id="ai-draft" ${aiReady ? "" : "disabled"}>${icon("sparkles", { size: 14 })}AI draft</button>
        <button class="btn btn-primary" id="send-reply">${icon("send", { size: 14 })}Send reply</button>`,
      onMount: (dialog, modalApi) => {
        qs("#escalate-ticket", dialog)?.addEventListener("click", async () => {
          if (ticket.escalated_at) {
            toast({ title: "Already escalated", message: "The Shinzora team has this ticket." }, { tone: "info", duration: 3000 });
            return;
          }
          const values = await formDialog({
            title: "Escalate to a human",
            desc: "The ticket moves to the Shinzora team's queue and its priority is raised. Say why, so whoever picks it up has the context.",
            fields: [
              {
                name: "reason",
                label: "What needs a person?",
                type: "textarea",
                required: true,
                placeholder: "The customer wants a refund the policy does not cover."
              }
            ],
            submitLabel: "Escalate",
            size: "sm"
          });
          if (!values) return;
          try {
            const { error } = await sb.rpc("support_escalate", { p_ticket: ticket.id, p_reason: values.reason });
            if (error) throw normalizeError(error);
            ticket.escalated_at = new Date().toISOString();
            ticket.priority = "high";
            modalApi.close();
            paint();
            toast({ title: "Escalated", message: "The Shinzora team can see it now." }, { tone: "success" });
          } catch (error) {
            toastError(normalizeError(error));
          }
        });

        qs("#history-ticket", dialog)?.addEventListener("click", () => showHistory(ticket));

        qs("#auto-reply", dialog)?.addEventListener("change", async (event) => {
          const enabled = event.currentTarget.checked;
          try {
            const { error } = await sb.rpc("support_set_auto_reply", { p_ticket: ticket.id, p_enabled: enabled });
            if (error) throw normalizeError(error);
            ticket.auto_reply = enabled;
            toast(
              { title: enabled ? "Automatic replies on" : "Automatic replies off", message: enabled ? "New messages on this ticket get a draft reply in this thread." : "" },
              { tone: "success", duration: 2600 }
            );
          } catch (error) {
            event.currentTarget.checked = !enabled;
            toastError(normalizeError(error));
          }
        });

        qs("#ai-draft", dialog).addEventListener("click", async () => {
          const hint = qs("#draft-hint", dialog);
          hint.textContent = "Drafting…";
          try {
            const response = await api.ai.supportReply({
              ticket: { subject: ticket.subject, message: ticket.message, type: ticket.ticket_type },
              thread: replies.map((r) => ({ role: r.author_role, body: r.body })),
              business: state.business || null
            });
            qs("#reply-body", dialog).value = response?.reply || "";
            hint.textContent = "AI draft inserted — review before sending.";
          } catch (error) {
            hint.textContent = normalizeError(error).message;
          }
        });

        qs("#send-reply", dialog).addEventListener("click", async () => {
          const body = qs("#reply-body", dialog).value.trim();
          if (body.length < 2) return toast({ title: "Write a reply first" }, { tone: "warning" });
          try {
            const { error } = await sb.from("support_replies").insert({
              ticket_id: ticket.id,
              author_id: state.user.id,
              author_role: "owner",
              body
            });
            if (error) throw normalizeError(error);
            await sb.from("support_tickets").update({ status: "resolved", updated_at: new Date().toISOString() }).eq("id", ticket.id);
            ticket.status = "resolved";
            paint();
            toast({ title: "Reply saved" }, { tone: "success" });
            modal.close();
          } catch (error) {
            toastError(normalizeError(error));
          }
        });
      }
    });
  }

  async function newTicket(kind) {
    /* Other views can hand over a subject (a service request, an order) so the
       customer does not have to re-describe what they are writing about. */
    const prefill = new URLSearchParams(location.search).get("subject");
    const values = await formDialog({
      title: kind === "platform" ? "Message the Shinzora team" : "New support ticket",
      desc: kind === "platform" ? "Routed to the platform team and answered by a person." : "Log a customer conversation you are handling.",
      fields: [
        { name: "subject", label: "Subject", required: true, value: prefill || "" },
        {
          name: "priority",
          label: "Priority",
          type: "select",
          value: "normal",
          options: PRIORITIES.map((p) => ({ value: p, label: p }))
        },
        { name: "message", label: "Message", type: "textarea", rows: 5, required: true }
      ],
      submitLabel: "Create ticket",
      size: "lg"
    });
    if (!values) return;
    try {
      const { data, error } = await sb
        .from("support_tickets")
        .insert({
          owner_id: state.user.id,
          subject: values.subject,
          message: values.message,
          priority: values.priority,
          ticket_type: kind,
          status: "open"
        })
        .select("*")
        .single();
      if (error) throw normalizeError(error);
      rows.unshift(data);
      paint();
      toast({ title: "Ticket created" }, { tone: "success" });
    } catch (error) {
      toastError(normalizeError(error));
    }
  }
}
