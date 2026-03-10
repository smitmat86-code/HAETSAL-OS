-- THE Brain: Observability tables
-- Metadata only — NEVER store plaintext memory content here

CREATE TABLE IF NOT EXISTS memory_audit (
  id              TEXT PRIMARY KEY,    -- ulid
  tenant_id       TEXT NOT NULL,
  created_at      INTEGER NOT NULL,   -- unix ms
  operation       TEXT NOT NULL,      -- 'retained' | 'recalled' | 'reflected' | 'deleted'
  memory_id       TEXT,               -- Hindsight memory UUID (if applicable)
  memory_type     TEXT,               -- 'episodic' | 'semantic' | 'procedural' | 'world'
  domain          TEXT,               -- 'career' | 'health' | etc.
  agent_identity  TEXT,               -- canonical agent string or NULL for user
  provenance      TEXT,               -- 'sms' | 'email' | 'obsidian' | etc.
  salience_tier   INTEGER,            -- 1 | 2 | 3
  trace_id        TEXT,               -- links to agent_traces
  -- NEVER: content, plaintext, summary, raw_text
  FOREIGN KEY (tenant_id) REFERENCES tenants(id)
);

CREATE INDEX IF NOT EXISTS idx_memory_audit_tenant_created
  ON memory_audit(tenant_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_memory_audit_memory_id
  ON memory_audit(memory_id);

CREATE TABLE IF NOT EXISTS agent_traces (
  id              TEXT PRIMARY KEY,   -- ulid = trace_id
  tenant_id       TEXT NOT NULL,
  parent_trace_id TEXT,               -- NULL for root; links to parent agent trace
  agent_identity  TEXT NOT NULL,
  session_id      TEXT NOT NULL,
  started_at      INTEGER NOT NULL,
  completed_at    INTEGER,
  tool_calls      INTEGER NOT NULL DEFAULT 0,
  tokens_in       INTEGER,
  tokens_out      INTEGER,
  cost_usd        REAL,
  outcome         TEXT,               -- 'completed' | 'failed' | 'circuit_broken'
  reasoning_trace_encrypted TEXT,     -- encrypted with tenant key — may be NULL
  -- reasoning_trace is optional; never store plaintext here
  FOREIGN KEY (tenant_id) REFERENCES tenants(id)
);

CREATE INDEX IF NOT EXISTS idx_agent_traces_tenant_session
  ON agent_traces(tenant_id, session_id);

CREATE INDEX IF NOT EXISTS idx_agent_traces_parent
  ON agent_traces(parent_trace_id);

CREATE TABLE IF NOT EXISTS agent_cost_summary (
  id              TEXT PRIMARY KEY,   -- ulid
  tenant_id       TEXT NOT NULL,
  agent_identity  TEXT NOT NULL,
  period_start    INTEGER NOT NULL,   -- unix ms
  period_end      INTEGER NOT NULL,
  total_calls     INTEGER NOT NULL DEFAULT 0,
  total_tokens_in INTEGER NOT NULL DEFAULT 0,
  total_tokens_out INTEGER NOT NULL DEFAULT 0,
  total_cost_usd  REAL NOT NULL DEFAULT 0,
  FOREIGN KEY (tenant_id) REFERENCES tenants(id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_cost_summary_unique
  ON agent_cost_summary(tenant_id, agent_identity, period_start);

CREATE TABLE IF NOT EXISTS ingestion_events (
  id              TEXT PRIMARY KEY,   -- ulid
  tenant_id       TEXT NOT NULL,
  created_at      INTEGER NOT NULL,
  source          TEXT NOT NULL,      -- 'sms' | 'gmail' | 'calendar' | 'obsidian' | 'file'
  salience_tier   INTEGER NOT NULL,
  surprise_score  REAL,               -- 0.0–1.0
  memory_id       TEXT,               -- Hindsight UUID once retained
  r2_key          TEXT,               -- raw artifact in R2_ARTIFACTS if applicable
  dedup_hash      TEXT NOT NULL UNIQUE, -- SHA-256 of content for dedup
  FOREIGN KEY (tenant_id) REFERENCES tenants(id)
);

CREATE INDEX IF NOT EXISTS idx_ingestion_events_tenant_created
  ON ingestion_events(tenant_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_ingestion_events_dedup
  ON ingestion_events(dedup_hash);

CREATE TABLE IF NOT EXISTS cron_executions (
  id              TEXT PRIMARY KEY,   -- ulid
  tenant_id       TEXT NOT NULL,
  cron_name       TEXT NOT NULL,      -- 'consolidation' | 'gap_discovery' | 'morning_brief' | etc.
  started_at      INTEGER NOT NULL,
  completed_at    INTEGER,
  outcome         TEXT,               -- 'completed' | 'failed' | 'deferred_no_kek'
  pass_results    TEXT,               -- JSON summary of pass outcomes (no content)
  error_message   TEXT,
  FOREIGN KEY (tenant_id) REFERENCES tenants(id)
);

CREATE INDEX IF NOT EXISTS idx_cron_executions_tenant_cron
  ON cron_executions(tenant_id, cron_name, started_at DESC);
