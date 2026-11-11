/* ==========================================================================
   Shinzora — DOM utilities
   Tiny helpers used by every view. No framework, no virtual DOM: views build
   strings and attach delegated listeners, which keeps bundles small and the
   mental model obvious.
   ========================================================================== */

/**
 * Escape text for safe interpolation into HTML templates.
 * Used for every value that originates from a database row, a URL parameter
 * or user input. Never interpolate raw strings into templates.
 */
export function esc(value) {
  if (value === null || value === undefined) return "";
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Tagged template that escapes every interpolated value unless wrapped in raw(). */
export class Raw {
  constructor(value) {
    this.value = value;
  }
  toString() {
    return this.value;
  }
}
export const raw = (value) => new Raw(value);

export function html(strings, ...values) {
  return strings.reduce((out, str, i) => {
    const v = values[i - 1];
    let chunk = "";
    if (v !== undefined && v !== null && v !== false) {
      if (v instanceof Raw) chunk = v.value;
      else if (Array.isArray(v)) chunk = v.map((x) => (x instanceof Raw ? x.value : esc(x))).join("");
      else chunk = esc(v);
    }
    return out + chunk + str;
  });
}

export const qs = (sel, root = document) => root.querySelector(sel);

/**
 * Write HTML into a node that may no longer exist.
 *
 * A view's async load can finish after the user has navigated away, at which
 * point the container it wanted to fill is gone. `qs("#x").innerHTML = …` then
 * throws "Cannot set properties of null" and takes the whole render with it.
 * This writes when the node is there and stays quiet when it is not.
 */
export function safeSet(sel, html, root = document) {
  const node = root.querySelector(sel);
  if (!node) return false;
  node.innerHTML = html;
  return true;
}
export const qsa = (sel, root = document) => Array.from(root.querySelectorAll(sel));

/** Create an element from a tag, attribute map and children. */
export function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value === null || value === undefined || value === false) continue;
    if (key === "class") node.className = value;
    else if (key === "html") node.innerHTML = value;
    else if (key === "text") node.textContent = value;
    else if (key.startsWith("on") && typeof value === "function") {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (key === "dataset") {
      Object.assign(node.dataset, value);
    } else if (value === true) node.setAttribute(key, "");
    else node.setAttribute(key, value);
  }
  for (const child of [].concat(children)) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

/** Event delegation: bind once on a container, match descendants by selector. */
export function delegate(root, eventName, selector, handler) {
  /* A surface that is not on this page is not an error: Community has no groups
     column, so its handlers simply have nowhere to bind. */
  if (!root) return () => {};
  const listener = (event) => {
    const target = event.target instanceof Element ? event.target.closest(selector) : null;
    if (target && root.contains(target)) handler(event, target);
  };
  root.addEventListener(eventName, listener);
  return () => root.removeEventListener(eventName, listener);
}

export function on(node, eventName, handler, options) {
  if (!node) return () => {};
  node.addEventListener(eventName, handler, options);
  return () => node.removeEventListener(eventName, handler, options);
}

export function clear(node) {
  while (node && node.firstChild) node.removeChild(node.firstChild);
  return node;
}

export function setHTML(node, markup) {
  if (node) node.innerHTML = markup;
  return node;
}

/** Simple class toggler. */
export function toggleClass(node, className, force) {
  if (!node) return;
  if (force === undefined) node.classList.toggle(className);
  else node.classList.toggle(className, Boolean(force));
}

/** Trap focus inside a container (modals, drawers). Returns a disposer. */
export function trapFocus(container) {
  const selector =
    'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
  const onKeydown = (event) => {
    if (event.key !== "Tab") return;
    const items = qsa(selector, container).filter((n) => n.offsetParent !== null);
    if (!items.length) return;
    const first = items[0];
    const last = items[items.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };
  container.addEventListener("keydown", onKeydown);
  const firstField = qsa(selector, container)[0];
  if (firstField) firstField.focus({ preventScroll: true });
  return () => container.removeEventListener("keydown", onKeydown);
}

/** Debounce, used for search inputs and resize handlers. */
export function debounce(fn, wait = 220) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  };
}

/** Copy text to clipboard with a graceful fallback for insecure contexts. */
export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.cssText = "position:fixed;opacity:0;pointer-events:none";
    document.body.append(area);
    area.select();
    let ok = false;
    try {
      ok = document.execCommand("copy");
    } catch {
      ok = false;
    }
    area.remove();
    return ok;
  }
}

/** Read a query-string parameter. */
export function param(name, fallback = null) {
  return new URLSearchParams(location.search).get(name) ?? fallback;
}

/** Absolute URL for a path within the current origin. */
export function siteUrl(path = "/") {
  return new URL(path, location.origin).toString();
}
