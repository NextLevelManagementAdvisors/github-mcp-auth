// GitHub OAuth client — drives the user-facing GitHub login dance and
// persists the resulting access (and refresh) token in github_users.

import { upsertGithubUser, loadGithubUser } from "./db.js";
import { getRegistryDomains } from "./domains-registry.js";

const GH_AUTH_URL = "https://github.com/login/oauth/authorize";
const GH_TOKEN_URL = "https://github.com/login/oauth/access_token";
const GH_USER_URL = "https://api.github.com/user";
const GH_USER_EMAILS_URL = "https://api.github.com/user/emails";

function getEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

export function getGithubScopes(): string[] {
  const raw =
    process.env.GITHUB_SCOPES ?? "repo,read:org,read:user,user:email,read:project,workflow";
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

export interface GithubEmail {
  email: string;
  primary: boolean;
  verified: boolean;
}

/** Thrown when the grant can't read email addresses — i.e. it lacks `user:email`. */
export class GithubEmailScopeError extends Error {}

export async function fetchGithubEmails(accessToken: string): Promise<GithubEmail[]> {
  const res = await fetch(GH_USER_EMAILS_URL, {
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "github-mcp-auth",
      Authorization: `Bearer ${accessToken}`,
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (res.status === 403 || res.status === 404) {
    throw new GithubEmailScopeError(
      "this authorization cannot read your email addresses — it is missing the user:email scope"
    );
  }
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`GitHub /user/emails lookup failed: HTTP ${res.status}: ${body}`);
  }
  return (await res.json()) as GithubEmail[];
}

/**
 * Revoke the OAuth App grant on GitHub's side so a disconnected connector is
 * genuinely off rather than merely forgotten locally. Best-effort: callers
 * still delete local state when this returns false.
 */
export async function revokeGithubGrant(accessToken: string): Promise<boolean> {
  const clientId = getEnv("GITHUB_CLIENT_ID");
  const basic = Buffer.from(`${clientId}:${getEnv("GITHUB_CLIENT_SECRET")}`).toString("base64");
  const res = await fetch(`https://api.github.com/applications/${clientId}/grant`, {
    method: "DELETE",
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "github-mcp-auth",
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    body: JSON.stringify({ access_token: accessToken }),
  });
  return res.status === 204;
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

function getAllowedLogins(): string[] {
  return (process.env.GITHUB_ALLOWED_USERS ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 0);
}

/** Size of the login allowlist, for status output that must not name the users. */
export function getAllowedLoginCount(): number {
  return getAllowedLogins().length;
}

/** `@Nlma.io`, ` nlma.io. ` and `nlma.io` all normalize to `nlma.io`. */
function normalizeDomain(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/^@+/, "")
    .replace(/^\.+/, "")
    .replace(/\.+$/, "");
}

/**
 * Approved email domains, from two sources OR'd together: the local
 * GITHUB_APPROVED_EMAIL_DOMAINS env var, and the org-wide registry synced
 * from status.nlma.io (see domains-registry.ts). Empty = no domain gate.
 */
export function getApprovedEmailDomains(): string[] {
  const local = (process.env.GITHUB_APPROVED_EMAIL_DOMAINS ?? "")
    .split(",")
    .map(normalizeDomain)
    .filter((s) => s.length > 0);
  const registry = getRegistryDomains().map(normalizeDomain).filter((s) => s.length > 0);
  return Array.from(new Set([...local, ...registry]));
}

/** An address is approved when its domain matches an entry or is a subdomain of one. */
export function isEmailDomainApproved(email: string, approved: string[]): boolean {
  const at = email.lastIndexOf("@");
  if (at < 0) return false;
  const domain = normalizeDomain(email.slice(at + 1));
  if (!domain) return false;
  return approved.some((d) => domain === d || domain.endsWith(`.${d}`));
}

/**
 * Only *verified* addresses count. An unverified one proves nothing — anyone
 * could add `someone@your-company.com` to their GitHub account and walk in.
 * Primary first, so the stored email is the user's own idea of their identity.
 */
function verifiedEmails(emails: GithubEmail[]): string[] {
  const usable = emails.filter((e) => e.verified && e.email);
  return [...usable.filter((e) => e.primary), ...usable.filter((e) => !e.primary)].map(
    (e) => e.email
  );
}

interface AccessDecision {
  allowed: boolean;
  /** Verified email to store on the user row — the approving one when there is one. */
  email: string | null;
  /** Human-readable justification, surfaced to the user on denial. */
  reason: string;
}

/**
 * Two independent allowlists, either of which admits a user: the per-login
 * `GITHUB_ALLOWED_USERS` and the per-domain `GITHUB_APPROVED_EMAIL_DOMAINS`.
 * Both empty = anyone with a GitHub account, as before.
 */
async function decideAccess(accessToken: string, login: string): Promise<AccessDecision> {
  const logins = getAllowedLogins();
  const domains = getApprovedEmailDomains();
  const onLoginList = logins.includes(login.toLowerCase());

  // Fetched even with no domain gate configured: the email is stored on the
  // user row and shown back during offboarding.
  let emails: GithubEmail[] | null = null;
  let emailError: string | null = null;
  try {
    emails = await fetchGithubEmails(accessToken);
  } catch (err) {
    emailError = err instanceof Error ? err.message : "email lookup failed";
  }
  const verified = emails ? verifiedEmails(emails) : [];
  const approvingEmail = verified.find((e) => isEmailDomainApproved(e, domains)) ?? null;
  const primaryEmail = verified[0] ?? null;

  if (logins.length === 0 && domains.length === 0) {
    return { allowed: true, email: primaryEmail, reason: "no allowlist configured" };
  }
  if (onLoginList) {
    return { allowed: true, email: approvingEmail ?? primaryEmail, reason: "GITHUB_ALLOWED_USERS" };
  }
  if (domains.length === 0) {
    return { allowed: false, email: primaryEmail, reason: "not on GITHUB_ALLOWED_USERS" };
  }
  if (approvingEmail) {
    return { allowed: true, email: approvingEmail, reason: "approved email domain" };
  }
  // A domain gate is configured, so an unreadable email list must fail closed.
  if (emailError) {
    return {
      allowed: false,
      email: null,
      reason: `${emailError} — re-authorize to grant it`,
    };
  }
  return {
    allowed: false,
    email: primaryEmail,
    reason: `no verified GitHub email on an approved domain (${domains.join(", ")})`,
  };
}

export interface GithubIdentity {
  githubUserId: number;
  githubLogin: string;
  /** Verified email we know them by, when GitHub let us read one. */
  email: string | null;
}

/**
 * Exchange a GitHub `code` for an identity *without* persisting anything.
 * The offboarding flow needs to prove who is asking, but must not store
 * credentials for an account whose row it is about to delete.
 */
export async function identifyGithubUser(
  code: string
): Promise<GithubIdentity & { accessToken: string }> {
  const tok = await exchangeCodeForToken(code);
  const user = await fetchGithubUser(tok.access_token);
  let email: string | null = null;
  try {
    email = verifiedEmails(await fetchGithubEmails(tok.access_token))[0] ?? null;
  } catch {
    // Identity is the login; the email is only used to label the page.
  }
  return {
    githubUserId: user.id,
    githubLogin: user.login,
    email,
    accessToken: tok.access_token,
  };
}

/**
 * Complete the GitHub OAuth dance: exchange the `code` for a GitHub access
 * token, fetch the user, persist the encrypted token, and return the
 * github_user_id we'll use to look it up at proxy time.
 */
export async function completeGithubLogin(code: string): Promise<GithubIdentity> {
  const tok = await exchangeCodeForToken(code);
  const user = await fetchGithubUser(tok.access_token);
  const decision = await decideAccess(tok.access_token, user.login);
  if (!decision.allowed) {
    throw new Error(`GitHub user ${user.login} is not allowed to use this connector: ${decision.reason}`);
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
    scopes,
    decision.email
  );
  return { githubUserId: user.id, githubLogin: user.login, email: decision.email };
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
      scopes,
      u.email
    );
    return { accessToken: tok.access_token, githubLogin: u.githubLogin };
  } catch (err) {
    console.error(`Failed to refresh GitHub token for user ${githubUserId}:`, err);
    return null;
  }
}
