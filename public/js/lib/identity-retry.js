/* ==========================================================================
   Shinzora — session resolution that survives a bad minute
   --------------------------------------------------------------------------
   `sb.auth.getSession()` rejects for two very different reasons and the old
   code treated them the same:

     network     the request never arrived (offline, flaky connection, a cold
                 auth endpoint). The session is almost certainly fine, and a
                 second attempt usually returns it. Signing the user out here
                 would be a lie.

     auth        the stored refresh token is genuinely dead (revoked, expired,
                 rotated by another device). Retrying changes nothing; the
                 right move is a clean sign-in.

   The dashboard used to funnel both into a silent return from boot, which
   left a permanently blank shell — no navigation, no message, nothing to
   click. Distinguishing the two is what makes recovering possible.
   ========================================================================== */

/* supabase-js retries an expired token internally with backoff. When the
   network is down that promise can sit unresolved for a long time — the
   reported "empty dashboard" was a boot overlay that never went away because
   the session lookup never answered. A lookup is now given a hard deadline. */
export const SESSION_LOOKUP_LIMIT_MS = 6000;

/** Reject if `work` has not settled within `ms`. */
export function withDeadline(work, ms = SESSION_LOOKUP_LIMIT_MS, label = "The session check") {
  let timer = 0;
  const limit = new Promise((_resolve, reject) => {
    timer = setTimeout(() => {
      const error = new Error(`${label} timed out after ${Math.round(ms / 1000)}s.`);
      error.name = "TimeoutError";
      reject(error);
    }, ms);
  });
  return Promise.race([Promise.resolve(work), limit]).finally(() => clearTimeout(timer));
}

/** @returns {"network"|"auth"|"unknown"} */
export function classifySessionError(error) {
  if (!error) return "unknown";
  const status = Number(error.status || error.statusCode || error.status_code || 0);
  const name = String(error.name || "");
  const message = String(error.message || error.error_description || error.msg || error);

  if (name === "AuthRetryableFetchError" || name === "AbortError" || name === "TimeoutError") return "network";
  if (/failed to fetch|networkerror|network error|load failed|timed out|timeout|offline|connection/i.test(message)) {
    return "network";
  }
  if (/invalid refresh token|refresh token not found|refresh_token_not_found|invalid_grant|jwt expired|token has expired|session_not_found|session from session_id claim in JWT does not exist/i.test(message)) {
    return "auth";
  }
  if (status === 400 || status === 401 || status === 403) return "auth";
  if (status >= 500 || status === 0) return "network";
  return "unknown";
}

/**
 * Run `work`, retrying the failures that are worth retrying.
 *
 * @param {(attempt:number)=>Promise<any>} work
 * @param {{attempts?:number, delayMs?:number, shouldRetry?:(e:Error)=>boolean, wait?:(ms:number)=>Promise<void>}} options
 */
export async function withRetry(work, options = {}) {
  const { attempts = 2, delayMs = 350, shouldRetry = () => true, wait } = options;
  const sleep = wait || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  let lastError;
  for (let attempt = 1; attempt <= Math.max(1, attempts); attempt += 1) {
    try {
      return await work(attempt);
    } catch (error) {
      lastError = error;
      if (attempt >= attempts || !shouldRetry(error)) throw error;
      await sleep(delayMs);
    }
  }
  throw lastError;
}

/** Session lookups retry a dropped connection, never a dead token. */
export const retrySession = (work, options = {}) =>
  withRetry(work, {
    attempts: 2,
    delayMs: 400,
    shouldRetry: (error) => classifySessionError(error) !== "auth",
    ...options
  });
