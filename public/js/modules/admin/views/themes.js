/* ==========================================================================
   Admin · Theme collections and wallpapers (P10)
   Collections and wallpapers are deactivated, never deleted, so a member's
   saved choice and the audit trail keep pointing at real rows. Changing a
   collection's tier or deactivating anything needs a reason, which is written
   to the audit log. Every write goes through the admin Edge Function.
   ========================================================================== */

import { qs, esc, delegate, safeSet } from "../../../lib/dom.js";
import { icon } from "../../../lib/icons.js";
import { adminApi } from "../api.js";
import { confirmDialog, formDialog } from "../../../ui/modal.js";
import { toast, toastError } from "../../../ui/toast.js";

const TIER_OPTIONS = [
  { value: "", label: "Free for every member" },
  { value: "glow", label: "Glow (₹99)" },
  { value: "elite", label: "Elite (₹199)" }
];

const tierLabel = (tier) => (tier === "elite" ? "Elite" : tier === "glow" ? "Glow" : "Free");

export default async function render(root) {
  let data = { collections: [], wallpapers: [] };

  root.innerHTML = `
    <div class="admin-head">
      <div>
        <h1>Themes</h1>
        <p>
          Collections and wallpapers members can choose in Settings. A collection's tier links it to a Premium profile.
          Raising a tier or deactivating an item hides it from members at once, and their saved choice falls back to the default.
        </p>
      </div>
      <div class="admin-filters">
        <button class="btn btn-ghost btn-sm" id="theme-new-collection">${icon("plus", { size: 13 })}New collection</button>
        <button class="btn btn-primary btn-sm" id="theme-new-wallpaper">${icon("plus", { size: 13 })}New wallpaper</button>
      </div>
    </div>
    <div class="admin-card">
      <div class="admin-card-head">
        <div>
          <div class="admin-card-title">Collections</div>
          <div class="admin-card-sub" id="theme-count">Loading…</div>
        </div>
      </div>
      <div id="theme-collections"></div>
    </div>
    <div class="admin-card">
      <div class="admin-card-head">
        <div>
          <div class="admin-card-title">Wallpapers</div>
          <div class="admin-card-sub">Original artwork only. Images must be a Shinzora theme path or an https address.</div>
        </div>
      </div>
      <div id="theme-wallpapers"></div>
    </div>`;

  qs("#theme-new-collection").addEventListener("click", () => editCollection(null));
  qs("#theme-new-wallpaper").addEventListener("click", () => editWallpaper(null));

  delegate(root, "click", "[data-edit-collection]", (_e, node) =>
    editCollection(data.collections.find((c) => c.id === node.getAttribute("data-edit-collection")))
  );
  delegate(root, "click", "[data-edit-wallpaper]", (_e, node) =>
    editWallpaper(data.wallpapers.find((w) => w.id === node.getAttribute("data-edit-wallpaper")))
  );
  delegate(root, "click", "[data-toggle]", (_e, node) => {
    const [kind, id] = node.getAttribute("data-toggle").split(":");
    toggleActive(kind, id);
  });

  await load();

  async function load() {
    try {
      data = await adminApi.themes({ op: "list" });
      paint();
    } catch (error) {
      safeSet("#theme-collections", `<div class="admin-empty">${esc(error.message)}</div>`);
    }
  }

  function paint() {
    const active = data.collections.filter((c) => c.active).length;
    qs("#theme-count").textContent = `${data.collections.length} collections · ${active} active`;

    safeSet(
      "#theme-collections",
      data.collections.length
        ? `<div class="table-wrap"><table class="table"><thead><tr>
            <th>Collection</th><th>Tier</th><th>Wallpapers</th><th>Status</th><th></th>
          </tr></thead><tbody>${data.collections
            .map((c) => {
              const count = data.wallpapers.filter((w) => w.collection_id === c.id).length;
              return `<tr>
                <td><div>${esc(c.name)}</div><div class="dim" style="font-size:var(--fs-xs)">${esc(c.id)}</div></td>
                <td>${esc(tierLabel(c.required_tier))}</td>
                <td>${count}</td>
                <td><span class="badge ${c.active ? "badge-ok" : "badge-neutral"}">${c.active ? "Active" : "Inactive"}</span></td>
                <td><div class="row gap-2">
                  <button class="btn btn-ghost btn-sm" data-edit-collection="${esc(c.id)}">Edit</button>
                  <button class="btn btn-ghost btn-sm" data-toggle="collection:${esc(c.id)}">${c.active ? "Deactivate" : "Activate"}</button>
                </div></td>
              </tr>`;
            })
            .join("")}</tbody></table></div>`
        : `<div class="admin-empty">No collections yet.</div>`
    );

    safeSet(
      "#theme-wallpapers",
      data.wallpapers.length
        ? `<div class="table-wrap"><table class="table"><thead><tr>
            <th>Preview</th><th>Title</th><th>Collection</th><th>Image</th><th>Status</th><th></th>
          </tr></thead><tbody>${data.wallpapers
            .map((w) => {
              const collection = data.collections.find((c) => c.id === w.collection_id);
              return `<tr>
                <td><img src="${esc(w.image_url)}" alt="" width="96" height="54" loading="lazy" style="border-radius:8px;object-fit:cover;display:block"></td>
                <td>${esc(w.title)}</td>
                <td>${esc(collection?.name || w.collection_id)}</td>
                <td class="mono" style="font-size:var(--fs-xs);word-break:break-all">${esc(w.image_url)}</td>
                <td><span class="badge ${w.active ? "badge-ok" : "badge-neutral"}">${w.active ? "Active" : "Inactive"}</span></td>
                <td><div class="row gap-2">
                  <button class="btn btn-ghost btn-sm" data-edit-wallpaper="${esc(w.id)}">Edit</button>
                  <button class="btn btn-ghost btn-sm" data-toggle="wallpaper:${esc(w.id)}">${w.active ? "Deactivate" : "Activate"}</button>
                </div></td>
              </tr>`;
            })
            .join("")}</tbody></table></div>`
        : `<div class="admin-empty">No wallpapers yet.</div>`
    );
  }

  async function editCollection(existing) {
    const isNew = !existing;
    const values = await formDialog({
      title: isNew ? "New collection" : `Edit ${existing.name}`,
      desc: isNew
        ? "The id is permanent and is used in links, so choose it carefully."
        : "Changing the tier affects every member who chose a wallpaper in this collection.",
      fields: [
        ...(isNew
          ? [{ name: "id", label: "Id (lower case, hyphens)", required: true, maxlength: 41, value: "" }]
          : []),
        { name: "name", label: "Name", required: true, maxlength: 60, value: existing?.name ?? "" },
        { name: "description", label: "Description", type: "textarea", maxlength: 280, value: existing?.description ?? "" },
        { name: "requiredTier", label: "Who can use it", type: "select", options: TIER_OPTIONS, value: existing?.required_tier ?? "" },
        { name: "sortOrder", label: "Order (lower first)", type: "number", value: existing?.sort_order ?? 0 },
        { name: "reason", label: "Reason (required for a tier change)", maxlength: 400, value: "" }
      ],
      submitLabel: isNew ? "Create collection" : "Save collection"
    });
    if (!values) return;
    const payload = {
      op: "save_collection",
      id: isNew ? values.id : existing.id,
      name: values.name,
      description: values.description,
      requiredTier: values.requiredTier || null,
      sortOrder: Number(values.sortOrder) || 0,
      reason: values.reason
    };
    try {
      await adminApi.themes(payload);
      toast({ title: isNew ? "Collection created" : "Collection saved" }, { tone: "success" });
      await load();
    } catch (error) {
      toastError(error);
    }
  }

  async function editWallpaper(existing) {
    const isNew = !existing;
    const values = await formDialog({
      title: isNew ? "New wallpaper" : `Edit ${existing.title}`,
      desc: "Use original artwork. The image path must be /assets/themes/<file>.svg, or an https address.",
      fields: [
        { name: "collectionId", label: "Collection", type: "select", options: data.collections.map((c) => ({ value: c.id, label: c.name })), value: existing?.collection_id ?? data.collections[0]?.id ?? "" },
        { name: "title", label: "Title", required: true, maxlength: 60, value: existing?.title ?? "" },
        { name: "imageUrl", label: "Image", required: true, maxlength: 500, value: existing?.image_url ?? "/assets/themes/" },
        { name: "sortOrder", label: "Order (lower first)", type: "number", value: existing?.sort_order ?? 0 }
      ],
      submitLabel: isNew ? "Create wallpaper" : "Save wallpaper"
    });
    if (!values) return;
    try {
      await adminApi.themes({
        op: "save_wallpaper",
        id: existing?.id,
        collectionId: values.collectionId,
        title: values.title,
        imageUrl: values.imageUrl,
        sortOrder: Number(values.sortOrder) || 0
      });
      toast({ title: isNew ? "Wallpaper created" : "Wallpaper saved" }, { tone: "success" });
      await load();
    } catch (error) {
      toastError(error);
    }
  }

  async function toggleActive(kind, id) {
    const item = kind === "collection" ? data.collections.find((c) => c.id === id) : data.wallpapers.find((w) => w.id === id);
    if (!item) return;
    const label = kind === "collection" ? item.name : item.title;
    const activating = !item.active;
    let reason = "";
    if (!activating) {
      const values = await formDialog({
        title: `Deactivate ${label}`,
        desc: "Members stop seeing this item. Their saved choice falls back to the default background. Nothing is deleted.",
        fields: [{ name: "reason", label: "Reason (kept in the audit log)", required: true, maxlength: 400 }],
        submitLabel: "Deactivate"
      });
      if (!values) return;
      reason = values.reason;
    } else {
      const ok = await confirmDialog({
        title: `Activate ${label}?`,
        desc: "Members who are allowed to use it will see it again.",
        confirmLabel: "Activate",
        tone: "primary"
      });
      if (!ok) return;
    }
    try {
      await adminApi.themes({ op: "set_active", kind, id, active: activating, reason });
      toast({ title: activating ? "Activated" : "Deactivated" }, { tone: "success" });
      await load();
    } catch (error) {
      toastError(error);
    }
  }
}
