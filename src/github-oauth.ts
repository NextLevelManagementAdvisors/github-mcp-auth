// GitHub OAuth client — drives the user-facing GitHub login dance and
// persists the resulting access (and refresh) token in github_users.

import { upsertGithubUser, loadGithubUser } from "./db.js";

const GH_AUTH_URL = "https://github.com/login/oauth/authorize";
const GH_TOKEN_URL = "https://github.com/login/oauth/access_token";
const GH_USER_URL = "https://api.github.com/user";

function getEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

export function getGithubScopes(): string[] {
  const raw = process.env.GITHUB_SCOPES ?? "repo,read:org,read:user,read:project,workflow";
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export function buildGithubAuthorizeUrl(stateToken: string): string {
  const params = new URLSearchParams({
    client_id: getEnv("GITHUB_CLIENT_ID"),
    redirect_uri: `${getEnv("BASE_URL")}/oauth/github/callback`,
    scope: getGithubScopes().join(" "),
    state: stateToken,
    allow_signup: "false",
  });
  return `${GH_AUTH_URL}?${params.toString()}`;
}

export interface GithubTokenResponse {
  access_token: string;
  token_type: string;
  scope: string;
  refresh_token?: string;
  expires_in?: number;
  refresh_token_expires_in?: number;
}

export async function exchangeCodeForToken(code: string): Promise<GithubTokenResponse> {
  const res = await fetch(GH_TOKEN_URL, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      client_id: getEnv("GITHUB_CLIENT_ID"),
      client_secret: getEnv("GITHUB_CLIENT_SECRET"),
      code,
      redirect_uri: `${getEnv("BASE_URL")}/oauth/github/callback`,
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`GitHub token exchange failed: HTTP ${res.status}: ${body}`);
  }
  const data = (await res.json()) as GithubTokenResponse & { error?: string; error_description?: string };
  if (data.error || !data.access_token) {
    throw new Error(`GitHub token exchange error: ${data.error_description ?? data.error ?? "no access_token in response"}`);
  }
  return data;
}

export interface GithubUserResponse {
  id: number;
  login: string;
}

export async function fetchGithubUser(accessToken: string): Promise<GithubUserResponse> {
  const res = await fetch(GH_USER_URL, {
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "github-mcp-auth",
      Authorization: `Bearer ${accessToken}`,
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`GitHub /user lookup failed: HTTP ${res.status}: ${body}`);
  }
  return (await res.json()) as GithubUserResponse;
}

export async function refreshGithubToken(refreshToken: string): Promise<GithubTokenResponse> {
  const res = await fetch(GH_TOKEN_URL, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      client_id: getEnv("GITHUB_CLIENT_ID"),
      client_secret: getEnv("GITHUB_CLIENT_SECRET"),
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`GitHub refresh failed: HTTP ${res.status}: ${body}`);
  }
  const data = (await res.json()) as GithubTokenResponse & { error?: string };
  if (data.error || !data.access_token) throw new Error("GitHub refresh returned no access_token");
  return data;
}

function isUserAllowed(login: string): boolean {
  const raw = process.env.GITHUB_ALLOWED_USERS;
  if (!raw) return true;
  const allow = raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 0);
  if (allow.length === 0) return true;
  return allow.includes(login.toLowerCase());
}

/**
 * Complete the GitHub OAuth dance: exchange the `code` for a GitHub access
 * token, fetch the user, persist the encrypted token, and return the
 * github_user_id we'll use to look it up at proxy time.
 */
export async function completeGithubLogin(code: string): Promise<{
  githubUserId: number;
  githubLogin: string;
}> {
  const tok = await exchangeCodeForToken(code);
  const user = await fetchGithubUser(tok.access_token);
  if (!isUserAllowed(user.login)) {
    throw new Error(`GitHub user ${user.login} is not on the allowlist`);
  }
  const now = Date.now();
  const accessExpiresAt = tok.expires_in ? new Date(now + tok.expires_in * 1000) : null;
  const refreshExpiresAt = tok.refresh_token_expires_in
    ? new Date(now + tok.refresh_token_expires_in * 1000)
    : null;
  const scopes = tok.scope ? tok.scope.split(",").map((s) => s.trim()) : [];
  await upsertGithubUser(
    user.id,
    user.login,
    tok.access_token,
    accessExpiresAt,
    tok.refresh_token ?? null,
    refreshExpiresAt,
    scopes
  );
  return { githubUserId: user.id, githubLogin: user.login };
}

/**
 * Get a fresh GitHub access token for a user, refreshing it if we have a
 * refresh token and the access token is expired/near-expiry. Returns null if
 * the user has no usable credentials (e.g., refresh token revoked).
 */
export async function getValidAccessTokenFor(githubUserId: number): Promise<{
  accessToken: string;
  githubLogin: string;
} | null> {
  const u = await loadGithubUser(githubUserId);
  if (!u) return null;
  const skewMs = 30_000;
  const expired = u.accessExpiresAt !== null && u.accessExpiresAt.getTime() - skewMs < Date.now();
  if (!expired) {
    return { accessToken: u.accessToken, githubLogin: u.githubLogin };
  }
  if (!u.refreshToken) {
    // Classic (non-expiring) PAT-style GitHub OAuth — return whatever we have.
    return { accessToken: u.accessToken, githubLogin: u.githubLogin };
  }
  try {
    const tok = await refreshGithubToken(u.refreshToken);
    const now = Date.now();
    const accessExpiresAt = tok.expires_in ? new Date(now + tok.expires_in * 1000) : null;
    const refreshExpiresAt = tok.refresh_token_expires_in
      ? new Date(now + tok.refresh_token_expires_in * 1000)
      : null;
    const scopes = tok.scope ? tok.scope.split(",").map((s) => s.trim()) : u.scopes;
    await upsertGithubUser(
      githubUserId,
      u.githubLogin,
      tok.access_token,
      accessExpiresAt,
      tok.refresh_token ?? u.refreshToken,
      refreshExpiresAt,
      scopes
    );
    return { accessToken: tok.access_token, githubLogin: u.githubLogin };
  } catch (err) {
    console.error(`Failed to refresh GitHub token for user ${githubUserId}:`, err);
    return null;
  }
}
