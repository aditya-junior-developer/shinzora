// ============================================================================
// Shinzora · Edge Function `site`
// ----------------------------------------------------------------------------
// Public read used by /site/?p=<slug>. Returns the published version's files so
// the renderer can display a site without exposing the owner's session or the
// unpublished drafts.
//
//   GET|POST /functions/v1/site  { slug }   (no JWT required)
//
// Deploy with: supabase functions deploy site --no-verify-jwt
// ============================================================================

import { clean, fail, json, preflight, readBody } from "../_shared/http.ts";
import { admin } from "../_shared/auth.ts";

Deno.serve(async (req) => {
  const options = preflight(req);
  if (options) return options;

  const body = await readBody<Record<string, unknown>>(req);
  const url = new URL(req.url);
  const slug = clean(body.slug ?? url.searchParams.get("p"), 120).toLowerCase();

  if (!slug) return fail(400, "invalid_input", "A project slug is required.");

  try {
    const supabase = admin();
    const { data: project, error } = await supabase
      .from("projects")
      .select("id, name, description, type, slug, status, published_version_id, published_at, owner_id")
      .eq("slug", slug)
      .eq("status", "published")
      .maybeSingle();

    if (error) return fail(500, "site_error", "Could not read the published project.");
    if (!project || !project.published_version_id) {
      return fail(404, "not_found", "This site is not published, or the address is wrong.");
    }

    const { data: version, error: versionError } = await supabase
      .from("project_versions")
      .select("files, meta, version_number, created_at")
      .eq("id", project.published_version_id)
      .maybeSingle();

    if (versionError) return fail(500, "site_error", "Could not read the published version.");
    if (!version) return fail(404, "not_found", "The published version is missing.");

    const meta = (version.meta ?? {}) as Record<string, unknown>;

    // Branding is decided server-side from the owner's live subscription, never
    // from anything the browser sends. Upgrading removes the badge on the next
    // request; downgrading brings it back. A missing subscription row is treated
    // as Free, which is the safe default.
    const { data: subscription } = await supabase
      .from("subscriptions")
      .select("plan, status")
      .eq("user_id", project.owner_id)
      .maybeSingle();

    const plan = typeof subscription?.plan === "string" ? subscription.plan : "free";
    const paid = plan === "pro" || plan === "enterprise";

    return json(
      {
        project: {
          name: project.name,
          description: project.description,
          type: project.type,
          slug: project.slug,
          published_at: project.published_at
        },
        entry: (meta.entry as string) || "index.html",
        files: version.files ?? {},
        seo: meta.seo ?? null,
        pages: meta.pages ?? [],
        version: version.version_number,
        updated_at: version.created_at,
        branding: {
          required: !paid,
          plan,
          label: "Made with Shinzora"
        }
      },
      200,
      { "Cache-Control": "public, max-age=60, stale-while-revalidate=300" }
    );
  } catch (error) {
    console.error("site error", (error as Error).message);
    return fail(500, "site_error", "The published site could not be loaded.");
  }
});
