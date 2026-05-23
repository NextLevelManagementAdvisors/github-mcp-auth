CREATE TABLE IF NOT EXISTS tenants (
    tenant_id_hash  TEXT PRIMARY KEY,
    github_login    TEXT,
    github_user_id  BIGINT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_active_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS tenants_github_login_idx ON tenants (github_login);

CREATE TABLE IF NOT EXISTS audit_log (
    id              BIGSERIAL PRIMARY KEY,
    tenant_id_hash  TEXT,
    tool            TEXT NOT NULL,
    result          TEXT NOT NULL,
    error_message   TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS audit_log_tenant_idx ON audit_log (tenant_id_hash, created_at DESC);
