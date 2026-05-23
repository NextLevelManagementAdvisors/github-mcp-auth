# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm install          # install deps
npm run build        # tsc → dist/
npm run dev          # tsc --watch
npm start            # node dist/index.js (requires .env loaded)
npm run deploy       # bash scripts/push-to-vps.sh (uploads + builds + restarts on VPS)
```

There is no test suite and no linter configured. Validate changes with `npm run build` (strict TS) and the smoke-test curls in README.md after deploy.

## Deployment

Production lives at `https://github.nlma.io` on the Hostinger VPS (`root@178.16.141.166`) under systemd unit `github-mcp-auth` listening on `127.0.0.1:3061`. Nginx terminates TLS and reverse-proxies to it (see [nginx/github.nlma.io.conf](nginx/github.nlma.io.conf)).

- `npm run deploy` rsyncs the tree to `/opt/github-mcp-auth`, runs `npm ci && npm run build`, restarts the unit, hits `/health`.
- First-time-only bootstrap: `ssh root@178.16.141.166 'bash /opt/github-mcp-auth/scripts/install-on-vps.sh'` — installs the systemd unit, rate-limit conf, and swaps the nginx vhost from `:3060` (bare upstream) to `:3061` (this gateway).
- Logs: `ssh root@178.16.141.166 'journalctl -u github-mcp-auth -f'`.
- The `.env` on the VPS is NOT overwritten by `push-to-vps.sh` — edit it in place under `/opt/github-mcp-auth/.env`.

## Architecture

This is an **OAuth 2.1 PKCE+DCR gateway** that sits in front of the official [`github-mcp-server`](https://github.com/github/github-mcp-server) container (running unauthenticated on `127.0.0.1:3060`) and gives every MCP client its own GitHub identity. The container is unchanged; we swap the `Authorization` header per-request.

### Request flow (read these together to understand the whole)

1. **OAuth metadata + DCR** ([src/http.ts](src/http.ts), [src/oauth.ts](src/oauth.ts)) — `mcpAuthRouter` from `@modelcontextprotocol/sdk` mounts `/.well-known/*`, `/register`, `/authorize`, `/token`, `/revoke` and delegates to `oauthProvider` in [src/oauth.ts](src/oauth.ts).
2. **`/authorize` hijack** ([src/oauth.ts:109](src/oauth.ts#L109)) — instead of rendering a UI, we persist the claude.ai PKCE challenge in `oauth_pending_state` keyed by a random `state_token`, then 302 the browser to `github.com/login/oauth/authorize` with that token as GitHub's `state`.
3. **GitHub callback** ([src/http.ts:40](src/http.ts#L40)) — `/oauth/github/callback` looks up the pending state, runs `completeGithubLogin` ([src/github-oauth.ts:129](src/github-oauth.ts#L129)) to exchange GitHub's code → token → user, upserts the encrypted token into `github_users`, mints **our** auth code, and 302s back to claude.ai's `redirect_uri` carrying the original `state`.
4. **`/token` exchange** ([src/oauth.ts:128](src/oauth.ts#L128)) — claude.ai gets an opaque UUID access token + refresh token; both rows in `oauth_access_tokens` / `oauth_refresh_tokens` point at a `github_user_id`.
5. **`/mcp` proxy** ([src/auth.ts](src/auth.ts) → [src/proxy.ts](src/proxy.ts)) — `bearerAuth` validates the opaque token, calls `getValidAccessTokenFor` ([src/github-oauth.ts:161](src/github-oauth.ts#L161)) to refresh the GitHub token if expiring, attaches `req.tenant`. `buildMcpProxy` then rewrites `Authorization: Bearer <user's GitHub token>` on the way to `127.0.0.1:3060`.

### Key invariants

- **Two distinct opaque-token namespaces**: tokens we issue to claude.ai (UUIDs in `oauth_access_tokens`) are completely separate from GitHub access tokens (in `github_users.access_ciphertext`). The bridge is `github_user_id`.
- **All GitHub tokens are AES-256-GCM at rest** ([src/crypto.ts](src/crypto.ts)). The key is HKDF-derived from `API_KEY_HASH_SALT` with the info label `"github-mcp-auth oauth token encryption v1"` — do not change this label or all stored tokens decrypt-fail. The same env var (with different HKDF info — actually just SHA-256 with salt) drives the `tenant_id_hash` derivation in [src/auth.ts:26](src/auth.ts#L26).
- **Migrations auto-run on startup** ([src/db.ts:19](src/db.ts#L19)) — every `.sql` in `migrations/` is re-executed in lexical order each boot. They must therefore be idempotent (`CREATE TABLE IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`, additive `ALTER`s only).
- **`GITHUB_ALLOWED_USERS`** (CSV of GitHub logins, [src/github-oauth.ts:113](src/github-oauth.ts#L113)) is the deny-by-default switch. Empty = anyone with a GitHub account can authorize.
- **Token TTLs**: claude.ai access tokens 1h, refresh tokens 30d, auth codes + pending-state rows 10m (constants at top of [src/oauth.ts](src/oauth.ts)). The GitHub access token's own expiry is independent and handled by `getValidAccessTokenFor` with a 30s skew.

### Pattern this codebase follows

This server mirrors the `hospitable-mcp` / `skillbuilder-mcp` pattern already on the VPS — opaque tokens (not JWT), `mcpAuthRouter` from the official SDK, Postgres for state, AES-GCM at rest. Don't introduce JWTs or Authentik; if you need a sibling MCP gateway, copy this layout.

## Environment

All required env vars are validated at startup in [src/index.ts](src/index.ts):

- `DATABASE_URL` — Postgres connection string (dedicated db `github_mcp` on shared VPS Postgres).
- `API_KEY_HASH_SALT` — ≥32 chars random; drives both the token-encryption HKDF key and the tenant-id-hash salt. **Rotating this orphans every stored GitHub token**.
- `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` — from the GitHub OAuth App.
- `BASE_URL` — `https://github.nlma.io` in prod. Used for OAuth metadata issuer and the GitHub callback URL.
- `GITHUB_SCOPES` (default `repo,read:org,read:user,read:project`), `UPSTREAM_MCP_URL` (default `http://127.0.0.1:3060`), `GITHUB_ALLOWED_USERS` (optional CSV allowlist).
