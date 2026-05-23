// OAuthServerProvider for the @modelcontextprotocol/sdk mcpAuthRouter.
//
// This is the bridge layer. claude.ai (or any OAuth 2.1 MCP client) talks to
// the standard /.well-known + /register + /authorize + /token endpoints
// exposed by mcpAuthRouter; mcpAuthRouter delegates to the methods below.
//
// Our authorize() does NOT render a login form. Instead it stashes the
// claude.ai PKCE state in Postgres keyed by a random `state_token`, then
// 302-redirects the user's browser to github.com/login/oauth/authorize with
// that state_token as the OAuth `state` parameter.
//
// When GitHub redirects back to /oauth/github/callback (handled in http.ts),
// we look the pending state up, complete the GitHub OAuth dance, and finally
// 302-redirect back to claude.ai's redirect_uri with the auth_code we just
// minted for them. claude.ai then POSTs /token to exchange that code for an
// opaque access_token, which it uses on subsequent /mcp requests.

import { randomUUID } from "node:crypto";
import type { Response } from "express";
import type { OAuthServerProvider } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type {
  OAuthClientInformationFull,
  OAuthTokenRevocationRequest,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import {
  getClient,
  putClient,
  storePendingState,
  storeAuthCode,
  peekAuthCodeChallenge,
  takeAuthCode,
  storeAccessToken,
  storeRefreshToken,
  loadAccessToken,
  loadRefreshToken,
  deleteToken,
} from "./db.js";
import { buildGithubAuthorizeUrl } from "./github-oauth.js";

const ACCESS_TOKEN_TTL_S = 60 * 60;             // 1h
const REFRESH_TOKEN_TTL_S = 30 * 24 * 60 * 60;  // 30d
const AUTH_CODE_TTL_MS = 10 * 60 * 1000;        // 10m
const PENDING_STATE_TTL_MS = 10 * 60 * 1000;    // 10m

const clientsStore: OAuthRegisteredClientsStore = {
  async getClient(clientId) {
    const stored = (await getClient(clientId)) as OAuthClientInformationFull | undefined;
    if (stored) return stored;
    // Accept UUID-shaped client IDs that we issued but haven't persisted yet
    // (shouldn't happen post-migration, but mirrors the hospitable-mcp safety
    // net for DCR clients that registered against an older instance).
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(clientId)) {
      const base = process.env.BASE_URL ?? "http://localhost:3061";
      return {
        client_id: clientId,
        client_id_issued_at: Math.floor(Date.now() / 1000),
        redirect_uris: [
          "http://localhost/callback",
          "https://claude.ai/api/mcp/auth_callback",
          `${base}/callback`,
        ],
      } as OAuthClientInformationFull;
    }
    return undefined;
  },
  async registerClient(client) {
    const now = Math.floor(Date.now() / 1000);
    const full: OAuthClientInformationFull = {
      ...client,
      client_id: randomUUID(),
      client_id_issued_at: now,
    };
    await putClient(full.client_id, full);
    return full;
  },
};

/** Mint a claude.ai-facing auth code that points at a given GitHub user. */
export async function mintAuthCode(
  clientId: string,
  redirectUri: string,
  codeChallenge: string,
  githubUserId: number
): Promise<string> {
  const code = randomUUID();
  await storeAuthCode(
    code,
    clientId,
    redirectUri,
    codeChallenge,
    githubUserId,
    Date.now() + AUTH_CODE_TTL_MS
  );
  return code;
}

export const oauthProvider: OAuthServerProvider = {
  get clientsStore() {
    return clientsStore;
  },

  /**
   * Called when claude.ai hits /authorize. Instead of showing a UI here, stash
   * the PKCE params under a random state_token and redirect to GitHub.
   */
  async authorize(client, params, res: Response) {
    const stateToken = randomUUID();
    await storePendingState(
      stateToken,
      client.client_id,
      params.redirectUri,
      params.codeChallenge,
      params.state,
      Date.now() + PENDING_STATE_TTL_MS
    );
    res.redirect(buildGithubAuthorizeUrl(stateToken));
  },

  async challengeForAuthorizationCode(_client, authorizationCode) {
    const challenge = await peekAuthCodeChallenge(authorizationCode);
    if (!challenge) throw new Error("Authorization code not found or expired");
    return challenge;
  },

  async exchangeAuthorizationCode(client, authorizationCode) {
    const pending = await takeAuthCode(authorizationCode);
    if (!pending) throw new Error("Authorization code not found or expired");

    const accessToken = randomUUID();
    const refreshToken = randomUUID();
    const now = Math.floor(Date.now() / 1000);
    await storeAccessToken(
      accessToken,
      client.client_id,
      pending.githubUserId,
      [],
      now + ACCESS_TOKEN_TTL_S
    );
    await storeRefreshToken(
      refreshToken,
      client.client_id,
      pending.githubUserId,
      [],
      now + REFRESH_TOKEN_TTL_S
    );
    return {
      access_token: accessToken,
      token_type: "bearer",
      expires_in: ACCESS_TOKEN_TTL_S,
      refresh_token: refreshToken,
    } satisfies OAuthTokens;
  },

  async exchangeRefreshToken(client, refreshToken) {
    const entry = await loadRefreshToken(refreshToken);
    if (!entry) throw new Error("Refresh token not found or expired");
    const now = Math.floor(Date.now() / 1000);
    const accessToken = randomUUID();
    await storeAccessToken(
      accessToken,
      client.client_id,
      entry.githubUserId,
      entry.scopes,
      now + ACCESS_TOKEN_TTL_S
    );
    return {
      access_token: accessToken,
      token_type: "bearer",
      expires_in: ACCESS_TOKEN_TTL_S,
      refresh_token: refreshToken,
    } satisfies OAuthTokens;
  },

  async verifyAccessToken(token): Promise<AuthInfo> {
    const rec = await loadAccessToken(token);
    if (!rec) throw new Error("Invalid or expired access token");
    return {
      token,
      clientId: rec.clientId,
      scopes: rec.scopes,
      expiresAt: rec.expiresAtSec,
      extra: { githubUserId: rec.githubUserId },
    };
  },

  async revokeToken(_client, request: OAuthTokenRevocationRequest) {
    await deleteToken(request.token);
  },
};
