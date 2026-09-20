/** Additive, idempotent migrations applied under a PostgreSQL advisory lock. */
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
ALTER TABLE bio_memory_calls ADD COLUMN IF NOT EXISTS call_summary jsonb;
ALTER TABLE bio_memory_calls ADD COLUMN IF NOT EXISTS initial_context jsonb;
ALTER TABLE bio_memory_calls ADD COLUMN IF NOT EXISTS opening_claimed boolean NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS bio_memory_calls_history ON bio_memory_calls(user_id, started_at DESC, id)
 WHERE status='ended' AND call_summary IS NOT NULL;
CREATE TABLE IF NOT EXISTS bio_voice_playback (
 call_id text NOT NULL REFERENCES bio_memory_calls(id) ON DELETE CASCADE,
 turn_id text NOT NULL, user_id text NOT NULL REFERENCES bio_memory_users(id),
 data jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(call_id,turn_id)
);
CREATE TABLE IF NOT EXISTS bio_documents (
 user_id text NOT NULL REFERENCES bio_memory_users(id) ON DELETE CASCADE,
 id text NOT NULL, origin_conversation_id uuid NOT NULL,
 version integer NOT NULL CHECK(version >= 1), body jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(user_id,id), CHECK(body->>'id'=id), CHECK((body->>'version')::integer=version)
);
CREATE TABLE IF NOT EXISTS bio_document_revisions (
 user_id text NOT NULL, document_id text NOT NULL, version integer NOT NULL,
 body jsonb NOT NULL, conversation_id uuid NOT NULL, summary text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(user_id,document_id,version),
 FOREIGN KEY(user_id,document_id) REFERENCES bio_documents(user_id,id) ON DELETE CASCADE
);
`;
