// ============================================================================
// Shinzora · Edge Function `config`
// ----------------------------------------------------------------------------
// Public, unauthenticated read of the deployment's provider state. It returns
// booleans and model names only — never a key, token or secret.
//
//   GET /functions/v1/config
// ============================================================================

import { CORS, json, preflight } from "../_shared/http.ts";
import { providerFlags } from "../_shared/config.ts";

Deno.serve((req) => {
  const options = preflight(req);
  if (options) return options;

  if (req.method !== "GET" && req.method !== "POST") {
    return json({ code: "method_not_allowed", error: "Use GET." }, 405);
  }

  return json(providerFlags(), 200, {
    "Cache-Control": "public, max-age=60",
    "Access-Control-Allow-Origin": CORS["Access-Control-Allow-Origin"]
  });
});
