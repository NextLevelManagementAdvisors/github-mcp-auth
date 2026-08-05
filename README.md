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

## Turning a connector off

Users offboard themselves — no admin and no SQL. Two entry points, both proving control of the GitHub account whose credentials get deleted:

- **Browser** — `GET /disconnect` explains what will be deleted; the button posts to `/disconnect/start`, which sends the user through GitHub and back to `/oauth/github/callback`. Linked from the splash page.
- **API** — `POST /disconnect` with the bearer token the MCP client already holds:

  ```bash
  curl -X POST https://github.nlma.io/disconnect -H 'Authorization: Bearer <access_token>'
  ```

Either path deletes every opaque access/refresh token issued for that user, any in-flight auth code, their encrypted GitHub credentials, and their `tenants` row — then revokes the OAuth App grant on GitHub's side so the connector is genuinely off rather than merely forgotten locally (best-effort; the response reports whether GitHub confirmed). `audit_log` rows are kept: they identify the user only by a salted hash, and an audit trail the product can erase isn't one.

Offboarding deliberately does **not** re-check `GITHUB_APPROVED_EMAIL_DOMAINS`. That gate decides who may *connect*; applying it to disconnection would mean dropping a domain from the allowlist strands its users with a connector they can no longer turn off. Any GitHub account that has connected here can disconnect itself — and only itself.

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
| `GITHUB_SCOPES`          | Default `repo,read:org,read:user,user:email,read:project,workflow`. `workflow` is required to create/update `.github/workflows/*` files; `user:email` is required to read verified emails for `GITHUB_APPROVED_EMAIL_DOMAINS`. Bump if a tool needs more. |
| `UPSTREAM_MCP_URL`       | Default `http://127.0.0.1:3060` — the github-mcp-server docker container.                              |
| `GITHUB_ALLOWED_USERS`   | Optional CSV allowlist of GitHub logins. Empty = no login gate.                                        |
| `GITHUB_APPROVED_EMAIL_DOMAINS` | Optional CSV of *additional* approved email domains, layered on top of the org-wide registry below. Most deployments leave this empty. |
| `NLMA_AUTHORIZED_DOMAINS_URL` | Org-wide authorized-domains registry, synced at boot and every 5 minutes. Defaults to `https://status.nlma.io/domains.json` — override only for local dev or if the registry moves. |

### Three allowlists, OR'd together

Any of the three admits a user — none are AND'd:

- **`NLMA_AUTHORIZED_DOMAINS_URL`** — the shared source of truth: an org-wide list of approved email domains, maintained once at `status.nlma.io` and consumed by every OAuth sidecar on the VPS (this gateway included), not just this repo. Synced automatically; nothing to configure for the common case.
- **`GITHUB_APPROVED_EMAIL_DOMAINS`** — a local *addition* to the registry, for a domain that's approved for this connector specifically but not (yet, or ever) org-wide.
- **`GITHUB_ALLOWED_USERS`** — named individuals: contractors, a break-glass account, anyone whose email domain isn't the point.

A user is admitted when one of their **verified** GitHub emails matches an approved domain (registry ∪ local, deduped), or their login is on `GITHUB_ALLOWED_USERS`. Domain matching runs downward only — `nlma.io` admits `me@nlma.io`, `me@status.nlma.io` and `me@eu.status.nlma.io`; listing `status.nlma.io` instead would admit the subdomains but **not** the parent `me@nlma.io`. With all three empty, anyone with a GitHub account can authorize.

`GET /health` reports the resulting gate: `access_gate`, the merged `approved_email_domains`, `allowed_login_count`, and a `domains_registry` block (`synced`, `domain_count`, `last_synced_at`, `last_error`) — so you can confirm what's actually loaded and whether the last sync succeeded, rather than what you meant to set. Domains are listed (the registry itself calls the list "not secret," and the splash page already shows it); the login allowlist is only counted, never named.

Only **verified** GitHub emails count toward a domain match — an unverified address proves nothing, since anyone can type `someone@your-company.com` into their GitHub profile. If a domain gate is configured and the grant can't read email addresses at all (missing `user:email`), authorization **fails closed** and tells the user to re-authorize.

**The registry sync degrades safely.** A failed fetch — the endpoint down, a timeout, a malformed response — never clears the last known-good list and never opens the gate; it logs and keeps serving what it last had (`domains_registry.last_error` in `/health` will show it). The very first fetch is awaited at boot, so the gate is populated before the server accepts its first request; if that first fetch itself fails (e.g. `status.nlma.io` is down exactly at cold start), the registry starts empty and effective gating falls back to whatever `GITHUB_APPROVED_EMAIL_DOMAINS` / `GITHUB_ALLOWED_USERS` provide locally — the same behavior this gateway had before the registry existed.

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

# Health — reports which allowlists are live, including the org-wide registry sync:
#   {"status":"ok","server":"github-mcp-auth","access_gate":"allowlisted",
#    "approved_email_domains":["aristidemanagement.com","fidumcompany.com","hvacfrontroyal.com",
#      "mattmirus.com","nextlevelmanagementadvisors.com","nlma.io","propmanageplus.com",
#      "tra-lawfirm.com","zipadeeservices.com"],
#    "allowed_login_count":1,
#    "domains_registry":{"url":"https://status.nlma.io/domains.json","synced":true,
#      "domain_count":9,"last_synced_at":"2026-07-28T15:39:32.000Z","last_error":null}}
# `access_gate` is "open" only if the registry sync has never succeeded AND both
# local allowlists are empty. `domains_registry.last_error` is set (and the list
# stays whatever it last was) if a poll fails — check this after a deploy, since
# `npm run deploy` does not touch the VPS .env for GITHUB_APPROVED_EMAIL_DOMAINS.
curl -s https://github.nlma.io/health | jq .

# Without a bearer, /mcp must 401 with a WWW-Authenticate header
curl -i https://github.nlma.io/mcp -X POST -H 'Content-Type: application/json' \
     -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}'

# Offboarding: the page renders, and the form target 302s to github.com
curl -s https://github.nlma.io/disconnect | grep -o '/disconnect/start'
curl -si -X POST https://github.nlma.io/disconnect/start | grep -i '^location'

# Without a bearer, POST /disconnect must 401 (never a silent no-op)
curl -si -X POST https://github.nlma.io/disconnect | head -1
```

## Schema

See `migrations/001_initial.sql`, `002_oauth.sql`, `003_offboarding.sql`. Notable tables:

- `github_users` — one row per GitHub user we've ever authenticated. Holds the encrypted access (and refresh) tokens, plus the verified `email` that admitted them.
- `oauth_access_tokens` — opaque tokens issued to claude.ai. Points at `github_users.github_user_id`.
- `oauth_pending_state` — short-lived rows for in-flight GitHub OAuth dances; carries the claude.ai PKCE challenge across the GitHub redirect. `purpose` is `authorize` or `disconnect`; a `disconnect` row has no client/PKCE columns because there's no MCP client on the other side.

The org-wide domains registry (`domains-registry.ts`) is deliberately **not** persisted — it's an in-memory cache of a remote list that resyncs every 5 minutes and again on every restart, so a database row would only ever be a snapshot no more trustworthy than the live fetch.

## Security notes

- GitHub tokens are AES-256-GCM-encrypted at rest. Key is HKDF-derived from `API_KEY_HASH_SALT` with a distinct info label.
- Tokens issued to claude.ai are opaque UUIDs; nothing about the GitHub user is recoverable from them without the database.
- `tenants.tenant_id_hash` is a salted SHA-256 of the GitHub user id, so audit logs don't directly expose user ids.
- `GITHUB_ALLOWED_USERS`, `GITHUB_APPROVED_EMAIL_DOMAINS`, and the `NLMA_AUTHORIZED_DOMAINS_URL` registry sync together provide deny-by-default modes; only verified GitHub emails satisfy a domain gate, and a configured domain gate fails closed when emails can't be read.
- The registry endpoint (`/domains.json` on `status.nlma.io`) is public and unauthenticated by design — its own nginx config says so ("the list is not secret"). Don't add auth to the request this gateway makes to it; that would just mean this gateway breaks when the registry's auth story changes, for a list that was never secret.
- Users can revoke themselves — see [Turning a connector off](#turning-a-connector-off).
- Revoke a user as admin: `DELETE FROM github_users WHERE github_login = '...'` cascades effectively (their opaque tokens won't resolve, and proxy requests will 401). Unlike `/disconnect`, this leaves the OAuth App grant in place on GitHub's side.
## License

Copyright © 2026 Next Level Management Advisors, LLC.

Licensed under the **GNU Affero General Public License v3.0** (AGPL-3.0) — see [LICENSE](LICENSE). If you run a modified version over a network, the AGPL requires you to make your modified source available to its users.

**Commercial licensing:** to use this in a closed-source or commercial product, or to host a modified version without publishing your source, a commercial license is available — contact **forrest@nlma.io**.
