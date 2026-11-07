/* ==========================================================================
   Shinzora — offline page
   --------------------------------------------------------------------------
   This lives in its own file rather than inline in offline.html because the
   app's Content-Security-Policy is `script-src 'self' 'unsafe-eval'`: inline
   <script> blocks and inline handlers such as onclick are blocked, so the
   previous version never ran and the retry button did nothing.
   ========================================================================== */

const status = document.getElementById("net-status");
const retry = document.getElementById("retry");

function paint() {
  if (!navigator.onLine) return;
  status?.classList.add("online");
  if (status) status.innerHTML = "<i></i> Back online — reloading";
  setTimeout(() => location.reload(), 1200);
}

window.addEventListener("online", paint);
window.addEventListener("offline", () => {
  status?.classList.remove("online");
  if (status) status.innerHTML = "<i></i> Waiting for the network";
});

retry?.addEventListener("click", () => location.reload());

paint();
