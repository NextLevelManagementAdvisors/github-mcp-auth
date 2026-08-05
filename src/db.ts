import pg from "pg";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { encryptToken, decryptToken } from "./crypto.js";

const { Pool } = pg;

let pool: pg.Pool | null = null;

export function getPool(): pg.Pool {
  if (!pool) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) throw new Error("DATABASE_URL not set");
    pool = new Pool({ connectionString, max: 10 });
  }
  return pool;
}

export async function runMigrations(): Promise<void> {
  const dir = join(process.cwd(), "migrations");
  const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
  for (const file of files) {
    const sql = await readFile(join(dir, file), "utf8");
    await getPool().query(sql);
  }
}

// ─── Tenants / audit ─────────────────────────────────────────────────────────

export async function upsertTenant(
  tenantIdHash: string,
  githubLogin: string,
  githubUserId: number
): Promise<void> {
  await getPool().query(
    `INSERT INTO tenants (tenant_id_hash, github_login, github_user_id)
     VALUES ($1, $2, $3)
     ON CONFLICT (tenant_id_hash)
     DO UPDATE SET github_login = EXCLUDED.github_login,
                   github_user_id = EXCLUDED.github_user_id,
                   last_active_at = NOW()`,
    [tenantIdHash, githubLogin, githubUserId]
  );
}

export async function writeAuditLog(
  tenantIdHash: string | null,
  tool: string,
  result: "ok" | "error",
  errorMessage?: string
): Promise<void> {
  try {
    await getPool().query(
      `INSERT INTO audit_log (tenant_id_hash, tool, result, error_message)
       VALUES ($1, $2, $3, $4)`,
      [tenantIdHash, tool, result, errorMessage ?? null]
    );
  } catch (err) {
    console.error("audit_log insert failed:", err);
  }
}

// ─── github_users CRUD ───────────────────────────────────────────────────────

export interface GithubUserTokens {
  accessToken: string;
  accessExpiresAt: Date | null;
  refreshToken: string | null;
  refreshExpiresAt: Date | null;
  scopes: string[];
  githubLogin: string;
  email: string | null;
}

export async function upsertGithubUser(
  githubUserId: number,
  githubLogin: string,
  accessToken: string,
  accessExpiresAt: Date | null,
  refreshToken: string | null,
  refreshExpiresAt: Date | null,
  scopes: string[],
  email: string | null
): Promise<void> {
  const enc = encryptToken(accessToken);
  const refEnc = refreshToken ? encryptToken(refreshToken) : null;
  await getPool().query(
    `INSERT INTO github_users
       (github_user_id, github_login,
        access_ciphertext, access_iv, access_tag, access_expires_at,
        refresh_ciphertext, refresh_iv, refresh_tag, refresh_expires_at,
        scopes, email, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12, NOW())
     ON CONFLICT (github_user_id) DO UPDATE SET
       github_login = EXCLUDED.github_login,
       access_ciphertext = EXCLUDED.access_ciphertext,
       access_iv = EXCLUDED.access_iv,
       access_tag = EXCLUDED.access_tag,
       access_expires_at = EXCLUDED.access_expires_at,
       refresh_ciphertext = EXCLUDED.refresh_ciphertext,
       refresh_iv = EXCLUDED.refresh_iv,
       refresh_tag = EXCLUDED.refresh_tag,
       refresh_expires_at = EXCLUDED.refresh_expires_at,
       scopes = EXCLUDED.scopes,
       -- A token refresh doesn't look the email up, so never let it blank one out.
       email = COALESCE(EXCLUDED.email, github_users.email),
       updated_at = NOW()`,
    [
      githubUserId,
      githubLogin,
      enc.ciphertext, enc.iv, enc.tag, accessExpiresAt,
      refEnc?.ciphertext ?? null, refEnc?.iv ?? null, refEnc?.tag ?? null, refreshExpiresAt,
      scopes,
      email,
    ]
  );
}

interface GhUserRow {
  github_login: string;
  access_ciphertext: Buffer;
  access_iv: Buffer;
  access_tag: Buffer;
  access_expires_at: Date | null;
  refresh_ciphertext: Buffer | null;
  refresh_iv: Buffer | null;
  refresh_tag: Buffer | null;
  refresh_expires_at: Date | null;
  scopes: string[];
  email: string | null;
}

export async function loadGithubUser(githubUserId: number): Promise<GithubUserTokens | null> {
  const r = await getPool().query<GhUserRow>(
    `SELECT github_login,
            access_ciphertext, access_iv, access_tag, access_expires_at,
            refresh_ciphertext, refresh_iv, refresh_tag, refresh_expires_at,
            scopes, email
     FROM github_users
     WHERE github_user_id = $1`,
    [githubUserId]
  );
  if (r.rowCount === 0) return null;
  const row = r.rows[0];
  return {
    accessToken: decryptToken({
      ciphertext: row.access_ciphertext,
      iv: row.access_iv,
      tag: row.access_tag,
    }),
    accessExpiresAt: row.access_expires_at,
    refreshToken:
      row.refresh_ciphertext && row.refresh_iv && row.refresh_tag
        ? decryptToken({
            ciphertext: row.refresh_ciphertext,
            iv: row.refresh_iv,
            tag: row.refresh_tag,
          })
        : null,
    refreshExpiresAt: row.refresh_expires_at,
    scopes: row.scopes,
    githubLogin: row.github_login,
    email: row.email,
  };
}

export interface OffboardResult {
  /** False when there was no stored GitHub connection left to remove. */
  hadStoredConnection: boolean;
  accessTokensDeleted: number;
  refreshTokensDeleted: number;
  authCodesDeleted: number;
}

/**
 * Turn a connector fully off for one GitHub user: every opaque token we issued
 * to claude.ai, any in-flight auth code, the encrypted GitHub credentials, and
 * the tenant row. `audit_log` is deliberately left alone — it is keyed by a
 * salted hash rather than an identity, and an audit trail you can erase from
 * the product isn't one.
 */
export async function offboardGithubUser(githubUserId: number): Promise<OffboardResult> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const access = await client.query(
      `DELETE FROM oauth_access_tokens WHERE github_user_id = $1`,
      [githubUserId]
    );
    const refresh = await client.query(
      `DELETE FROM oauth_refresh_tokens WHERE github_user_id = $1`,
      [githubUserId]
    );
    const codes = await client.query(`DELETE FROM oauth_auth_codes WHERE github_user_id = $1`, [
      githubUserId,
    ]);
    const user = await client.query(`DELETE FROM github_users WHERE github_user_id = $1`, [
      githubUserId,
    ]);
    await client.query(`DELETE FROM tenants WHERE github_user_id = $1`, [githubUserId]);
    await client.query("COMMIT");
    return {
      hadStoredConnection: (user.rowCount ?? 0) > 0,
      accessTokensDeleted: access.rowCount ?? 0,
      refreshTokensDeleted: refresh.rowCount ?? 0,
      authCodesDeleted: codes.rowCount ?? 0,
    };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

// ─── oauth_pending_state ────────────────────────────────────────────────────

/** What the GitHub round trip this row guards is for. */
export type PendingPurpose = "authorize" | "disconnect";

export interface PendingState {
  purpose: PendingPurpose;
  /** Null on a "disconnect" dance — there is no claude.ai client involved. */
  clientId: string | null;
  redirectUri: string | null;
  codeChallenge: string | null;
  claudeState: string | null;
}

export async function storePendingState(
  stateToken: string,
  clientId: string | null,
  redirectUri: string | null,
  codeChallenge: string | null,
  claudeState: string | undefined,
  expiresAtMs: number,
  purpose: PendingPurpose
): Promise<void> {
  await getPool().query(
    `INSERT INTO oauth_pending_state
       (state_token, client_id, redirect_uri, code_challenge, claude_state, expires_at, purpose)
     VALUES ($1, $2, $3, $4, $5, to_timestamp($6 / 1000.0), $7)`,
    [stateToken, clientId, redirectUri, codeChallenge, claudeState ?? null, expiresAtMs, purpose]
  );
}

export async function takePendingState(stateToken: string): Promise<PendingState | null> {
  const r = await getPool().query<{
    client_id: string | null;
    redirect_uri: string | null;
    code_challenge: string | null;
    claude_state: string | null;
    purpose: string;
  }>(
    `DELETE FROM oauth_pending_state
     WHERE state_token = $1 AND expires_at > NOW()
     RETURNING client_id, redirect_uri, code_challenge, claude_state, purpose`,
    [stateToken]
  );
  if (r.rowCount === 0) return null;
  const row = r.rows[0];
  return {
    purpose: row.purpose === "disconnect" ? "disconnect" : "authorize",
    clientId: row.client_id,
    redirectUri: row.redirect_uri,
    codeChallenge: row.code_challenge,
    claudeState: row.claude_state,
  };
}

// ─── oauth_auth_codes ───────────────────────────────────────────────────────

export async function storeAuthCode(
  code: string,
  clientId: string,
  redirectUri: string,
  codeChallenge: string,
  githubUserId: number,
  expiresAtMs: number
): Promise<void> {
  await getPool().query(
    `INSERT INTO oauth_auth_codes (code, client_id, redirect_uri, code_challenge, github_user_id, expires_at)
     VALUES ($1, $2, $3, $4, $5, to_timestamp($6 / 1000.0))`,
    [code, clientId, redirectUri, codeChallenge, githubUserId, expiresAtMs]
  );
}

export async function peekAuthCodeChallenge(code: string): Promise<string | null> {
  const r = await getPool().query<{ code_challenge: string }>(
    `SELECT code_challenge FROM oauth_auth_codes WHERE code = $1 AND expires_at > NOW()`,
    [code]
  );
  return r.rows[0]?.code_challenge ?? null;
}

export async function takeAuthCode(code: string): Promise<{
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  githubUserId: number;
} | null> {
  const r = await getPool().query<{
    client_id: string;
    redirect_uri: string;
    code_challenge: string;
    github_user_id: string;
  }>(
    `DELETE FROM oauth_auth_codes
     WHERE code = $1 AND expires_at > NOW()
     RETURNING client_id, redirect_uri, code_challenge, github_user_id`,
    [code]
  );
  if (r.rowCount === 0) return null;
  const row = r.rows[0];
  return {
    clientId: row.client_id,
    redirectUri: row.redirect_uri,
    codeChallenge: row.code_challenge,
    githubUserId: Number(row.github_user_id),
  };
}

// ─── oauth_access_tokens ────────────────────────────────────────────────────

export async function storeAccessToken(
  token: string,
  clientId: string,
  githubUserId: number,
  scopes: string[],
  expiresAtSec: number
): Promise<void> {
  await getPool().query(
    `INSERT INTO oauth_access_tokens (token, client_id, github_user_id, scopes, expires_at)
     VALUES ($1, $2, $3, $4, to_timestamp($5))`,
    [token, clientId, githubUserId, scopes, expiresAtSec]
  );
}

export async function loadAccessToken(token: string): Promise<{
  clientId: string;
  githubUserId: number;
  scopes: string[];
  expiresAtSec: number;
} | null> {
  const r = await getPool().query<{
    client_id: string;
    github_user_id: string;
    scopes: string[];
    expires_at: Date;
  }>(
    `SELECT client_id, github_user_id, scopes, expires_at
     FROM oauth_access_tokens
     WHERE token = $1`,
    [token]
  );
  if (r.rowCount === 0) return null;
  const row = r.rows[0];
  const expiresAtSec = Math.floor(row.expires_at.getTime() / 1000);
  if (expiresAtSec < Math.floor(Date.now() / 1000)) {
    await getPool().query(`DELETE FROM oauth_access_tokens WHERE token = $1`, [token]);
    return null;
  }
  return {
    clientId: row.client_id,
    githubUserId: Number(row.github_user_id),
    scopes: row.scopes,
    expiresAtSec,
  };
}

// ─── oauth_refresh_tokens ───────────────────────────────────────────────────

export async function storeRefreshToken(
  token: string,
  clientId: string,
  githubUserId: number,
  scopes: string[],
  expiresAtSec: number
): Promise<void> {
  await getPool().query(
    `INSERT INTO oauth_refresh_tokens (token, client_id, github_user_id, scopes, expires_at)
     VALUES ($1, $2, $3, $4, to_timestamp($5))`,
    [token, clientId, githubUserId, scopes, expiresAtSec]
  );
}

export async function loadRefreshToken(token: string): Promise<{
  clientId: string;
  githubUserId: number;
  scopes: string[];
} | null> {
  const r = await getPool().query<{
    client_id: string;
    github_user_id: string;
    scopes: string[];
  }>(
    `SELECT client_id, github_user_id, scopes
     FROM oauth_refresh_tokens
     WHERE token = $1 AND expires_at > NOW()`,
    [token]
  );
  if (r.rowCount === 0) return null;
  const row = r.rows[0];
  return {
    clientId: row.client_id,
    githubUserId: Number(row.github_user_id),
    scopes: row.scopes,
  };
}

export async function deleteToken(token: string): Promise<void> {
  await getPool().query(`DELETE FROM oauth_access_tokens WHERE token = $1`, [token]);
  await getPool().query(`DELETE FROM oauth_refresh_tokens WHERE token = $1`, [token]);
}

// ─── oauth_clients (Dynamic Client Registration) ─────────────────────────────

export async function getClient(clientId: string): Promise<unknown | undefined> {
  const r = await getPool().query<{ client_data: unknown }>(
    `SELECT client_data FROM oauth_clients WHERE client_id = $1`,
    [clientId]
  );
  return r.rows[0]?.client_data;
}

export async function putClient(clientId: string, clientData: unknown): Promise<void> {
  await getPool().query(
    `INSERT INTO oauth_clients (client_id, client_data) VALUES ($1, $2)
     ON CONFLICT (client_id) DO UPDATE SET client_data = EXCLUDED.client_data`,
    [clientId, clientData]
  );
}
