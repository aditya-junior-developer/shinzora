// ============================================================================
// Shinzora · Edge Function `integrations`  (GitHub + Vercel)
// ----------------------------------------------------------------------------
//   POST /functions/v1/integrations  { action, ... }
//     status              {}                                    → connection state
//     github_connect      { code } | { token }                  → store token
//     github_repos        {}                                    → repositories
//     github_create_repo  { name, private }                     → new repository
//     github_push         { projectId, versionId, repo, branch? } → commit + push
//     vercel_connect      { token }                             → store token
//     vercel_deploy       { projectId, versionId, name? }        → deployment
//     vercel_status       { deploymentId }                       → live status
//
// Honesty rules:
//   • A repo is only reported as pushed when GitHub returns a commit SHA.
//   • A deploy is only reported as successful when Vercel returns READY.
//   • Tokens live in integration_tokens (RLS on, no policies) encrypted with
//     INTEGRATION_ENCRYPTION_KEY when it is set, and never reach the client.
// ============================================================================

import { clean, fail, json, preflight, readBody } from "../_shared/http.ts";
import { admin, getCaller } from "../_shared/auth.ts";

const env = (key: string) => (Deno.env.get(key) ?? "").trim();
const GH = "https://api.github.com";
const VERCEL = "https://api.vercel.com";

/* --------------------------------------------------------------- encryption */
async function cryptoKey(): Promise<CryptoKey | null> {
  const secret = env("INTEGRATION_ENCRYPTION_KEY");
  if (!secret || secret.length < 16) return null;
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
  return crypto.subtle.importKey("raw", hash, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

async function seal(plain: string): Promise<string> {
  const key = await cryptoKey();
  if (!key) return plain;
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(plain));
  const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
  return `enc:v1:${b64(iv)}:${b64(new Uint8Array(cipher))}`;
}

async function unseal(stored: string): Promise<string> {
  if (!stored.startsWith("enc:v1:")) return stored;
  const key = await cryptoKey();
  if (!key) throw new Error("INTEGRATION_ENCRYPTION_KEY is required to read stored tokens.");
  const [, , ivB64, dataB64] = stored.split(":");
  const decode = (b64: string) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: decode(ivB64) }, key, decode(dataB64));
  return new TextDecoder().decode(plain);
}

/* ------------------------------------------------------------------ storage */
async function saveToken(userId: string, provider: "github" | "vercel", token: string, scopes: string[] = [], refreshToken?: string) {
  const sealed = await seal(token);
  const { error } = await admin()
    .from("integration_tokens")
    .upsert(
      { owner_id: userId, provider, access_token: sealed, refresh_token: refreshToken ?? null, scopes, updated_at: new Date().toISOString() },
      { onConflict: "owner_id,provider" }
    );
  if (error) throw new Error(`Could not store the ${provider} token: ${error.message}`);
}

async function loadToken(userId: string, provider: "github" | "vercel"): Promise<string | null> {
  const { data } = await admin()
    .from("integration_tokens")
    .select("access_token")
    .eq("owner_id", userId)
    .eq("provider", provider)
    .maybeSingle();
  if (!data?.access_token) return null;
  return await unseal(data.access_token);
}

async function gh<T>(path: string, token: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${GH}${path}`, {
    ...init,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "Shinzora",
      "Content-Type": "application/json",
      ...(init.headers ?? {})
    }
  });
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`GitHub ${response.status}: ${detail.slice(0, 200)}`);
  }
  return (await response.json()) as T;
}

async function vc<T>(path: string, token: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${VERCEL}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(init.headers ?? {})
    }
  });
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Vercel ${response.status}: ${detail.slice(0, 200)}`);
  }
  return (await response.json()) as T;
}

/* -------------------------------------------------------------------- serve */
Deno.serve(async (req) => {
  const options = preflight(req);
  if (options) return options;
  if (req.method !== "POST") return fail(405, "method_not_allowed", "Use POST.");

  const caller = await getCaller(req);
  if (!caller) return fail(401, "not_authenticated", "Sign in to connect integrations.");

  const body = await readBody<Record<string, unknown>>(req);
  const action = clean(body.action, 40);
  const userId = caller.user.id;

  try {
    switch (action) {
      case "status":
        return await status(userId);
      case "github_connect":
        return await githubConnect(userId, body);
      case "github_repos":
        return await githubRepos(userId);
      case "github_create_repo":
        return await githubCreateRepo(userId, body);
      case "github_push":
        return await githubPush(userId, body);
      case "vercel_connect":
        return await vercelConnect(userId, body);
      case "vercel_deploy":
        return await vercelDeploy(userId, body);
      case "vercel_status":
        return await vercelStatus(userId, body);
      default:
        return fail(400, "unknown_action", "Unknown integrations action.");
    }
  } catch (error) {
    const message = (error as Error).message || "Integration request failed.";
    console.error("integrations error", message);
    return fail(502, "integration_error", message.slice(0, 300));
  }
});

async function status(userId: string) {
  const { data: rows } = await admin()
    .from("integrations")
    .select("provider, account_name, scopes, connected_at, meta")
    .eq("owner_id", userId);

  const byProvider = Object.fromEntries((rows ?? []).map((row) => [row.provider, row]));

  return json({
    configured: {
      github: Boolean(env("GITHUB_CLIENT_ID") && env("GITHUB_CLIENT_SECRET")) || Boolean(env("GITHUB_TOKEN")),
      vercel: Boolean(env("VERCEL_TOKEN"))
    },
    connected: {
      github: byProvider.github
        ? { account: byProvider.github.account_name, scopes: byProvider.github.scopes ?? [], since: byProvider.github.connected_at }
        : null,
      vercel: byProvider.vercel
        ? { account: byProvider.vercel.account_name, since: byProvider.vercel.connected_at }
        : null
    }
  });
}

/* ------------------------------------------------------------------- GitHub */
async function githubConnect(userId: string, body: Record<string, unknown>) {
  const code = clean(body.code, 200);
  const directToken = clean(body.token, 200);

  let token = directToken;

  if (!token && code) {
    const clientId = env("GITHUB_CLIENT_ID");
    const clientSecret = env("GITHUB_CLIENT_SECRET");
    if (!clientId || !clientSecret) {
      return fail(503, "github_unconfigured", "GitHub OAuth is not configured on this deployment.", {
        hint: "Set GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET as Edge Function secrets."
      });
    }
    const response = await fetch("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, code })
    });
    const payload = await response.json();
    if (!payload?.access_token) {
      return fail(400, "github_oauth_failed", payload?.error_description || "GitHub did not return an access token.");
    }
    token = payload.access_token;
  }

  if (!token) return fail(400, "invalid_input", "A GitHub authorisation code or token is required.");

  const user = await gh<{ login: string; id: number; name?: string }>("/user", token);
  const scopes = (env("GITHUB_SCOPES") || "repo").split(",").map((scope) => scope.trim()).filter(Boolean);

  await saveToken(userId, "github", token, scopes);
  await admin().from("integrations").upsert(
    {
      owner_id: userId,
      provider: "github",
      account_name: user.login,
      external_id: String(user.id),
      scopes,
      updated_at: new Date().toISOString()
    },
    { onConflict: "owner_id,provider" }
  );

  return json({ connected: true, account: user.login });
}

async function githubRepos(userId: string) {
  const token = await loadToken(userId, "github");
  if (!token) return fail(409, "github_not_connected", "Connect GitHub first.");

  const repos = await gh<Array<Record<string, unknown>>>("/user/repos?per_page=100&sort=updated&affiliation=owner,collaborator", token);
  return json({
    repos: repos.map((repo) => ({
      full_name: repo.full_name,
      name: repo.name,
      private: repo.private,
      default_branch: repo.default_branch,
      updated_at: repo.updated_at,
      html_url: repo.html_url
    }))
  });
}

async function githubCreateRepo(userId: string, body: Record<string, unknown>) {
  const token = await loadToken(userId, "github");
  if (!token) return fail(409, "github_not_connected", "Connect GitHub first.");

  const name = clean(body.name, 100).replace(/[^a-zA-Z0-9._-]/g, "-");
  if (!name) return fail(400, "invalid_input", "Repository name is required.");

  const repo = await gh<Record<string, unknown>>("/user/repos", token, {
    method: "POST",
    body: JSON.stringify({ name, private: Boolean(body.private), auto_init: true, description: "Generated with Shinzora" })
  });

  return json({ repo: { full_name: repo.full_name, html_url: repo.html_url, default_branch: repo.default_branch } });
}

async function githubPush(userId: string, body: Record<string, unknown>) {
  const token = await loadToken(userId, "github");
  if (!token) return fail(409, "github_not_connected", "Connect GitHub first.");

  const projectId = clean(body.projectId, 64);
  const versionId = clean(body.versionId, 64);
  const repoFullName = clean(body.repo, 140);
  const branch = clean(body.branch, 80) || "main";
  const message = clean(body.message, 200) || "Publish from Shinzora";

  const version = await loadVersion(userId, projectId, versionId);
  if (!version) return fail(404, "not_found", "That project version could not be found.");

  const [owner, repo] = repoFullName.split("/");
  if (!owner || !repo) return fail(400, "invalid_input", "Choose a repository in the owner/name format.");

  // Resolve the base commit (or start from an empty tree for a new repo).
  let baseSha: string | null = null;
  try {
    const ref = await gh<{ object: { sha: string } }>(`/repos/${owner}/${repo}/git/ref/heads/${branch}`, token);
    baseSha = ref.object.sha;
  } catch {
    baseSha = null;
  }

  let baseTree: string | undefined;
  if (baseSha) {
    const commit = await gh<{ tree: { sha: string } }>(`/repos/${owner}/${repo}/git/commits/${baseSha}`, token);
    baseTree = commit.tree.sha;
  }

  const files = version.files as Record<string, string>;
  const tree: Array<{ path: string; mode: "100644"; type: "blob"; content: string }> = Object.entries(files).map(
    ([path, content]) => ({ path, mode: "100644" as const, type: "blob" as const, content })
  );

  const newTree = await gh<{ sha: string }>(`/repos/${owner}/${repo}/git/trees`, token, {
    method: "POST",
    body: JSON.stringify(baseTree ? { base_tree: baseTree, tree } : { tree })
  });

  const commit = await gh<{ sha: string; html_url: string }>(`/repos/${owner}/${repo}/git/commits`, token, {
    method: "POST",
    body: JSON.stringify({
      message,
      tree: newTree.sha,
      parents: baseSha ? [baseSha] : [],
      author: { name: "Shinzora", email: "bot@shinzora.in" }
    })
  });

  if (baseSha) {
    await gh(`/repos/${owner}/${repo}/git/refs/heads/${branch}`, token, {
      method: "PATCH",
      body: JSON.stringify({ sha: commit.sha, force: false })
    });
  } else {
    await gh(`/repos/${owner}/${repo}/git/refs`, token, {
      method: "POST",
      body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: commit.sha })
    });
  }

  const { data: deployment } = await admin()
    .from("deployments")
    .insert({
      owner_id: userId,
      project_id: projectId,
      version_id: versionId || null,
      provider: "github",
      repo_full_name: repoFullName,
      commit_sha: commit.sha,
      url: commit.html_url,
      status: "ready",
      meta: { branch, files: Object.keys(files).length }
    })
    .select("*")
    .single();

  return json({
    ok: true,
    commit: commit.sha,
    branch,
    repo: repoFullName,
    url: `https://github.com/${repoFullName}/commit/${commit.sha}`,
    deployment
  });
}

async function loadVersion(userId: string, projectId: string, versionId: string) {
  let query = admin().from("project_versions").select("id, project_id, version_number, files, meta").limit(1);
  if (versionId) query = query.eq("id", versionId);
  else query = query.eq("project_id", projectId).order("version_number", { ascending: false });
  const { data } = await query.maybeSingle();
  if (!data) return null;

  const { data: project } = await admin()
    .from("projects")
    .select("id, owner_id")
    .eq("id", data.project_id)
    .eq("owner_id", userId)
    .maybeSingle();

  return project ? data : null;
}

/* ------------------------------------------------------------------- Vercel */
async function vercelConnect(userId: string, body: Record<string, unknown>) {
  const token = clean(body.token, 300) || env("VERCEL_TOKEN");
  if (!token) {
    return fail(503, "vercel_unconfigured", "Vercel is not configured on this deployment.", {
      hint: "Set VERCEL_TOKEN as an Edge Function secret, or paste a personal access token to connect your own account."
    });
  }

  const user = await vc<{ user: { username: string; id: string } }>("/v2/user", token);
  await saveToken(userId, "vercel", token);
  await admin().from("integrations").upsert(
    {
      owner_id: userId,
      provider: "vercel",
      account_name: user?.user?.username ?? "vercel",
      external_id: String(user?.user?.id ?? ""),
      updated_at: new Date().toISOString()
    },
    { onConflict: "owner_id,provider" }
  );

  return json({ connected: true, account: user?.user?.username ?? "vercel" });
}

async function vercelDeploy(userId: string, body: Record<string, unknown>) {
  const token = (await loadToken(userId, "vercel")) || env("VERCEL_TOKEN");
  if (!token) return fail(409, "vercel_not_connected", "Connect Vercel first.");

  const projectId = clean(body.projectId, 64);
  const versionId = clean(body.versionId, 64);
  const version = await loadVersion(userId, projectId, versionId);
  if (!version) return fail(404, "not_found", "That project version could not be found.");

  const files = version.files as Record<string, string>;
  const name = clean(body.name, 60).replace(/[^a-z0-9-]/gi, "-").toLowerCase() || `shinzora-${projectId.slice(0, 8)}`;

  const payload = {
    name,
    files: Object.entries(files).map(([file, data]) => ({ file, data })),
    projectSettings: { framework: null, buildCommand: null, outputDirectory: null, installCommand: null },
    target: "production"
  };

  const deployment = await vc<{ id: string; url: string; readyState: string }>("/v13/deployments", token, {
    method: "POST",
    body: JSON.stringify(payload)
  });

  const { data } = await admin()
    .from("deployments")
    .insert({
      owner_id: userId,
      project_id: projectId,
      version_id: versionId || null,
      provider: "vercel",
      external_id: deployment.id,
      url: `https://${deployment.url}`,
      status: mapState(deployment.readyState),
      meta: { name, files: Object.keys(files).length }
    })
    .select("*")
    .single();

  return json({
    deployment: data,
    provider_state: deployment.readyState,
    url: `https://${deployment.url}`,
    note: "Vercel accepted the deployment. It is not live until the status reads READY."
  });
}

async function vercelStatus(userId: string, body: Record<string, unknown>) {
  const token = (await loadToken(userId, "vercel")) || env("VERCEL_TOKEN");
  if (!token) return fail(409, "vercel_not_connected", "Connect Vercel first.");

  const externalId = clean(body.deploymentId, 80);
  const state = await vc<{ readyState: string; url: string; alias?: string[] }>(`/v13/deployments/${externalId}`, token);
  const status = mapState(state.readyState);

  await admin()
    .from("deployments")
    .update({
      status,
      url: state.url ? `https://${state.url}` : undefined,
      meta: { aliases: state.alias ?? [] },
      updated_at: new Date().toISOString()
    })
    .eq("owner_id", userId)
    .eq("external_id", externalId);

  return json({ status, provider_state: state.readyState, url: state.url ? `https://${state.url}` : null });
}

function mapState(readyState: string): "queued" | "building" | "ready" | "error" | "cancelled" {
  switch ((readyState || "").toUpperCase()) {
    case "READY":
      return "ready";
    case "ERROR":
      return "error";
    case "CANCELED":
    case "CANCELLED":
      return "cancelled";
    case "BUILDING":
    case "INITIALIZING":
      return "building";
    default:
      return "queued";
  }
}
