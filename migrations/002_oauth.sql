-- OAuth 2.1 state for claude.ai clients. Tokens issued to claude.ai are opaque
-- UUIDs that point at a github_user record holding the encrypted-at-rest
-- GitHub access/refresh tokens.

CREATE TABLE IF NOT EXISTS oauth_clients (
    client_id          TEXT PRIMARY KEY,
    client_data        JSONB NOT NULL,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- An in-progress GitHub OAuth dance. Lifetime: from /authorize → /oauth/github/callback.
-- state_token is what we hand to GitHub as the `state` parameter; it's also the
-- key we look up to recover the original claude.ai PKCE challenge + redirect.
CREATE TABLE IF NOT EXISTS oauth_pending_state (
    state_token        TEXT PRIMARY KEY,
    client_id          TEXT NOT NULL,
    redirect_uri       TEXT NOT NULL,
    code_challenge     TEXT NOT NULL,
    claude_state       TEXT,
    expires_at         TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS oauth_pending_state_expires_idx ON oauth_pending_state (expires_at);

-- Authorization codes issued back to claude.ai after a successful GitHub login.
-- Points at the github_user row whose token we should hand the bearer at /token-exchange time.
CREATE TABLE IF NOT EXISTS oauth_auth_codes (
    code               TEXT PRIMARY KEY,
    client_id          TEXT NOT NULL,
    redirect_uri       TEXT NOT NULL,
    code_challenge     TEXT NOT NULL,
    github_user_id     BIGINT NOT NULL,
    expires_at         TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS oauth_auth_codes_expires_idx ON oauth_auth_codes (expires_at);

-- Access/refresh tokens we hand to claude.ai. They're opaque UUIDs.
-- The github_user_id is the join to github_users where the real token lives.
CREATE TABLE IF NOT EXISTS oauth_access_tokens (
    token              TEXT PRIMARY KEY,
    client_id          TEXT NOT NULL,
    github_user_id     BIGINT NOT NULL,
    scopes             TEXT[] NOT NULL DEFAULT '{}',
    expires_at         TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS oauth_access_tokens_expires_idx ON oauth_access_tokens (expires_at);
CREATE INDEX IF NOT EXISTS oauth_access_tokens_user_idx ON oauth_access_tokens (github_user_id);

CREATE TABLE IF NOT EXISTS oauth_refresh_tokens (
    token              TEXT PRIMARY KEY,
    client_id          TEXT NOT NULL,
    github_user_id     BIGINT NOT NULL,
    scopes             TEXT[] NOT NULL DEFAULT '{}',
    expires_at         TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS oauth_refresh_tokens_expires_idx ON oauth_refresh_tokens (expires_at);

-- One row per GitHub user we've ever seen. Holds the encrypted GitHub access
-- (and optional refresh) token used when proxying MCP requests upstream.
CREATE TABLE IF NOT EXISTS github_users (
    github_user_id         BIGINT PRIMARY KEY,
    github_login           TEXT NOT NULL,
    access_ciphertext      BYTEA NOT NULL,
    access_iv              BYTEA NOT NULL,
    access_tag             BYTEA NOT NULL,
    access_expires_at      TIMESTAMPTZ,
    refresh_ciphertext     BYTEA,
    refresh_iv             BYTEA,
    refresh_tag            BYTEA,
    refresh_expires_at     TIMESTAMPTZ,
    scopes                 TEXT[] NOT NULL DEFAULT '{}',
    created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS github_users_login_idx ON github_users (github_login);
