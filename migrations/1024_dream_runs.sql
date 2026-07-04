-- 1024: Phase 8 dream cycle run ledger (content-free operational metadata).
-- The report body lives in canonical Postgres as an encrypted capture; this
-- table holds only ids, counts, timing, and status for dedup + dashboards.
CREATE TABLE IF NOT EXISTS dream_runs (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  run_date TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  completed_at INTEGER,
  status TEXT NOT NULL DEFAULT 'running',
  trigger TEXT NOT NULL DEFAULT 'cron',
  events_seen INTEGER NOT NULL DEFAULT 0,
  proposals_written INTEGER NOT NULL DEFAULT 0,
  contradictions INTEGER NOT NULL DEFAULT 0,
  supersessions INTEGER NOT NULL DEFAULT 0,
  promotions INTEGER NOT NULL DEFAULT 0,
  gaps INTEGER NOT NULL DEFAULT 0,
  report_capture_id TEXT,
  report_document_id TEXT,
  error_message TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_dream_runs_tenant_date ON dream_runs(tenant_id, run_date);
CREATE INDEX IF NOT EXISTS idx_dream_runs_tenant_started ON dream_runs(tenant_id, started_at DESC);
