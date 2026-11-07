/* ==========================================================================
   Shinzora — validation
   Client-side rules mirror the database CHECK constraints in
   supabase/migrations. Client validation is for UX only; every rule is
   re-enforced server-side by Postgres constraints, RLS and Edge Functions.
   ========================================================================== */

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i;
const PHONE_RE = /^[+]?[(]?[0-9][0-9\s().-]{6,19}$/;

export const rules = {
  required: (v) => (String(v ?? "").trim().length > 0 ? null : "This field is required."),
  email: (v) => (!v || EMAIL_RE.test(String(v).trim()) ? null : "Enter a valid email address."),
  /* Sign-in only: accepts a full email address, or an account identifier of the
     form `name@host` that is not a routable address (some accounts on this
     deployment are provisioned as identifiers rather than mailboxes). The
     server decides whether the account exists; nothing is trusted client-side. */
  account: (v) => {
    const value = String(v ?? "").trim();
    if (!value) return null;
    if (EMAIL_RE.test(value)) return null;
    if (/^[^\s@]{2,}@[^\s@]{2,}$/.test(value)) return null;
    return "Enter your email address or account name.";
  },
  phone: (v) => (!v || PHONE_RE.test(String(v).trim()) ? null : "Enter a valid phone number."),
  min: (n) => (v) => (!v || String(v).trim().length >= n ? null : `Use at least ${n} characters.`),
  max: (n) => (v) => (!v || String(v).length <= n ? null : `Use ${n} characters or fewer.`),
  password: (v) => {
    const s = String(v ?? "");
    if (s.length < 8) return "Use at least 8 characters.";
    if (!/[a-zA-Z]/.test(s) || !/[0-9]/.test(s)) return "Include at least one letter and one number.";
    return null;
  },
  url: (v) => {
    if (!v) return null;
    try {
      const u = new URL(String(v).trim());
      return ["http:", "https:"].includes(u.protocol) ? null : "Use an http(s) URL.";
    } catch {
      return "Enter a full URL, e.g. https://example.com";
    }
  },
  match: (getOther, message = "Values do not match.") => (v) => (String(v) === String(getOther()) ? null : message),
  oneOf: (list) => (v) => (!v || list.includes(v) ? null : "Choose one of the available options.")
};

/** Validate a single value against an ordered list of rule functions. */
export function validateValue(value, validators = []) {
  for (const fn of validators) {
    const error = fn(value);
    if (error) return error;
  }
  return null;
}

/**
 * Validate a form using a schema of { fieldName: [validators] }.
 * Returns { valid, errors: { fieldName: message } }.
 */
export function validateForm(values, schema) {
  const errors = {};
  for (const [field, validators] of Object.entries(schema)) {
    const error = validateValue(values[field], validators);
    if (error) errors[field] = error;
  }
  return { valid: Object.keys(errors).length === 0, errors };
}

/** Paint validation errors onto a form using [data-field] wrappers. */
export function paintErrors(form, errors = {}) {
  if (!form) return;
  form.querySelectorAll("[data-field]").forEach((field) => {
    const name = field.getAttribute("data-field");
    const message = errors[name];
    const slot = field.querySelector(".field-error");
    field.classList.toggle("invalid", Boolean(message));
    if (slot) slot.innerHTML = message ? `<span>${message}</span>` : "";
    const input = field.querySelector("input, select, textarea");
    if (input) input.setAttribute("aria-invalid", message ? "true" : "false");
  });
}

export function clearErrors(form) {
  paintErrors(form, {});
}

/** Read a form into a plain object, trimming text inputs. */
export function readForm(form) {
  const data = {};
  new FormData(form).forEach((value, key) => {
    if (typeof value === "string") data[key] = value.trim();
    else data[key] = value;
  });
  form.querySelectorAll('input[type="checkbox"]').forEach((input) => {
    data[input.name] = input.checked;
  });
  return data;
}

/** Strip characters that have no business in a filename path. */
export function safeFileName(name = "") {
  return String(name)
    .replace(/[^\w.\- ]+/g, "")
    .replace(/\s+/g, "-")
    .slice(0, 120);
}

/** Basic guard for URLs rendered into href/src attributes. */
export function safeUrl(value, fallback = "") {
  try {
    const url = new URL(String(value), location.origin);
    if (["http:", "https:", "mailto:", "tel:"].includes(url.protocol)) return url.toString();
  } catch {
    /* ignore */
  }
  return fallback;
}
