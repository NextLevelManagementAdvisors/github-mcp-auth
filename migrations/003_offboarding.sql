-- Self-service connector offboarding + the approved-email-domain allowlist.
--
-- Migrations re-run on every boot (src/db.ts), so everything here is idempotent.

-- The verified GitHub email that admitted this user. Retained so the
-- offboarding flow can say *whose* connector it is about to turn off without
-- another GitHub API round trip.
ALTER TABLE github_users ADD COLUMN IF NOT EXISTS email TEXT;

CREATE INDEX IF NOT EXISTS github_users_email_idx ON github_users (LOWER(email));

-- An in-flight GitHub redirect is now either an authorization ('authorize') or
-- a self-service disconnect ('disconnect'); /oauth/github/callback branches on
-- this. A disconnect dance has no claude.ai client on the other side, so the
-- three PKCE/client columns become nullable for those rows.
ALTER TABLE oauth_pending_state ADD COLUMN IF NOT EXISTS purpose TEXT NOT NULL DEFAULT 'authorize';

ALTER TABLE oauth_pending_state ALTER COLUMN client_id DROP NOT NULL;
ALTER TABLE oauth_pending_state ALTER COLUMN redirect_uri DROP NOT NULL;
ALTER TABLE oauth_pending_state ALTER COLUMN code_challenge DROP NOT NULL;
