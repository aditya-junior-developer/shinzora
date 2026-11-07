/* ==========================================================================
   Shinzora — dashboard entry
   Guard the route, hydrate identity, build the shell, then start the router.
   ========================================================================== */

import { hydrateIcons } from "../lib/icons.js";
import { qs, param } from "../lib/dom.js";
import { requireSession, watchSession, logoutEverywhere } from "../lib/guard.js";
import { loadIdentity, state } from "../lib/store.js";
import { renderSidebar, paintIdentity, bindChrome, subscribeNotifications, refreshNotificationBadge } from "../modules/dashboard/shell.js";
import { start as startRouter, currentView } from "../modules/dashboard/router.js";
import { initInstallPrompt } from "../ui/pwa.js";
import { toast } from "../ui/toast.js";

hydrateIcons();

(async () => {
  const { ok } = await requireSession({ next: location.pathname + location.search });
  if (!ok) return;

  await loadIdentity({ force: true });

  const initialView = new URLSearchParams(location.search).get("view") || "overview";
  renderSidebar(initialView);
  paintIdentity();
  hydrateIcons();

  bindChrome({ navigate: (view) => (location.href = `/app/?view=${view}`) });

  window.addEventListener("shinzora:view", (event) => {
    renderSidebar(event.detail.view);
    hydrateIcons();
  });

  await startRouter();
  hydrateIcons();

  refreshNotificationBadge();
  subscribeNotifications();
  watchSession(() => logoutEverywhere());
  initInstallPrompt();

  // Contextual first-run messages
  if (param("welcome")) {
    toast(
      { title: "Your workspace is ready", message: "Start with the AI builder or ask the assistant anything." },
      { tone: "success", duration: 6000 }
    );
  }
  if (param("view") === "billing" && param("plan")) {
    toast({ title: "Plan selected", message: "Complete the payment below to activate it." }, { tone: "info" });
  }
  void currentView;
  void state;
})();
