/* ==========================================================================
   Reading JSON out of a model's answer
   --------------------------------------------------------------------------
   Asking for `responseMimeType: application/json` gets valid JSON almost every
   time — but "almost" is not a guarantee, and every one of these has been seen
   in production:

     • the whole answer wrapped in ```json fences
     • a sentence before or after the object ("Here is the command: {…}. Let me
       know if …")
     • a trailing comma the model added for readability
     • curly quotes pasted into a JSON string
     • the answer cut off mid-object because the output budget ran out

   The last one cannot be repaired, and pretending otherwise would hand a
   half-parsed command to the user. Everything else can, so this module does the
   repairs it can prove and reports the rest honestly.

   No Deno APIs are used on purpose: this file is imported by the Edge Function
   and unit-tested from Node.
   ========================================================================== */

const FENCE = /```(?:json|JSON|javascript|js)?\s*([\s\S]*?)```/;

/** Remove the wrappers that are never part of the value itself. */
export function unwrap(text: string): string {
  let out = String(text ?? "").replace(/^\uFEFF/, "").trim();
  const fenced = out.match(FENCE);
  if (fenced?.[1]) out = fenced[1].trim();
  return out;
}

/** Cheap repairs for mistakes that carry no ambiguity. */
export function repair(text: string): string {
  return text
    /* curly quotes only ever appear inside strings here, so straightening them
       cannot change the structure */
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2018\u2019]/g, "'")
    /* a comma before a closing bracket is always a mistake in JSON */
    .replace(/,\s*([}\]])/g, "$1")
    /* trailing whitespace between tokens is harmless; inside strings it is not,
       which is why nothing else is touched */
    .trim();
}

/**
 * Walk the text and return the first complete JSON object or array.
 *
 * A depth counter that understands strings is required: braces inside a product
 * description ("{large}") must not be mistaken for structure, and a truncated
 * answer must return null rather than a plausible-looking fragment.
 */
export function firstJsonValue(text: string): { ok: true; value: unknown } | { ok: false; reason: string } {
  const source = repair(unwrap(text));
  const start = source.search(/[[{]/);
  if (start === -1) return { ok: false, reason: "The answer contained no JSON at all." };

  const open = source[start];
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = start; index < source.length; index += 1) {
    const char = source[index];

    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }

    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === open) depth += 1;
    else if (char === close) {
      depth -= 1;
      if (depth === 0) {
        const candidate = source.slice(start, index + 1);
        try {
          return { ok: true, value: JSON.parse(candidate) };
        } catch {
          /* the slice was balanced but not valid — try the next opening brace */
          return scanFrom(source, index + 1);
        }
      }
    }
  }

  return { ok: false, reason: "The answer stopped mid-JSON, so it was incomplete." };
}

function scanFrom(source: string, offset: number): { ok: true; value: unknown } | { ok: false; reason: string } {
  const rest = source.slice(offset);
  if (!/[[{]/.test(rest)) return { ok: false, reason: "The answer contained no complete JSON object." };
  const next = firstJsonValue(rest);
  return next;
}

/** Parse a model answer into JSON, or say exactly why it could not be read. */
export function parseModelJson<T = unknown>(text: string): { ok: true; value: T } | { ok: false; reason: string } {
  if (String(text ?? "").trim() === "") return { ok: false, reason: "The AI returned nothing." };

  /* The common case first: the answer is already exactly JSON. */
  const direct = unwrap(text);
  try {
    return { ok: true, value: JSON.parse(direct) as T };
  } catch {
    /* fall through to the tolerant path */
  }

  const found = firstJsonValue(text);
  return found.ok ? { ok: true, value: found.value as T } : found;
}
