-- AI-generated. See PROMPT.md for the prompts and model used.

CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE users (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email         TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'user',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE repos (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  canonical_url  TEXT UNIQUE NOT NULL,
  display_name   TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE user_repos (
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  repo_id    UUID NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  access     TEXT NOT NULL,
  granted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, repo_id)
);

CREATE TABLE sessions (
  id                   TEXT PRIMARY KEY,
  user_id              UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  repo_id              UUID REFERENCES repos(id),
  agent                TEXT NOT NULL,
  agent_version        TEXT NOT NULL,
  branch               TEXT,
  source_cwd_hint      TEXT NOT NULL,
  model                TEXT,
  started_at           TIMESTAMPTZ NOT NULL,
  ended_at             TIMESTAMPTZ NOT NULL,
  total_input_tokens   INTEGER NOT NULL DEFAULT 0,
  total_output_tokens  INTEGER NOT NULL DEFAULT 0,
  total_cost_usd       NUMERIC(10,6) NOT NULL DEFAULT 0,
  permission_mode      TEXT,
  is_private           BOOLEAN NOT NULL DEFAULT false,
  name                 TEXT,
  has_blob             BOOLEAN NOT NULL DEFAULT false,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_sessions_user_repo ON sessions(user_id, repo_id);
CREATE INDEX idx_sessions_repo_branch ON sessions(repo_id, branch);
CREATE INDEX idx_sessions_started_at ON sessions(started_at DESC);

CREATE TABLE events (
  session_id   TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  event_uuid   TEXT NOT NULL,
  parent_uuid  TEXT,
  ts           TIMESTAMPTZ NOT NULL,
  type         TEXT NOT NULL,
  payload      JSONB NOT NULL,
  PRIMARY KEY (session_id, event_uuid)
);
CREATE INDEX idx_events_session_ts ON events(session_id, ts);

CREATE TABLE summaries (
  session_id        TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
  title             TEXT,
  summary           TEXT,
  tags              TEXT[] NOT NULL DEFAULT '{}',
  files_touched     TEXT[] NOT NULL DEFAULT '{}',
  prs_referenced    TEXT[] NOT NULL DEFAULT '{}',
  tool_call_counts  JSONB NOT NULL DEFAULT '{}'::jsonb,
  generated_at      TIMESTAMPTZ,
  model             TEXT,
  status            TEXT NOT NULL DEFAULT 'pending',
  error             TEXT
);
CREATE OR REPLACE FUNCTION summaries_fts_text(t TEXT, s TEXT, tags TEXT[])
RETURNS tsvector AS $$
  SELECT to_tsvector('english'::regconfig,
    coalesce(t,'') || ' ' || coalesce(s,'') || ' ' || array_to_string(coalesce(tags,'{}'::text[]), ' ')
  );
$$ LANGUAGE SQL IMMUTABLE;

CREATE INDEX idx_summaries_fts ON summaries USING gin (summaries_fts_text(title, summary, tags));

CREATE TABLE embeddings (
  session_id      TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
  embedding       vector(1536) NOT NULL,
  embedding_model TEXT NOT NULL,
  version         INTEGER NOT NULL DEFAULT 1,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_embeddings_cosine ON embeddings USING hnsw (embedding vector_cosine_ops);

CREATE TABLE session_blobs (
  session_id    TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
  jsonl_bytes   BYTEA NOT NULL,
  byte_size     INTEGER NOT NULL,
  uploaded_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE session_pr_links (
  session_id    TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  pr_url        TEXT NOT NULL,
  source        TEXT NOT NULL,
  validated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (session_id, pr_url)
);

CREATE TABLE audit_log (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_user_id       UUID REFERENCES users(id),
  action              TEXT NOT NULL,
  target_session_id   TEXT,
  ts                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  detail              JSONB
);
CREATE INDEX idx_audit_actor_ts ON audit_log(actor_user_id, ts DESC);
