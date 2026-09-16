/** Shared by startup and the explicit legacy-owner binding command. */
export const AUTH_SCHEMA = `
CREATE TABLE IF NOT EXISTS bio_auth_users (id text PRIMARY KEY, phone text NOT NULL UNIQUE, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS bio_auth_codes (phone text PRIMARY KEY, digest text NOT NULL, expires_at timestamptz NOT NULL, attempts int NOT NULL DEFAULT 0, ready boolean NOT NULL DEFAULT false);
CREATE TABLE IF NOT EXISTS bio_auth_sends (id text PRIMARY KEY, phone_key text NOT NULL, ip_key text NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX IF NOT EXISTS bio_auth_sends_phone ON bio_auth_sends(phone_key, created_at);
CREATE INDEX IF NOT EXISTS bio_auth_sends_ip ON bio_auth_sends(ip_key, created_at);
CREATE TABLE IF NOT EXISTS bio_auth_sessions (digest text PRIMARY KEY, user_id text NOT NULL REFERENCES bio_auth_users(id), expires_at timestamptz NOT NULL);
CREATE INDEX IF NOT EXISTS bio_auth_sessions_user ON bio_auth_sessions(user_id);
`;
