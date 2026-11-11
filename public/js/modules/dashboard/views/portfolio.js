/* ==========================================================================
   Shinzora — Portfolio & CV
   --------------------------------------------------------------------------
   Everything a business sees when it opens this person's profile, in one
   editable screen: the freelancer profile itself, the CV link, work history,
   and portfolio items.

   Two relationships with the database:
     marketplace_save_agent            the existing profile writer (headline,
                                       skills, rate, hours, seeking, equity)
     agent_save_portfolio_profile      the extended fields 0027 added
     portfolio_item_save / _delete     the repeatable list

   All three are security-definer RPCs and every one of them checks that the
   row belongs to the caller, so this file never decides that — it only shows
   what came back. Experience and social links are edited as JSON-shaped
   arrays/objects and normalised in SQL (trimmed, capped, unknown keys dropped),
   so a malformed field cannot reach the table.
   ========================================================================== */

import { qs, delegate, esc, on } from "../../../lib/dom.js";
import { icon } from "../../../lib/icons.js";
import { sb, normalizeError } from "../../../lib/supabase.js";
import { state } from "../../../lib/store.js";
import { pageHead, skeletonView } from "../components.js";
import { toast, toastError } from "../../../ui/toast.js";

const rpc = async (name, args = {}) => {
  const { data, error } = await sb.rpc(name, args);
  if (error) throw normalizeError(error);
  return data;
};

const SOCIAL_KEYS = [
  ["linkedin", "LinkedIn"],
  ["github", "GitHub"],
  ["dribbble", "Dribbble"],
  ["behance", "Behance"],
  ["x", "X / Twitter"],
  ["website", "Website"]
];

let profile = {};
let items = [];
let experience = [];
let socials = {};
let saving = false;

/* bind() runs on every paint, but delegate() attaches to the root element —
   which survives repaints. Without this guard a second paint means two
   listeners, so one click would save (or delete) twice. The per-form handlers
   below are safe because paint() replaces those nodes outright. */
const delegatedRoots = new WeakSet();

export default async function render(root) {
  root.innerHTML = skeletonView(4);
  try {
    const ws = await rpc("marketplace_my_workspace");
    profile = ws?.profile || {};
    const userId = state.user?.id;
    const { data, error } = await sb
      .from("freelancer_portfolio_items")
      .select("id,title,summary,url,image_url,skills,completed_on,sort_order")
      .eq("user_id", userId || profile.user_id || "")
      .order("sort_order", { ascending: true })
      .order("created_at", { ascending: false });
    if (error) throw normalizeError(error);
    items = data || [];
  } catch (error) {
    root.innerHTML = `${pageHead({ title: "Portfolio & CV" })}<div class="card"><div class="card-body">
      <p class="muted">${esc(error.message || "Your profile could not be loaded.")}</p></div></div>`;
    return;
  }

  experience = Array.isArray(profile.experience) ? profile.experience : [];
  socials = profile.social_links && typeof profile.social_links === "object" ? profile.social_links : {};
  paint(root);
}

function paint(root) {
  const published = Boolean(profile.is_published);
  root.innerHTML = `
    ${pageHead({
      title: "Portfolio & CV",
      desc: "This is what a business reads before it hires you.",
      badge: published
        ? `<span class="mk-status mk-positive">Published</span>`
        : `<span class="mk-status mk-muted">Not published</span>`,
      actions: `<a class="btn btn-ghost btn-sm" href="/app/?view=freelancer">${icon("arrow-left", { size: 14 })}Dashboard</a>`
    })}

    <section class="card">
      <div class="card-body">
        <h3 class="mk-subhead">${icon("user-round", { size: 15 })} The basics</h3>
        <form id="pf-basics" class="pf-form">
          <label class="pf-field">
            <span>Headline</span>
            <input name="headline" maxlength="120" value="${esc(profile.headline || "")}"
              placeholder="e.g. Product designer for early-stage teams" />
          </label>
          <label class="pf-field">
            <span>About you</span>
            <textarea name="bio" rows="4" maxlength="2000" placeholder="Two or three sentences on how you work.">${esc(profile.bio || "")}</textarea>
          </label>
          <label class="pf-field">
            <span>Skills <em>(comma separated)</em></span>
            <input name="skills" value="${esc((profile.skills || []).join(", "))}" placeholder="figma, web design, react" />
          </label>
          <div class="pf-row">
            <label class="pf-field">
              <span>Expected pay</span>
              <input name="expected_rate" type="number" min="0" step="100" value="${esc(profile.expected_rate ?? "")}" />
            </label>
            <label class="pf-field pf-narrow">
              <span>Currency</span>
              <select name="currency">
                ${["INR", "USD", "EUR", "GBP", "AED"].map((c) => `<option ${((profile.expected_currency || profile.currency || "INR") === c) ? "selected" : ""}>${c}</option>`).join("")}
              </select>
            </label>
            <label class="pf-field">
              <span>Years of experience</span>
              <input name="years_experience" type="number" min="0" max="60" value="${esc(profile.years_experience ?? "")}" />
            </label>
          </div>
          <div class="pf-row">
            <label class="pf-field">
              <span>Hours per week</span>
              <input name="hours_per_week" type="number" min="1" max="80" value="${esc(profile.hours_per_week ?? "")}" />
            </label>
            <label class="pf-field">
              <span>Availability</span>
              <select name="availability">
                ${["available", "busy", "unavailable"].map((a) => `<option ${(profile.availability === a) ? "selected" : ""}>${a}</option>`).join("")}
              </select>
            </label>
            <label class="pf-field">
              <span>Location</span>
              <input name="location" maxlength="120" value="${esc(profile.location || "")}" placeholder="New Delhi" />
            </label>
          </div>
          <label class="pf-field">
            <span>What you are looking for</span>
            <textarea name="seeking" rows="2" maxlength="500" placeholder="Long-term product work with a small team.">${esc(profile.seeking || "")}</textarea>
          </label>

          <fieldset class="pf-checks">
            <legend>Equity, stakes and ESOPs</legend>
            <label class="pf-check"><input type="checkbox" name="equity_ok" data-checked="${profile.equity_ok ? "true" : "false"}" /><span>I would take equity or a stake in place of some cash</span></label>
            <div class="pf-row">
              <label class="pf-field">
                <span>Equity from (%)</span>
                <input name="equity_min_pct" type="number" min="0" max="100" step="0.5" value="${esc(profile.equity_min_pct ?? "")}" />
              </label>
              <label class="pf-field">
                <span>Equity up to (%)</span>
                <input name="equity_max_pct" type="number" min="0" max="100" step="0.5" value="${esc(profile.equity_max_pct ?? "")}" />
              </label>
            </div>
            <label class="pf-check"><input type="checkbox" name="esop_ok" data-checked="${profile.esop_ok ? "true" : "false"}" /><span>I am open to an ESOP</span></label>
            <label class="pf-check"><input type="checkbox" name="remote_ok" data-checked="${profile.remote_ok ? "true" : "false"}" /><span>I work remotely</span></label>
          </fieldset>

          <label class="pf-check"><input type="checkbox" name="publish" data-checked="${published ? "true" : "false"}" /><span>Publish my profile so businesses can find me</span></label>

          <div class="pf-actions">
            <button class="btn btn-primary btn-sm" type="submit" id="pf-save-basics">${icon("check", { size: 14 })}Save profile</button>
          </div>
        </form>
      </div>
    </section>

    <section class="card">
      <div class="card-body">
        <h3 class="mk-subhead">${icon("file-text", { size: 15 })} CV and links</h3>
        <form id="pf-links" class="pf-form">
          <label class="pf-field">
            <span>CV / résumé link <em>(a hosted PDF link)</em></span>
            <input name="resume_url" maxlength="500" value="${esc(profile.resume_url || "")}" placeholder="https://drive.google.com/..." />
          </label>
          <div class="pf-row pf-social">
            ${SOCIAL_KEYS.map(([key, label]) => `<label class="pf-field">
              <span>${label}</span>
              <input name="social_${key}" maxlength="300" value="${esc(socials[key] || "")}" placeholder="https://" />
            </label>`).join("")}
          </div>
          <label class="pf-field">
            <span>Languages <em>(comma separated)</em></span>
            <input name="languages" value="${esc((profile.languages || []).join(", "))}" placeholder="English, Hindi" />
          </label>
          <div class="pf-actions">
            <button class="btn btn-primary btn-sm" type="submit" id="pf-save-links">${icon("check", { size: 14 })}Save links</button>
          </div>
        </form>
      </div>
    </section>

    <section class="card">
      <div class="card-body">
        <h3 class="mk-subhead">${icon("briefcase", { size: 15 })} Work history</h3>
        <div id="pf-exp">${experienceList()}</div>
        <form id="pf-exp-form" class="pf-form pf-inline-form">
          <div class="pf-row">
            <label class="pf-field"><span>Role</span><input name="role" maxlength="120" placeholder="Senior designer" required /></label>
            <label class="pf-field"><span>Company</span><input name="company" maxlength="120" placeholder="Acme" /></label>
          </div>
          <div class="pf-row">
            <label class="pf-field pf-narrow"><span>From</span><input name="from" maxlength="20" placeholder="2021" /></label>
            <label class="pf-field pf-narrow"><span>To</span><input name="to" maxlength="20" placeholder="2024 or Present" /></label>
          </div>
          <label class="pf-field"><span>What you did</span><textarea name="summary" rows="2" maxlength="800"></textarea></label>
          <div class="pf-actions"><button class="btn btn-secondary btn-sm" type="submit">${icon("plus", { size: 14 })}Add to history</button></div>
        </form>
      </div>
    </section>

    <section class="card">
      <div class="card-body">
        <h3 class="mk-subhead">${icon("folder-git-2", { size: 15 })} Portfolio</h3>
        <div id="pf-items">${itemsList()}</div>
        <form id="pf-item-form" class="pf-form pf-inline-form">
          <label class="pf-field"><span>Title</span><input name="title" maxlength="160" placeholder="Bakery website" required /></label>
          <label class="pf-field"><span>Summary</span><textarea name="summary" rows="2" maxlength="2000" placeholder="What it was and what you did."></textarea></label>
          <div class="pf-row">
            <label class="pf-field"><span>Link</span><input name="url" maxlength="500" placeholder="https://" /></label>
            <label class="pf-field"><span>Image link</span><input name="image_url" maxlength="500" placeholder="https://" /></label>
          </div>
          <div class="pf-row">
            <label class="pf-field"><span>Skills <em>(comma separated)</em></span><input name="skills" placeholder="web design, copy" /></label>
            <label class="pf-field pf-narrow"><span>Completed</span><input name="completed_on" type="date" /></label>
          </div>
          <div class="pf-actions"><button class="btn btn-secondary btn-sm" type="submit">${icon("plus", { size: 14 })}Add item</button></div>
        </form>
      </div>
    </section>`;

  /* Reflect data-checked into the live property; the attribute alone is not
     guaranteed to reach .checked in every engine. */
  for (const box of root.querySelectorAll('input[type="checkbox"][data-checked]')) {
    box.checked = box.dataset.checked === "true";
  }

  bind(root);
}

function experienceList() {
  if (!experience.length) return `<p class="muted">No history yet. Adding two or three roles makes a profile far more convincing.</p>`;
  return `<ul class="pf-list">${experience
    .map(
      (job, index) => `<li class="pf-list-row">
        <div>
          <div class="pf-list-title">${esc(job.role || "Role")}</div>
          <div class="mk-note">${esc(job.company || "")}${job.from || job.to ? ` · ${esc(job.from || "")}–${esc(job.to || "")}` : ""}</div>
          ${job.summary ? `<p class="mk-desc">${esc(job.summary)}</p>` : ""}
        </div>
        <button class="btn btn-ghost btn-sm" data-exp-remove="${index}">Remove</button>
      </li>`
    )
    .join("")}</ul>`;
}

function itemsList() {
  if (!items.length) return `<p class="muted">No portfolio items yet.</p>`;
  return `<ul class="pf-list">${items
    .map(
      (item) => `<li class="pf-list-row">
        <div>
          <div class="pf-list-title">${esc(item.title)}</div>
          ${item.summary ? `<p class="mk-desc">${esc(item.summary)}</p>` : ""}
          <div class="mk-note">${item.completed_on ? `${esc(String(item.completed_on).slice(0, 10))} · ` : ""}${
            item.url ? `<a class="mk-link" href="${esc(item.url)}" target="_blank" rel="noopener noreferrer">Open</a>` : "No link"
          }</div>
        </div>
        <button class="btn btn-ghost btn-sm" data-item-remove="${esc(item.id)}">Remove</button>
      </li>`
    )
    .join("")}</ul>`;
}

function bind(root) {
  /* Read the fields directly rather than going through FormData: entries() is
     missing in some DOM implementations, and a plain name→value map is all
     this form needs. Unchecked checkboxes are simply absent, which is what
     the checked() helper below expects. */
  const readForm = (form) => {
    const out = {};
    for (const field of form.querySelectorAll("input, textarea, select")) {
      if (!field.name) continue;
      if (field.type === "checkbox") {
        if (field.checked) out[field.name] = field.value || "on";
        continue;
      }
      if (field.tagName === "SELECT") {
        const chosen = [...field.querySelectorAll("option")].find((option) => option.selected) ||
          field.querySelectorAll("option")[0];
        out[field.name] = chosen ? chosen.getAttribute("value") : "";
        continue;
      }
      out[field.name] = field.value ?? "";
    }
    return out;
  };
  /* form.elements is not implemented everywhere (linkedom omits it), so read
     checkboxes by name and fall back to the parsed FormData. */
  const checked = (form, name) => {
    const field = form.elements?.[name] || form.querySelector(`[name="${name}"]`);
    return Boolean(field?.checked);
  };
  const skills = (value) => String(value || "").split(",").map((s) => s.trim()).filter(Boolean);

  on(qs("#pf-basics", root), "submit", async (event) => {
    event.preventDefault();
    if (saving) return;
    saving = true;
    const form = event.currentTarget || event.target;
    const data = readForm(form);
    const button = qs("#pf-save-basics", root);
    button.disabled = true;
    try {
      await rpc("marketplace_save_agent", {
        p_headline: data.headline || null,
        p_bio: data.bio || null,
        p_skills: skills(data.skills),
        p_expected_rate: data.expected_rate ? Number(data.expected_rate) : null,
        p_currency: data.currency || "INR",
        p_availability: data.availability || "available",
        p_portfolio_url: profile.portfolio_url || null,
        p_years_experience: data.years_experience ? Number(data.years_experience) : null,
        p_seeking: data.seeking || null,
        p_hours_per_week: data.hours_per_week ? Number(data.hours_per_week) : null,
        p_notice_period_days: profile.notice_period_days ?? null,
        p_location: data.location || null,
        p_remote_ok: checked(form, "remote_ok"),
        p_equity_ok: checked(form, "equity_ok"),
        p_equity_min_pct: data.equity_min_pct ? Number(data.equity_min_pct) : null,
        p_equity_max_pct: data.equity_max_pct ? Number(data.equity_max_pct) : null,
        p_esop_ok: checked(form, "esop_ok"),
        p_publish: checked(form, "publish")
      });
      profile = { ...profile, ...data, skills: skills(data.skills), is_published: checked(form, "publish") };
      toast({ title: "Profile saved", message: checked(form, "publish") ? "Your profile is live and businesses can find you." : "Saved. It stays hidden until you publish." });
    } catch (error) {
      toastError(error);
    } finally {
      saving = false;
      button.disabled = false;
    }
  });

  on(qs("#pf-links", root), "submit", async (event) => {
    event.preventDefault();
    if (saving) return;
    saving = true;
    const form = event.currentTarget || event.target;
    const data = readForm(form);
    const nextSocials = {};
    for (const [key] of SOCIAL_KEYS) {
      const value = String(data[`social_${key}`] || "").trim();
      if (value) nextSocials[key] = value;
    }
    const button = qs("#pf-save-links", root);
    button.disabled = true;
    try {
      await rpc("agent_save_portfolio_profile", {
        p_resume_url: data.resume_url || null,
        p_experience: experience,
        p_social_links: nextSocials,
        p_languages: skills(data.languages),
        p_timezone: profile.timezone || null
      });
      socials = nextSocials;
      profile = { ...profile, resume_url: data.resume_url || null, social_links: nextSocials, languages: skills(data.languages) };
      toast({ title: "Links saved" });
    } catch (error) {
      toastError(error);
    } finally {
      saving = false;
      button.disabled = false;
    }
  });

  /* Experience is stored as one JSON array, so adding or removing a role saves
     the whole list through the same RPC as the links. */
  on(qs("#pf-exp-form", root), "submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget || event.target;
    const data = readForm(form);
    if (!String(data.role || "").trim()) return;
    experience = [...experience, {
      role: data.role,
      company: data.company || "",
      from: data.from || "",
      to: data.to || "",
      summary: data.summary || ""
    }];
    await saveExperience(root, form);
  });

  if (!delegatedRoots.has(root)) {
    delegatedRoots.add(root);
    delegate(root, "click", "[data-exp-remove]", async (_event, button) => {
      experience = experience.filter((_, index) => index !== Number(button.dataset.expRemove));
      await saveExperience(root);
    });

    delegate(root, "click", "[data-item-remove]", async (_event, button) => {
      if (!confirm("Remove this portfolio item?")) return;
      button.disabled = true;
      try {
        await rpc("portfolio_item_delete", { p_id: button.dataset.itemRemove });
        toast({ title: "Item removed" }, { tone: "warning" });
        await render(root);
      } catch (error) {
        button.disabled = false;
        toastError(error);
      }
    });
  }

  on(qs("#pf-item-form", root), "submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget || event.target;
    const data = readForm(form);
    const button = form.querySelector("button[type=submit]");
    button.disabled = true;
    try {
      await rpc("portfolio_item_save", {
        p_id: null,
        p_title: data.title,
        p_summary: data.summary || null,
        p_url: data.url || null,
        p_image_url: data.image_url || null,
        p_skills: skills(data.skills),
        p_completed_on: data.completed_on || null,
        p_sort_order: items.length
      });
      toast({ title: "Portfolio item added" });
      await render(root);
    } catch (error) {
      button.disabled = false;
      toastError(error);
    }
  });

}

async function saveExperience(root, formToReset = null) {
  try {
    await rpc("agent_save_portfolio_profile", {
      p_resume_url: profile.resume_url || null,
      p_experience: experience,
      p_social_links: socials,
      p_languages: profile.languages || [],
      p_timezone: profile.timezone || null
    });
    profile = { ...profile, experience };
    const box = qs("#pf-exp", root);
    if (box) box.innerHTML = experienceList();
    formToReset?.reset();
    toast({ title: "Work history updated" });
  } catch (error) {
    toastError(error);
  }
}
