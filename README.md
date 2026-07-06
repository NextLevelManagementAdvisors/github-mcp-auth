# github-mcp-auth

Multi-tenant OAuth 2.1 gateway in front of the official [`github-mcp-server`](https://github.com/github/github-mcp-server). Each MCP client (claude.ai, Claude Desktop, etc.) authorizes with **its own** GitHub OAuth identity; the gateway swaps in that user's GitHub token before forwarding to the upstream container.

```
claude.ai ──OAuth 2.1 (PKCE, DCR)──> https://github.nlma.io (nginx)
                                       └─> 127.0.0.1:3061   github-mcp-auth (this server)
                                              │ (validates opaque bearer, swaps Authorization header)
                                              └─> 127.0.0.1:3060   github-mcp-server (official container)
                                                                    └─> api.github.com (as the actual user)
```

## How auth works

1. claude.ai discovers OAuth metadata at `/.well-known/oauth-protected-resource` + `/.well-known/oauth-authorization-server` (served by `mcpAuthRouter` from `@modelcontextprotocol/sdk`).
2. claude.ai registers itself via Dynamic Client Registration (RFC 7591) at `POST /register`.
3. claude.ai sends the user's browser to `/authorize?...&code_challenge=...&code_challenge_method=S256`.
4. The gateway stashes the PKCE state in Postgres under a random `state_token`, then 302-redirects the browser to `github.com/login/oauth/authorize` with that token as the `state` parameter.
5. The user approves on GitHub; GitHub redirects back to `/oauth/github/callback?code=...&state=...`.
6. The gateway exchanges GitHub's `code` for the user's GitHub access token, looks up their GitHub user id + login, encrypts the token with AES-256-GCM, and stores it in `github_users`.
7. The gateway 302-redirects the browser back to claude.ai's `redirect_uri` with our **own** auth code (opaque UUID).
8. claude.ai POSTs `/token` to exchange that code for an opaque access token (also a UUID, points at the GitHub user).
9. On every subsequent `POST /mcp`, the gateway: validates the opaque bearer → looks up the underlying GitHub user → refreshes the GitHub token if expiring → rewrites `Authorization: Bearer <user's GitHub token>` → reverse-proxies to `127.0.0.1:3060`.

`github-mcp-server` itself is unchanged; it just sees a normal authenticated request with a per-user GitHub token.

## Why this pattern (and not JWT RS256 / Authentik)

- **Opaque tokens, not JWT.** Matches the existing `mcpAuthRouter` pattern in `hospitable-mcp` and `skillbuilder-mcp` on this VPS. Simpler revocation, no JWKS to publish or rotate.
- **Custom Express, not Authentik.** ~500 LOC and one systemd unit. Authentik would be one more service to operate for a use case the SDK already covers.

## Environment

Copy `.env.example` to `.env` and fill in. Required:

| Var                      | Notes                                                                                                  |
| ------------------------ | ------------------------------------------------------------------------------------------------------ |
| `DATABASE_URL`           | Postgres. Reuse the existing VPS Postgres; use a dedicated DB `github_mcp`.                            |
| `API_KEY_HASH_SALT`      | ≥32 chars random. Drives AES-256-GCM key for token-at-rest **and** the per-user identifier hash.      |
| `GITHUB_CLIENT_ID`       | From the GitHub OAuth App you register (see below).                                                   |
| `GITHUB_CLIENT_SECRET`   | Same. Treat as secret. `.env` should be `chmod 600`.                                                   |
| `BASE_URL`               | `https://github.nlma.io`                                                                               |
| `GITHUB_SCOPES`          | Default `repo,read:org,read:user,read:project,workflow`. `workflow` is required to create/update `.github/workflows/*` files. Bump if a tool needs more. |
| `UPSTREAM_MCP_URL`       | Default `http://127.0.0.1:3060` — the github-mcp-server docker container.                              |
| `GITHUB_ALLOWED_USERS`   | Optional CSV allowlist of GitHub logins. Empty = anyone with a GitHub account.                         |

## Deployment

### One-time setup (manual)

1. **Register the GitHub OAuth App** at <https://github.com/settings/developers> (or in an org if you want centralized management):
   - Homepage URL: `https://github.nlma.io`
   - Authorization callback URL: `https://github.nlma.io/oauth/github/callback`
   - Enable Device Flow: **no**
   - Webhook: **off**
   - After creating, copy `Client ID` and generate a `Client secret`. Paste into `/opt/github-mcp-auth/.env` on the VPS.
2. **Create the Postgres database** on the VPS:
   ```bash
   sudo -u postgres psql -c "CREATE USER github_mcp WITH PASSWORD '<strong>';"
   sudo -u postgres psql -c "CREATE DATABASE github_mcp OWNER github_mcp;"
   ```
   Put the corresponding `DATABASE_URL` into `.env`.
3. **Generate a master encryption key**:
   ```bash
   openssl rand -hex 32   # 64 hex chars = 64 bytes; well over the 32-char minimum
   ```
   Paste into `API_KEY_HASH_SALT` in `.env`.
4. **Rotate the existing PAT** (`ghp_GHh3rtDc...`) in `/opt/github-mcp/.env` — it appeared in a chat transcript. Either rotate it or delete it entirely; once this gateway is live the static PAT is no longer the auth path.

### Push & install

From the laptop:

```bash
cd c:/Users/forre/Source/github-mcp-auth
npm install                # local sanity
npm run build              # local typecheck
bash scripts/push-to-vps.sh   # uploads, builds on VPS, restarts service
```

First-time installation on the VPS (after the first `push-to-vps.sh` has put the working tree at `/opt/github-mcp-auth/`):

```bash
ssh root@178.16.141.166 'bash /opt/github-mcp-auth/scripts/install-on-vps.sh'
```

This:
- Installs `/etc/systemd/system/github-mcp-auth.service` and enables it.
- Installs `/etc/nginx/conf.d/limit-req-github.conf` (rate limit zone).
- **Replaces** `/etc/nginx/sites-enabled/github.nlma.io` to point at `:3061` (the gateway) instead of `:3060` (the bare container).
- Runs `npm ci && npm run build && systemctl restart`.
- Curls `/health` to confirm.

### What the user adds to their MCP client

```
https://github.nlma.io/mcp
```

That's it. claude.ai handles the OAuth dance; the user is redirected to GitHub to authorize on first connect.

## Smoke test

```bash
# OAuth metadata
curl -s https://github.nlma.io/.well-known/oauth-protected-resource | jq .
curl -s https://github.nlma.io/.well-known/oauth-authorization-server | jq .

# Health
curl -s https://github.nlma.io/health

# Without a bearer, /mcp must 401 with a WWW-Authenticate header
curl -i https://github.nlma.io/mcp -X POST -H 'Content-Type: application/json' \
     -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}'
```

## Schema

See `migrations/001_initial.sql` + `migrations/002_oauth.sql`. Notable tables:

- `github_users` — one row per GitHub user we've ever authenticated. Holds the encrypted access (and refresh) tokens.
- `oauth_access_tokens` — opaque tokens issued to claude.ai. Points at `github_users.github_user_id`.
- `oauth_pending_state` — short-lived rows for in-flight GitHub OAuth dances; carries the claude.ai PKCE challenge across the GitHub redirect.

## Security notes

- GitHub tokens are AES-256-GCM-encrypted at rest. Key is HKDF-derived from `API_KEY_HASH_SALT` with a distinct info label.
- Tokens issued to claude.ai are opaque UUIDs; nothing about the GitHub user is recoverable from them without the database.
- `tenants.tenant_id_hash` is a salted SHA-256 of the GitHub user id, so audit logs don't directly expose user ids.
- `GITHUB_ALLOWED_USERS` provides a deny-by-default mode while testing.
- Revoke a user: `DELETE FROM github_users WHERE github_login = '...'` cascades effectively (their opaque tokens won't resolve, and proxy requests will 401).
