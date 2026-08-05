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
5. **`/mcp` proxy** ([src/auth.ts](src/auth.ts) → [src/proxy.ts](src/proxy.ts)) — `bearerAuth` validates the opaque token, calls `getValidAccessTokenFor` to refresh the GitHub token if expiring, attaches `req.tenant`. `buildMcpProxy` then rewrites `Authorization: Bearer <user's GitHub token>` on the way to `127.0.0.1:3060`.
6. **Offboarding** ([src/http.ts](src/http.ts)) — `GET /disconnect` → `POST /disconnect/start` stores a pending-state row with `purpose='disconnect'` and reuses the *same* GitHub redirect; `/oauth/github/callback` branches on `purpose` and calls `identifyGithubUser` (exchange + fetch, **persists nothing**) then `offboardGithubUser`. `POST /disconnect` is the bearer-authenticated equivalent.
7. **Domains registry sync** ([src/domains-registry.ts](src/domains-registry.ts)) — [src/index.ts](src/index.ts) awaits `startDomainsRegistrySync()` (one fetch of `NLMA_AUTHORIZED_DOMAINS_URL`, default `https://status.nlma.io/domains.json`) before `listen()`, then polls every 5 minutes in the background. `getApprovedEmailDomains()` in [src/github-oauth.ts](src/github-oauth.ts) is the merge point: registry ∪ `GITHUB_APPROVED_EMAIL_DOMAINS`, deduped.

### Key invariants

- **Two distinct opaque-token namespaces**: tokens we issue to claude.ai (UUIDs in `oauth_access_tokens`) are completely separate from GitHub access tokens (in `github_users.access_ciphertext`). The bridge is `github_user_id`.
- **All GitHub tokens are AES-256-GCM at rest** ([src/crypto.ts](src/crypto.ts)). The key is HKDF-derived from `API_KEY_HASH_SALT` with the info label `"github-mcp-auth oauth token encryption v1"` — do not change this label or all stored tokens decrypt-fail. The same env var (with different HKDF info — actually just SHA-256 with salt) drives the `tenant_id_hash` derivation in [src/auth.ts:26](src/auth.ts#L26).
- **Migrations auto-run on startup** ([src/db.ts:19](src/db.ts#L19)) — every `.sql` in `migrations/` is re-executed in lexical order each boot. They must therefore be idempotent (`CREATE TABLE IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`, additive `ALTER`s only).
- **Three allowlists, OR'd** (`decideAccess` in [src/github-oauth.ts](src/github-oauth.ts)): `GITHUB_ALLOWED_USERS` (CSV of GitHub logins), `GITHUB_APPROVED_EMAIL_DOMAINS` (CSV of email domains, subdomains included), and the domains registry synced from `status.nlma.io` (see below). Any admits a user; all empty = anyone with a GitHub account. `GET /health` echoes the live gate (`access_gate`, `approved_email_domains`, `allowed_login_count`, `domains_registry`) — domains named, logins only counted; keep it that way. Only **verified** GitHub emails satisfy a domain gate, and when a domain gate is configured but `/user/emails` is unreadable (no `user:email` scope) it **fails closed** — don't "fix" that by defaulting to allow.
- **The domains registry fails safe, never open.** `domains-registry.ts` fetches `https://status.nlma.io/domains.json` — public and unauthenticated by design (that endpoint's own nginx config, `location = /domains.json` outside its `auth_request` gate, says "the list is not secret"). A failed poll (network, non-2xx, malformed body) logs and **keeps the last known-good list** rather than clearing it — clearing on a transient outage would silently open the gate to everyone. The first fetch is `await`ed in [src/index.ts](src/index.ts) before `listen()`, so a fresh boot never serves traffic with an empty, unsynced cache; if that very first fetch fails, the registry starts empty and gating falls back to whatever `GITHUB_APPROVED_EMAIL_DOMAINS` / `GITHUB_ALLOWED_USERS` provide locally. Do not add auth to this outbound request or persist the fetched list to Postgres — both would add a source of drift/failure for a list that is (a) explicitly not secret and (b) only ever as trustworthy as the next live fetch.
- **Offboarding is not domain-gated.** `/disconnect` requires only proof of the GitHub account, on purpose: gating a privilege *reduction* on the approved-domain allowlist would strand users whose domain was later removed. Don't add the gate there.
- **`identifyGithubUser` must never persist.** It backs the disconnect flow, whose whole job is deleting the row a normal login would write.
- **Token TTLs**: claude.ai access tokens 1h, refresh tokens 30d, auth codes + pending-state rows 10m (constants at top of [src/oauth.ts](src/oauth.ts)). The GitHub access token's own expiry is independent and handled by `getValidAccessTokenFor` with a 30s skew.

### Pattern this codebase follows

This server mirrors the `hospitable-mcp` / `skillbuilder-mcp` pattern already on the VPS — opaque tokens (not JWT), `mcpAuthRouter` from the official SDK, Postgres for state, AES-GCM at rest. Don't introduce JWTs or Authentik; if you need a sibling MCP gateway, copy this layout.

## Environment

All required env vars are validated at startup in [src/index.ts](src/index.ts):

- `DATABASE_URL` — Postgres connection string (dedicated db `github_mcp` on shared VPS Postgres).
- `API_KEY_HASH_SALT` — ≥32 chars random; drives both the token-encryption HKDF key and the tenant-id-hash salt. **Rotating this orphans every stored GitHub token**.
- `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` — from the GitHub OAuth App.
- `BASE_URL` — `https://github.nlma.io` in prod. Used for OAuth metadata issuer and the GitHub callback URL.
- `GITHUB_SCOPES` (default `repo,read:org,read:user,user:email,read:project,workflow` — `user:email` backs the domain allowlist), `UPSTREAM_MCP_URL` (default `http://127.0.0.1:3060`), `GITHUB_ALLOWED_USERS` (optional CSV of logins), `GITHUB_APPROVED_EMAIL_DOMAINS` (optional CSV of *additional* approved email domains, on top of the registry), `NLMA_AUTHORIZED_DOMAINS_URL` (optional override, default `https://status.nlma.io/domains.json`).
