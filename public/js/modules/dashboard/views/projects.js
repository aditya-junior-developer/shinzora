/* ==========================================================================
   Shinzora — Projects
   Every generated website, application and storefront, with status, version
   count and the publish state read from the database.
   ========================================================================== */

import { qs, qsa, esc, delegate } from "../../../lib/dom.js";
import { icon } from "../../../lib/icons.js";
import { timeAgo, statusLabel } from "../../../lib/format.js";
import { sb, normalizeError } from "../../../lib/supabase.js";
import { projects as fetchProjects, isSchemaMissing } from "../data.js";
import { pageHead, statusBadge, emptyState, setupNotice, skeletonView, metaRow } from "../components.js";
import { confirmDialog, formDialog } from "../../../ui/modal.js";
import { toast, toastError } from "../../../ui/toast.js";

const TYPE_ICON = { website: "panels-top-left", app: "blocks", store: "store" };
const TYPE_LABEL = { website: "Website", app: "Application", store: "Online store" };

const FILTERS = [
  { id: "all", label: "All" },
  { id: "website", label: "Websites" },
  { id: "app", label: "Applications" },
  { id: "store", label: "Stores" },
  { id: "published", label: "Published" },
  { id: "draft", label: "Drafts" }
];

let activeFilter = "all";
let cache = [];

export default async function render(root, ctx) {
  root.innerHTML = skeletonView(4);

  try {
    const { data } = await fetchProjects({ limit: 100 });
    cache = data;
  } catch (error) {
    root.innerHTML = `${pageHead({ title: "Projects" })}${setupNotice(error, "The project list")}`;
    return;
  }

  root.innerHTML = `
    ${pageHead({
      title: "Projects",
      desc: "Websites, applications and stores generated in this workspace. Versions are kept so you can always roll back.",
      actions: `<a class="btn btn-primary btn-sm" href="/app/?view=website-builder">${icon("plus", { size: 14 })}New project</a>`
    })}
    <div class="toolbar">
      <div class="row gap-2 wrap" id="project-filters">
        ${FILTERS.map(
          (filter) =>
            `<button class="chip ${filter.id === activeFilter ? "is-active" : ""}" data-filter="${filter.id}">${esc(filter.label)}</button>`
        ).join("")}
      </div>
      <div class="toolbar-spacer"></div>
      <div class="toolbar-search">
        ${icon("search", { size: 14 })}
        <input class="input" id="project-search" placeholder="Search projects" aria-label="Search projects" />
      </div>
    </div>
    <div id="project-grid"></div>`;

  paintGrid();

  delegate(qs("#project-filters"), "click", "[data-filter]", (event, node) => {
    activeFilter = node.getAttribute("data-filter");
    qsa("#project-filters .chip").forEach((chip) => chip.classList.toggle("is-active", chip === node));
    paintGrid();
  });

  qs("#project-search").addEventListener("input", paintGrid);

  delegate(qs("#project-grid"), "click", "[data-delete]", async (event, node) => {
    event.preventDefault();
    const id = node.getAttribute("data-delete");
    const project = cache.find((row) => row.id === id);
    const ok = await confirmDialog({
      title: "Delete this project?",
      desc: `“${project?.name || "This project"}” and all of its versions will be permanently removed. Published sites stop serving immediately.`,
      confirmLabel: "Delete project",
      tone: "danger"
    });
    if (!ok) return;
    try {
      const { error } = await sb.from("projects").delete().eq("id", id);
      if (error) throw normalizeError(error);
      cache = cache.filter((row) => row.id !== id);
      paintGrid();
      toast({ title: "Project deleted" }, { tone: "success" });
    } catch (error) {
      toastError(normalizeError(error));
    }
  });

  /* Renaming touches the name and nothing else: the slug, the versions, the
     published site and every file stay exactly as they were. */
  delegate(qs("#project-grid"), "click", "[data-rename]", async (event, node) => {
    event.preventDefault();
    const id = node.getAttribute("data-rename");
    const project = cache.find((row) => row.id === id);
    const values = await formDialog({
      title: "Rename project",
      desc: "Only the display name changes. The versions, the files and the public URL stay the same.",
      fields: [{ name: "name", label: "Project name", type: "text", value: project?.name || "", required: true, maxlength: 80 }],
      submitLabel: "Save name"
    });
    if (!values) return;
    const name = String(values.name || "").trim();
    if (name.length < 2) return toast({ title: "Use at least two characters" }, { tone: "warning" });
    try {
      const { error } = await sb.from("projects").update({ name }).eq("id", id);
      if (error) throw normalizeError(error);
      const row = cache.find((item) => item.id === id);
      if (row) row.name = name;
      paintGrid();
      toast({ title: "Project renamed", message: `Now called “${name}”.` }, { tone: "success" });
    } catch (error) {
      toastError(normalizeError(error));
    }
  });

  delegate(qs("#project-grid"), "click", "[data-unpublish]", async (event, node) => {
    event.preventDefault();
    const id = node.getAttribute("data-unpublish");
    try {
      const { error } = await sb.from("projects").update({ status: "ready", published_at: null }).eq("id", id);
      if (error) throw normalizeError(error);
      toast({ title: "Project unpublished", message: "The public URL no longer serves this project." }, { tone: "success" });
      ctx.refresh();
    } catch (error) {
      toastError(normalizeError(error));
    }
  });

  function paintGrid() {
    const term = (qs("#project-search")?.value || "").toLowerCase();
    const rows = cache.filter((row) => {
      const byFilter =
        activeFilter === "all" ? true : ["published", "draft"].includes(activeFilter) ? row.status === activeFilter : row.type === activeFilter;
      const bySearch = !term || `${row.name} ${row.description || ""}`.toLowerCase().includes(term);
      return byFilter && bySearch;
    });

    const host = qs("#project-grid");
    if (!rows.length) {
      host.innerHTML = emptyState({
        icon: "folder-git-2",
        title: cache.length ? "No projects match that filter" : "No projects yet",
        desc: cache.length
          ? "Try a different filter or search term."
          : "Describe the website, application or store you want. The AI proposes a structure, generates it, and you refine from there.",
        action: cache.length
          ? ""
          : `<a class="btn btn-primary btn-sm" href="/app/?view=website-builder">${icon("sparkles", { size: 14 })}Generate a website</a>
             <a class="btn btn-secondary btn-sm" href="/app/?view=app-builder">${icon("blocks", { size: 14 })}Build an application</a>`
      });
      return;
    }

    host.innerHTML = `<div class="grid-3">${rows
      .map((project) => {
        const builder =
          project.type === "app" ? "/app/?view=app-builder" : project.type === "store" ? "/app/?view=website-builder" : "/app/?view=website-builder";
        return `<article class="project-card">
          <div class="project-thumb">
            ${icon(TYPE_ICON[project.type] || "folder", { size: 26 })}
            <span class="thumb-tag">${statusBadge(project.status)}</span>
          </div>
          <div>
            <div class="project-name truncate">${esc(project.name)}</div>
            <p class="project-desc">${esc(project.description || "No description yet.")}</p>
          </div>
          ${metaRow([
            `<span>${esc(TYPE_LABEL[project.type] || project.type)}</span>`,
            project.version_count ? `<span>${project.version_count} versions</span>` : "",
            `<span>${esc(timeAgo(project.updated_at))}</span>`
          ])}
          ${
            project.slug
              ? `<div class="copy-row"><span class="inline-code">${esc(project.slug)}</span>
                  <button class="btn btn-ghost btn-sm" data-copy="${esc(publicUrl(project))}">${icon("copy", { size: 12 })}Copy URL</button></div>`
              : ""
          }
          <div class="project-actions">
            <a class="btn btn-secondary btn-sm" href="${builder}?id=${esc(project.id)}">${icon("square-pen", { size: 13 })}Open</a>
            <button class="btn btn-ghost btn-sm" data-rename="${esc(project.id)}">${icon("pencil", { size: 13 })}Rename</button>
            ${
              project.status === "published" && project.slug
                ? `<a class="btn btn-ghost btn-sm" href="/site/?p=${esc(project.slug)}" target="_blank" rel="noopener">${icon("external-link", { size: 13 })}View site</a>
                   <button class="btn btn-ghost btn-sm" data-unpublish="${esc(project.id)}">Unpublish</button>`
                : `<span class="badge badge-neutral">${esc(statusLabel(project.status))}</span>`
            }
            <button class="btn btn-ghost btn-sm btn-icon" data-delete="${esc(project.id)}" aria-label="Delete project" style="margin-left:auto">${icon("trash-2", { size: 13 })}<span class="btn-word">Delete</span></button>
          </div>
        </article>`;
      })
      .join("")}</div>`;
  }

  function publicUrl(project) {
    return `${location.origin}/site/?p=${project.slug}`;
  }

  void isSchemaMissing;
}
