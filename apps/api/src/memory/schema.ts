/** Version 1, additive and idempotent. Applied under a PostgreSQL advisory lock. */
export const MEMORY_SCHEMA = `
CREATE TABLE IF NOT EXISTS bio_memory_users (
 id text PRIMARY KEY, overview jsonb NOT NULL DEFAULT '{"preferences":[],"entries":[]}',
 version integer NOT NULL DEFAULT 0, updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS bio_memory_sessions (
 id uuid PRIMARY KEY, user_id text NOT NULL REFERENCES bio_memory_users(id),
 snapshot jsonb NOT NULL DEFAULT '{}'
);
CREATE TABLE IF NOT EXISTS bio_memory_calls (
 id text PRIMARY KEY, user_id text NOT NULL REFERENCES bio_memory_users(id),
 conversation_id uuid NOT NULL REFERENCES bio_memory_sessions(id), connection_id text,
 status text NOT NULL CHECK(status IN ('active','disconnected','ended')),
 overview jsonb NOT NULL, started_at timestamptz NOT NULL DEFAULT now(),
 touched_at timestamptz NOT NULL DEFAULT now(), end_after timestamptz, ended_at timestamptz
);
CREATE TABLE IF NOT EXISTS bio_memory_messages (
 id uuid PRIMARY KEY, user_id text NOT NULL REFERENCES bio_memory_users(id),
 call_id text REFERENCES bio_memory_calls(id), conversation_id uuid NOT NULL REFERENCES bio_memory_sessions(id),
 run_id uuid NOT NULL, role text NOT NULL CHECK(role IN ('user','assistant','tool')),
 body text NOT NULL, origin text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 ordinal bigserial UNIQUE
);
CREATE INDEX IF NOT EXISTS bio_memory_messages_call ON bio_memory_messages(user_id, call_id, ordinal);
CREATE TABLE IF NOT EXISTS bio_memories (
 id uuid PRIMARY KEY, user_id text NOT NULL REFERENCES bio_memory_users(id),
 type text NOT NULL CHECK(type IN ('person','story','interaction')), title text NOT NULL,
 summary text NOT NULL, body text NOT NULL, active boolean NOT NULL DEFAULT true,
 version integer NOT NULL, updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS bio_memories_owner ON bio_memories(user_id, active);
CREATE TABLE IF NOT EXISTS bio_memory_revisions (
 memory_id uuid NOT NULL REFERENCES bio_memories(id), version integer NOT NULL,
 data jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(memory_id,version)
);
CREATE TABLE IF NOT EXISTS bio_memory_sources (
 memory_id uuid NOT NULL REFERENCES bio_memories(id), version integer NOT NULL,
 message_id uuid NOT NULL REFERENCES bio_memory_messages(id), PRIMARY KEY(memory_id,version,message_id)
);
CREATE TABLE IF NOT EXISTS bio_memory_overview_revisions (
 user_id text NOT NULL REFERENCES bio_memory_users(id), version integer NOT NULL,
 data jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(user_id,version)
);
CREATE TABLE IF NOT EXISTS bio_memory_jobs (
 call_id text PRIMARY KEY REFERENCES bio_memory_calls(id), user_id text NOT NULL REFERENCES bio_memory_users(id),
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','running','done','failed')),
 attempts integer NOT NULL DEFAULT 0, available_at timestamptz NOT NULL DEFAULT now(),
 error text, usage jsonb, created_at timestamptz NOT NULL DEFAULT now(), finished_at timestamptz
);
CREATE TABLE IF NOT EXISTS bio_memory_runs (id uuid PRIMARY KEY, user_id text NOT NULL REFERENCES bio_memory_users(id));
`;
