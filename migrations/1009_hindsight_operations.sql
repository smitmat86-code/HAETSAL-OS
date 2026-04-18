-- Hindsight async operation lifecycle tracking
-- Keeps HAETSAL's source of truth for queued/completed/failed retain work.

CREATE TABLE IF NOT EXISTS hindsight_operations (
  operation_id       TEXT PRIMARY KEY,
  tenant_id          TEXT NOT NULL,
  bank_id            TEXT NOT NULL,
  source_document_id TEXT,
  source             TEXT NOT NULL,
  provenance         TEXT,
  domain             TEXT,
  memory_type        TEXT,
  salience_tier      INTEGER,
  dedup_hash         TEXT NOT NULL UNIQUE,
  stone_r2_key       TEXT,
  operation_type     TEXT NOT NULL DEFAULT 'retain',
  status             TEXT NOT NULL,     -- 'pending' | 'completed' | 'failed'
  error_message      TEXT,
  requested_at       INTEGER NOT NULL,
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL,
  completed_at       INTEGER,
  last_checked_at    INTEGER,
  FOREIGN KEY (tenant_id) REFERENCES tenants(id)
);

CREATE INDEX IF NOT EXISTS idx_hindsight_operations_tenant_status
  ON hindsight_operations(tenant_id, status, requested_at DESC);

CREATE INDEX IF NOT EXISTS idx_hindsight_operations_status_checked
  ON hindsight_operations(status, last_checked_at, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_hindsight_operations_bank_status
  ON hindsight_operations(bank_id, status, updated_at DESC);
