/* ==========================================================================
   Shinzora — pre-launch monitoring (server only)
   --------------------------------------------------------------------------
   Requirement: "Track website changes, feature updates, errors and important
   activities. Notify the administrator about important changes and activities."

   This module keeps an append-only event log in `.prelaunch/monitor.jsonl`:

     auth.login        who signed in, from where, success or failure
     auth.logout
     data.write        every insert/update/delete made through the sandbox API
     admin.action      every administrative action (payment review, ticket reply…)
     client.error      errors reported by the browser while a pre-launch session
                       was active (window.onerror / unhandledrejection)
     feature.change    files added/removed/modified since the previous boot —
                       this is how "website changes and feature updates" are
                       detected without a git hook
     system.boot       server start, so a restart is visible in the timeline

   Unread state is a single watermark, not a per-event flag, so the log stays
   append-only and the admin's "mark read" is one cheap write.
   ========================================================================== */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const LOG = "monitor.jsonl";
const STATE = "monitor-state.json";
const MAX_LINES = 5000;

/* Same data directory as the sandbox store — see store.mjs#dataDir. */
const dir = (root) => (process.env.PRELAUNCH_DATA_DIR ? path.resolve(process.env.PRELAUNCH_DATA_DIR) : path.join(root, ".prelaunch"));
const file = (root, name) => path.join(dir(root), name);

function ensure(root) {
  fs.mkdirSync(dir(root), { recursive: true });
}

export function readState(root) {
  try {
    return JSON.parse(fs.readFileSync(file(root, STATE), "utf8"));
  } catch {
    return { read_until: 0, fingerprint: null };
  }
}

export function writeState(root, next) {
  ensure(root);
  fs.writeFileSync(file(root, STATE), JSON.stringify(next, null, 2));
}

export function record(root, event) {
  ensure(root);
  const entry = {
    id: crypto.randomUUID(),
    at: new Date().toISOString(),
    type: event.type || "event",
    severity: event.severity || "info",
    message: event.message || "",
    actor: event.actor || null,
    meta: event.meta || null
  };
  try {
    fs.appendFileSync(file(root, LOG), `${JSON.stringify(entry)}\n`);
  } catch {
    /* a monitoring failure must never break a request */
    return entry;
  }
  return entry;
}

export function events(root, { limit = 200, type = null, since = 0 } = {}) {
  let raw = "";
  try {
    raw = fs.readFileSync(file(root, LOG), "utf8");
  } catch {
    return [];
  }
  const lines = raw.split("\n").filter(Boolean);
  const slice = lines.length > MAX_LINES ? lines.slice(-MAX_LINES) : lines;
  const rows = [];
  for (const line of slice) {
    try {
      const entry = JSON.parse(line);
      if (type && entry.type !== type) continue;
      if (since && Date.parse(entry.at) <= since) continue;
      rows.push(entry);
    } catch {
      /* skip a torn line rather than failing the whole read */
    }
  }
  return rows.reverse().slice(0, limit);
}

export function unread(root) {
  const state = readState(root);
  const watermark = Number(state.read_until || 0);
  return events(root, { limit: MAX_LINES }).filter((entry) => Date.parse(entry.at) > watermark).length;
}

export function markRead(root) {
  const state = readState(root);
  writeState(root, { ...state, read_until: Date.now() });
  return { ok: true, read_until: Date.now() };
}

/* --------------------------------------------------- website change tracking */

/** A cheap, stable fingerprint of the deployable tree. */
export function fingerprint(root) {
  const publicDir = path.join(root, "public");
  const entries = [];
  const walk = (dir) => {
    let listing;
    try {
      listing = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const item of listing) {
      const full = path.join(dir, item.name);
      if (item.isDirectory()) {
        if (item.name === "node_modules" || item.name === ".git") continue;
        walk(full);
      } else {
        try {
          const stat = fs.statSync(full);
          entries.push(`${path.relative(publicDir, full)}:${stat.size}:${Math.round(stat.mtimeMs)}`);
        } catch {
          /* unreadable file — ignore */
        }
      }
    }
  };
  walk(publicDir);
  entries.sort();
  return {
    hash: crypto.createHash("sha256").update(entries.join("|")).digest("hex").slice(0, 16),
    files: entries.length,
    entries
  };
}

/**
 * Compare the current tree with the last recorded one. Called on boot (and on
 * demand from the admin view). Returns the change summary and logs it once.
 */
export function trackChanges(root, { log = true } = {}) {
  const state = readState(root);
  const current = fingerprint(root);

  /* A serverless bundle does not carry the deployable tree, so there is nothing
     to compare. Say so instead of claiming "no changes". */
  if (!current.files) {
    return {
      available: false,
      changed: false,
      hash: null,
      files: 0,
      added: [],
      removed: [],
      note: "Website change tracking needs the deployable tree on disk, which this host does not expose to the function."
    };
  }

  if (!state.fingerprint) {
    writeState(root, { ...state, fingerprint: current.hash, files: current.files, checked_at: Date.now() });
    return { available: true, first_run: true, changed: false, hash: current.hash, files: current.files, added: [], removed: [] };
  }

  if (state.fingerprint === current.hash) {
    writeState(root, { ...state, checked_at: Date.now() });
    return { available: true, changed: false, hash: current.hash, files: current.files, added: [], removed: [] };
  }

  const previous = new Set(state.entries || []);
  const next = new Set(current.entries);
  const added = current.entries.filter((entry) => !previous.has(entry)).map((entry) => entry.split(":")[0]);
  const removed = [...previous].filter((entry) => !next.has(entry)).map((entry) => entry.split(":")[0]);

  const summary = {
    available: true,
    changed: true,
    hash: current.hash,
    files: current.files,
    added: added.slice(0, 40),
    removed: removed.slice(0, 40),
    added_count: added.length,
    removed_count: removed.length
  };

  writeState(root, {
    ...state,
    fingerprint: current.hash,
    files: current.files,
    entries: current.entries,
    checked_at: Date.now()
  });

  if (log) {
    record(root, {
      type: "feature.change",
      severity: added.length + removed.length > 0 ? "notice" : "info",
      message: `Website files updated — ${added.length} added, ${removed.length} removed or changed since the last check.`,
      meta: { added: summary.added, removed: summary.removed, files: current.files }
    });
  }

  return summary;
}

/** Log a client-side error reported by the browser. */
export function recordClientError(root, session, payload) {
  return record(root, {
    type: "client.error",
    severity: "error",
    message: String(payload.message || "Client error").slice(0, 400),
    actor: session ? { id: session.account.id, email: session.account.displayEmail, role: session.account.role } : null,
    meta: {
      source: String(payload.source || "").slice(0, 300),
      stack: String(payload.stack || "").slice(0, 1200),
      url: String(payload.url || "").slice(0, 300),
      view: String(payload.view || "").slice(0, 80)
    }
  });
}

export default { record, events, unread, markRead, trackChanges, fingerprint, readState, writeState, recordClientError };
