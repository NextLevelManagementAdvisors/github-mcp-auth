import { createHash } from "node:crypto";
import type { Request, Response, NextFunction } from "express";
import { loadAccessToken, upsertTenant } from "./db.js";
import { getValidAccessTokenFor } from "./github-oauth.js";

export interface TenantContext {
  /** Hash of the GitHub user id — durable handle for audit logs */
  tenantIdHash: string;
  /** The user's *current* GitHub access token, freshly refreshed if needed */
  githubAccessToken: string;
  /** GitHub login (handle), e.g. "forrest-surprenant" */
  githubLogin: string;
  /** GitHub user id (numeric) */
  githubUserId: number;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      tenant?: TenantContext;
    }
  }
}

function hashUserId(githubUserId: number): string {
  const salt = process.env.API_KEY_HASH_SALT;
  if (!salt || salt.length < 32) {
    throw new Error("API_KEY_HASH_SALT must be set and at least 32 chars");
  }
  return createHash("sha256").update(String(githubUserId)).update(salt).digest("hex");
}

function extractBearer(req: Request): string | null {
  const h = req.headers.authorization;
  if (h && typeof h === "string") {
    const m = h.match(/^Bearer\s+(.+)$/i);
    if (m) return m[1].trim();
  }
  return null;
}

function setWwwAuthenticate(res: Response, description: string): void {
  const base = process.env.BASE_URL ?? "https://github.nlma.io";
  const resourceMetadata = `${base}/.well-known/oauth-protected-resource`;
  res.setHeader(
    "WWW-Authenticate",
    `Bearer realm="GitHub MCP", resource_metadata="${resourceMetadata}", error="invalid_token", error_description="${description}"`
  );
}

export async function bearerAuth(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  const token = extractBearer(req);
  if (!token) {
    setWwwAuthenticate(res, "Bearer token required");
    res.status(401).json({
      error: "unauthorized",
      error_description: "Bearer token required",
    });
    return;
  }
  try {
    const rec = await loadAccessToken(token);
    if (!rec) throw new Error("Invalid or expired token");
    const fresh = await getValidAccessTokenFor(rec.githubUserId);
    if (!fresh) throw new Error("GitHub credentials not available — please re-authorize");
    const tenantIdHash = hashUserId(rec.githubUserId);
    await upsertTenant(tenantIdHash, fresh.githubLogin, rec.githubUserId);
    req.tenant = {
      tenantIdHash,
      githubAccessToken: fresh.accessToken,
      githubLogin: fresh.githubLogin,
      githubUserId: rec.githubUserId,
    };
    next();
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Authentication failed";
    setWwwAuthenticate(res, msg);
    res.status(401).json({
      error: "unauthorized",
      error_description: msg,
    });
  }
}
