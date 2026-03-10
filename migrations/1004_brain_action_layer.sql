-- THE Brain: Action layer tables
-- All action content (email body, message text) stored encrypted in R2
-- D1 holds metadata, state, audit trail only

CREATE TABLE IF NOT EXISTS tenant_action_preferences (
  id                  TEXT PRIMARY KEY,   -- ulid
  tenant_id           TEXT NOT NULL,
  capability_class    TEXT NOT NULL,
  -- 'READ' | 'WRITE_INTERNAL' | 'WRITE_EXTERNAL_REVERSIBLE'
  -- 'WRITE_EXTERNAL_IRREVERSIBLE' | 'WRITE_EXTERNAL_FINANCIAL' | 'DELETE'
  integration         TEXT,               -- NULL = applies to all; 'gmail' | 'calendar' | etc.
  authorization_level TEXT NOT NULL,
  -- 'GREEN' | 'YELLOW' | 'RED'
  -- Hard floors enforced in Action Worker — this column is ADVISORY
  -- Authorization gate re-derives floor before trusting this value
  send_delay_seconds  INTEGER NOT NULL DEFAULT 120,
  confirmed_executions INTEGER NOT NULL DEFAULT 0,
  trust_threshold     INTEGER NOT NULL DEFAULT 10,
  requires_phrase     TEXT,               -- NULL or explicit required phrase for RED
  row_hmac            TEXT NOT NULL,      -- HMAC-SHA256 of row with tenant TMK
                                          -- Recomputed and verified before every read
                                          -- Failed HMAC = treat as RED regardless
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL,
  FOREIGN KEY (tenant_id) REFERENCES tenants(id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_action_prefs_unique
  ON tenant_action_preferences(tenant_id, capability_class, COALESCE(integration, ''));

CREATE INDEX IF NOT EXISTS idx_action_prefs_tenant
  ON tenant_action_preferences(tenant_id);

CREATE TABLE IF NOT EXISTS pending_actions (
  id                  TEXT PRIMARY KEY,   -- ulid = action_id
  tenant_id           TEXT NOT NULL,
  proposed_at         INTEGER NOT NULL,
  proposed_by         TEXT NOT NULL,      -- agent_identity string
  capability_class    TEXT NOT NULL,
  integration         TEXT NOT NULL,
  action_type         TEXT NOT NULL,      -- 'send_email' | 'create_event' | etc.
  state               TEXT NOT NULL,
  -- 'pending' | 'awaiting_approval' | 'queued' | 'executing' |
  -- 'completed' | 'rejected' | 'cancelled' | 'expired' | 'failed'
  authorization_level TEXT NOT NULL,      -- level at proposal time (snapshot)
  send_delay_seconds  INTEGER NOT NULL DEFAULT 0,
  execute_after       INTEGER,            -- unix ms — NULL until queued
  payload_r2_key      TEXT NOT NULL,      -- encrypted payload in R2_ARTIFACTS
  payload_hash        TEXT NOT NULL,      -- SHA-256 of plaintext payload (TOCTOU)
  approved_by         TEXT,               -- tenant member ID or 'auto_green'
  approved_at         INTEGER,
  executed_at         INTEGER,
  cancelled_at        INTEGER,
  cancel_reason       TEXT,
  retry_count         INTEGER NOT NULL DEFAULT 0,
  max_retries         INTEGER NOT NULL DEFAULT 3,
  result_summary      TEXT,               -- brief outcome metadata (not content)
  episodic_memory_id  TEXT,               -- Hindsight UUID for post-execution memory
  FOREIGN KEY (tenant_id) REFERENCES tenants(id)
);

CREATE INDEX IF NOT EXISTS idx_pending_actions_tenant_state
  ON pending_actions(tenant_id, state, proposed_at DESC);

CREATE INDEX IF NOT EXISTS idx_pending_actions_execute_after
  ON pending_actions(execute_after)
  WHERE state = 'queued';

CREATE TABLE IF NOT EXISTS action_audit (
  id                  TEXT PRIMARY KEY,   -- ulid
  tenant_id           TEXT NOT NULL,
  action_id           TEXT NOT NULL,      -- FK to pending_actions
  created_at          INTEGER NOT NULL,
  event               TEXT NOT NULL,      -- audit vocabulary: action.*
  agent_identity      TEXT,
  payload_hash        TEXT,               -- snapshot of hash at this event
  detail_json         TEXT,               -- metadata only — never content
  FOREIGN KEY (tenant_id) REFERENCES tenants(id),
  FOREIGN KEY (action_id) REFERENCES pending_actions(id)
);

CREATE INDEX IF NOT EXISTS idx_action_audit_action_id
  ON action_audit(action_id, created_at);

CREATE INDEX IF NOT EXISTS idx_action_audit_tenant_created
  ON action_audit(tenant_id, created_at DESC);

CREATE TABLE IF NOT EXISTS scheduled_tasks (
  id                  TEXT PRIMARY KEY,   -- ulid
  tenant_id           TEXT NOT NULL,
  task_name           TEXT NOT NULL,
  cron_expression     TEXT NOT NULL,      -- standard cron: '0 7 * * *'
  enabled             INTEGER NOT NULL DEFAULT 1,
  is_platform_default INTEGER NOT NULL DEFAULT 0, -- 1 = shipped by platform
  description         TEXT,
  scope_json          TEXT,               -- JSON config for task (no content)
  last_run_at         INTEGER,
  next_run_at         INTEGER,
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL,
  FOREIGN KEY (tenant_id) REFERENCES tenants(id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_scheduled_tasks_unique
  ON scheduled_tasks(tenant_id, task_name);

-- Platform default tasks seeded in 1.2 when tenant is created
-- (seeding requires tenant_id which doesn't exist until auth)

CREATE TABLE IF NOT EXISTS action_templates (
  id                  TEXT PRIMARY KEY,   -- ulid
  tenant_id           TEXT NOT NULL,
  template_name       TEXT NOT NULL,
  description         TEXT,
  steps_json          TEXT NOT NULL,      -- ordered array of action steps (metadata)
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL,
  FOREIGN KEY (tenant_id) REFERENCES tenants(id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_action_templates_unique
  ON action_templates(tenant_id, template_name);
