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
import { api, runtimeConfig } from "../../../lib/api.js";
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
      actions: `<button class="btn btn-primary btn-sm" id="new-ticket">${icon("plus", { size: 14 })}New ticket</button>`
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
                  <div class="cell-strong">${esc(row.subject)}</div>
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
              (reply) => `<div class="msg ${reply.author_role === "admin" ? "msg-ai" : "msg-user"}">
                <span class="msg-avatar">${reply.author_role === "admin" ? icon("shield-check", { size: 13 }) : "ME"}</span>
                <div>
                  <div class="msg-bubble">${esc(reply.body)}</div>
                  <div class="msg-meta">${esc(reply.author_role === "admin" ? "Shinzora support" : "You")} · ${esc(timeAgo(reply.created_at))}</div>
                </div>
              </div>`
            )
            .join("")}
        </div>
        <div class="field" style="margin-top:var(--s-4)">
          <label class="field-label" for="reply-body">Reply</label>
          <textarea class="textarea" id="reply-body" rows="4" placeholder="Write a reply, or ask the assistant for a draft."></textarea>
          <div class="field-hint" id="draft-hint"></div>
        </div>`,
      footer: `<button class="btn btn-ghost" data-modal-close>Close</button>
        <button class="btn btn-secondary" id="ai-draft" ${aiReady ? "" : "disabled"}>${icon("sparkles", { size: 14 })}AI draft</button>
        <button class="btn btn-primary" id="send-reply">${icon("send", { size: 14 })}Send reply</button>`,
      onMount: (dialog) => {
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
