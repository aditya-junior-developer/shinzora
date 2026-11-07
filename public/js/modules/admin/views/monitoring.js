/* ==========================================================================
   Admin · Monitoring
   --------------------------------------------------------------------------
   What the administrator needs in one place while the pre-launch accounts are
   in use:

     · every sign-in and sign-out attempt on the pre-launch service
     · every data write, administrative action and AI/site call
     · errors reported by the browser while a pre-launch account was signed in
     · website changes — files added, removed or changed since the last check
     · a read watermark, so "unread" means something

   Every row here is produced by the server (server/prelaunch/monitor.mjs) from
   real requests. Nothing is generated in the browser, and nothing is invented:
   if the endpoint is unavailable the panel says so instead of showing zeros.
   ========================================================================== */

import { esc, on, qs, safeSet } from "../../../lib/dom.js";
import { icon } from "../../../lib/icons.js";
import { timeAgo } from "../../../lib/format.js";
import { toast, toastError } from "../../../ui/toast.js";
import { sb } from "../../../lib/supabase.js";
import { adminApi } from "../api.js";

const API = "/api/prelaunch";

/* The console signs administrators in with Supabase, while the pre-launch
   service expects its own cookie. Sending the Supabase access token lets the
   server recognise the same administrator by either route — it verifies the
   token against the project and checks public.admin_users, so this is a real
   check, not a header that is trusted because it was sent. */
async function authHeaders() {
  try {
    const { data } = await sb.auth.getSession();
    const token = data?.session?.access_token;
    return token ? { Authorization: `Bearer ${token}` } : {};
  } catch {
    return {};
  }
}

const TYPE_LABELS = {
  "auth.login": "Sign-in",
  "auth.logout": "Sign-out",
  "data.write": "Data write",
  "admin.action": "Admin action",
  "service.call": "Service call",
  "client.error": "Client error",
  "server.error": "Server error",
  "feature.change": "Website change",
  "feature.use": "Feature used",
  "system.boot": "Server start",
  "system.reset": "Sandbox reset"
};

/* Severity → the console's existing badge tones. */
const SEVERITY_CLASS = { info: "", notice: "badge-warn", warn: "badge-warn", error: "badge-danger" };

function stat({ label, value, foot, iconName }) {
  return `<div class="admin-stat">
    <div class="admin-stat-label">${icon(iconName, { size: 12 })}${esc(label)}</div>
    <div class="admin-stat-value">${esc(String(value))}</div>
    <div class="admin-stat-foot">${esc(foot)}</div>
  </div>`;
}

class MonitorError extends Error {
  constructor(message, { code = "", hint = "", status = 0 } = {}) {
    super(message);
    this.code = code;
    this.hint = hint;
    this.status = status;
  }
}

async function fetchMonitor(limit = 250) {
  const response = await fetch(`${API}/monitor?limit=${limit}`, {
    credentials: "same-origin",
    headers: { accept: "application/json", ...(await authHeaders()) },
    cache: "no-store"
  });

  if (!response.ok) {
    let body = {};
    try {
      body = await response.json();
    } catch {
      /* a proxy in front of the service may answer with HTML */
    }
    throw new MonitorError(body.error || `The monitoring service answered HTTP ${response.status}.`, {
      code: body.code || "",
      hint: body.hint || "",
      status: response.status
    });
  }
  return response.json();
}

function eventRow(entry) {
  const typeLabel = TYPE_LABELS[entry.type] || entry.type;
  const badgeTone = SEVERITY_CLASS[entry.severity] ?? "";
  const actor = entry.actor ? `${entry.actor.email || entry.actor.id} · ${entry.actor.role}` : "system";
  const detail = entry.meta && Object.keys(entry.meta).length ? JSON.stringify(entry.meta).slice(0, 180) : "";
  return `<tr>
    <td class="mono muted">${esc(timeAgo(entry.at))}</td>
    <td><span class="badge ${badgeTone}">${esc(typeLabel)}</span></td>
    <td>${esc(entry.message || "")}</td>
    <td class="muted">${esc(actor)}</td>
    <td class="mono muted">${esc(detail)}</td>
  </tr>`;
}

export default async function render(root, { setCounts }) {
  root.innerHTML = `
    <div class="admin-head">
      <div>
        <h1>Monitoring</h1>
        <p>
          Live operational log for the pre-launch service: sign-ins, data writes, administrative actions, browser
          errors and website changes. Pre-launch rows live in their own sandbox store, separate from customer data.
        </p>
      </div>
      <div class="admin-filters">
        <button class="btn btn-secondary btn-sm" id="monitor-refresh">${icon("refresh-cw", { size: 14 })}<span>Refresh</span></button>
        <button class="btn btn-ghost btn-sm" id="monitor-read">${icon("check-check", { size: 14 })}<span>Mark all read</span></button>
      </div>
    </div>
    <div class="admin-card" style="margin-bottom:var(--s-4)">
      <div class="admin-card-head">
        <div>
          <div class="admin-card-title">Platform probes</div>
          <div class="admin-card-sub" id="probe-sub">Each row is a request made just now. Nothing here is a stored uptime figure.</div>
        </div>
        <button class="btn btn-ghost btn-sm" id="probe-refresh">${icon("refresh-cw", { size: 14 })}<span>Run again</span></button>
      </div>
      <div id="probe-body"><div class="admin-card-body muted">Running probes…</div></div>
    </div>
    <div id="monitor-body"><div class="admin-card"><div class="admin-card-body muted">Loading the event log…</div></div></div>
  `;

  const host = qs("#monitor-body");

  const probes = qs("#probe-body");

  async function runProbes() {
    probes.innerHTML = `<div class="admin-card-body muted">Running probes…</div>`;
    try {
      const response = await adminApi.monitor();
      const checks = response.checks || [];
      const failing = checks.filter((check) => !check.ok).length;
      qs("#probe-sub").textContent = `${checks.length} probes · ${failing ? `${failing} failing` : "all passing"} · checked ${timeAgo(response.checked_at)}`;
      probes.innerHTML = checks.length
        ? `<div class="table-wrap"><table class="table">
            <thead><tr><th>Probe</th><th>Result</th><th>Latency</th><th>Detail</th></tr></thead>
            <tbody>${checks
              .map(
                (check) => `<tr>
                  <td class="cell-strong">${esc(check.name)}</td>
                  <td><span class="badge ${check.ok ? "badge-ok" : "badge-danger"}">${check.ok ? "passing" : "failing"}</span></td>
                  <td class="mono muted">${check.ms === null || check.ms === undefined ? "—" : `${check.ms} ms`}</td>
                  <td class="muted">${esc(check.detail || "")}</td>
                </tr>`
              )
              .join("")}</tbody></table></div>`
        : `<div class="admin-empty">The probe endpoint returned no checks.</div>`;
    } catch (error) {
      probes.innerHTML = `<div class="admin-card-body">
        <div class="admin-card-title" style="font-size:var(--fs-sm)">Probes are not available on this deployment</div>
        <p class="muted" style="margin-top:6px">${esc(error.message)}</p>
        <p class="muted" style="margin-top:6px">${esc(
          error.hint || "This needs the current `admin` Edge Function deployed. The event log below is read from the pre-launch service instead."
        )}</p>
      </div>`;
    }
  }

  qs("#probe-refresh")?.addEventListener("click", runProbes);
  runProbes();

  async function load() {
    let data;
    try {
      data = await fetchMonitor();
    } catch (error) {
      /* Say which of the three things went wrong, because they need different
         actions: not authorised, not deployed, or broken. */
      const forbidden = error.status === 403;
      const missing = error.status === 404 || error.status === 405;
      const title = forbidden
        ? "This account is not on the administrator list"
        : missing
          ? "The monitoring service is not running on this deployment"
          : "Monitoring could not be read";
      const detail = forbidden
        ? "Sign-in succeeded, but the monitoring service does not recognise this account as an administrator. Sign-in and authorisation are separate: the account exists, it is simply not on the list the monitoring service checks."
        : missing
          ? "The console loaded, but the monitoring endpoint is not answering at this address. The owner can fix this by redeploying the API so the pre-launch service ships with the site, then reloading this page."
          : error.message || "The monitoring endpoint did not respond.";
      host.innerHTML = `<div class="admin-card"><div class="admin-card-body">
        <div class="admin-card-title">${esc(title)}</div>
        <p class="muted">${esc(detail)}</p>
        ${error.hint ? `<p class="muted">${esc(error.hint)}</p>` : ""}
        ${missing || forbidden ? "" : `<p class="muted mono small">${esc(`HTTP ${error.status}`)}</p>`}
      </div></div>`;
      return;
    }

    const events = data.events || [];
    const changes = data.changes || {};
    const errors = events.filter((entry) => entry.severity === "error").length;
    const adminActions = events.filter((entry) => entry.type === "admin.action").length;
    const signIns = events.filter((entry) => entry.type === "auth.login").length;

    setCounts?.({ monitor_unread: data.unread || 0 });

    const changeList = [
      ...(changes.added || []).map((file) => `<li><span class="mono">+</span> ${esc(file)}</li>`),
      ...(changes.removed || []).map((file) => `<li><span class="mono">−</span> ${esc(file)}</li>`)
    ].join("");

    host.innerHTML = `
      <div class="admin-grid" style="margin-bottom:18px">
        ${stat({ label: "Unread events", value: data.unread || 0, foot: "Since you last marked the log read", iconName: "bell" })}
        ${stat({ label: "Events in view", value: events.length, foot: "Most recent first, capped at 250", iconName: "activity" })}
        ${stat({ label: "Errors", value: errors, foot: "Server or browser failures", iconName: "bug" })}
        ${stat({ label: "Admin actions", value: adminActions, foot: "Reviews, replies and updates", iconName: "shield-check" })}
        ${stat({ label: "Sign-in attempts", value: signIns, foot: "Successful and refused", iconName: "log-in" })}
      </div>

      <div class="admin-card" style="margin-bottom:18px">
        <div class="admin-card-head">
          <div>
            <div class="admin-card-title">Website changes</div>
            <div class="admin-card-sub">Files added, removed or modified in <code>public/</code> since the previous check</div>
          </div>
          <span class="badge ${changes.changed ? "badge-warn" : "badge-ok"}">${changes.changed ? "Changed" : "No changes"}</span>
        </div>
        <div class="admin-card-body">
          ${
            changes.available === false
              ? `<p class="muted">${esc(changes.note || "Change tracking is not available on this host.")}</p>`
              : changes.first_run
                ? `<p class="muted">This is the first check on this deployment, so there is no previous state to compare with yet. The next change will appear here.</p>`
                : changes.changed
                  ? `<ul class="monitor-changes">${changeList || "<li>File contents changed without a path difference.</li>"}</ul>`
                  : `<p class="muted">The deployable tree is unchanged since the last check (${esc(String(changes.files || 0))} files fingerprinted).</p>`
          }
          <p class="muted" style="margin-top:10px">
            Fingerprint <span class="mono">${esc(changes.hash || "—")}</span> · ${esc(String(changes.files || 0))} files · checked just now
          </p>
        </div>
      </div>

      <div class="admin-card">
        <div class="admin-card-head">
          <div>
            <div class="admin-card-title">Event log</div>
            <div class="admin-card-sub">Everything the pre-launch service recorded, newest first</div>
          </div>
          <div class="admin-tabs" id="monitor-filter" role="tablist">
            ${["all", "auth.login", "data.write", "admin.action", "client.error", "feature.change"]
              .map(
                (type, index) =>
                  `<button class="${index === 0 ? "is-active" : ""}" data-type="${type}">${esc(
                    type === "all" ? "All" : TYPE_LABELS[type] || type
                  )}</button>`
              )
              .join("")}
          </div>
        </div>
        <div class="admin-card-body">
          <div id="monitor-events">${renderTable(events)}</div>
        </div>
      </div>
    `;

    qs("#monitor-filter")?.addEventListener("click", (event) => {
      const button = event.target.closest("[data-type]");
      if (!button) return;
      const type = button.getAttribute("data-type");
      qs("#monitor-filter")
        ?.querySelectorAll("button")
        .forEach((chip) => chip.classList.toggle("is-active", chip === button));
      const filtered = type === "all" ? events : events.filter((entry) => entry.type === type);
      safeSet("#monitor-events", renderTable(filtered));
    });
  }

  function renderTable(rows) {
    if (!rows.length) {
      return `<p class="muted">No events of this kind have been recorded yet.</p>`;
    }
    return `<div class="table-wrap"><table class="table">
      <thead><tr><th>When</th><th>Type</th><th>Event</th><th>Actor</th><th>Detail</th></tr></thead>
      <tbody>${rows.map(eventRow).join("")}</tbody>
    </table></div>`;
  }

  on(qs("#monitor-refresh"), "click", async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    try {
      await load();
      toast({ title: "Monitor refreshed", message: "The event log was re-read from the server." }, { tone: "info" });
    } catch (error) {
      toastError(error);
    } finally {
      button.disabled = false;
    }
  });

  on(qs("#monitor-read"), "click", async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    try {
      const response = await fetch(`${API}/monitor/read`, {
        method: "POST",
        credentials: "same-origin",
        headers: { accept: "application/json", ...(await authHeaders()) }
      });
      if (!response.ok) throw new Error(`Could not mark the log read (HTTP ${response.status}).`);
      await load();
      toast({ title: "Marked as read", message: "New events will count as unread from now on." }, { tone: "success" });
    } catch (error) {
      toastError(error);
    } finally {
      button.disabled = false;
    }
  });

  await load();
}
