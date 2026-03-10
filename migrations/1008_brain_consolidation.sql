-- THE Brain: Consolidation schema (Phase 3.3/3.4)
-- consolidation_runs: audit trail for nightly cron runs
-- consolidation_gaps: open questions for Chief of Staff

CREATE TABLE IF NOT EXISTS consolidation_runs (
  id              TEXT PRIMARY KEY,
  tenant_id       TEXT NOT NULL,
  started_at      INTEGER NOT NULL,
  completed_at    INTEGER,
  status          TEXT NOT NULL DEFAULT 'running',
  pass1_facts     INTEGER NOT NULL DEFAULT 0,
  pass2_contradictions INTEGER NOT NULL DEFAULT 0,
  pass3_bridges   INTEGER NOT NULL DEFAULT 0,
  pass4_patterns  INTEGER NOT NULL DEFAULT 0,
  pass5_domains   INTEGER NOT NULL DEFAULT 0,
  pass6_gaps      INTEGER NOT NULL DEFAULT 0,
  error_message   TEXT,
  FOREIGN KEY (tenant_id) REFERENCES tenants(id)
);

CREATE INDEX IF NOT EXISTS idx_consolidation_runs_tenant
  ON consolidation_runs(tenant_id, started_at DESC);

CREATE TABLE IF NOT EXISTS consolidation_gaps (
  id              TEXT PRIMARY KEY,
  tenant_id       TEXT NOT NULL,
  run_id          TEXT NOT NULL,
  question        TEXT NOT NULL,
  domain          TEXT NOT NULL,
  priority        TEXT NOT NULL,
  surfaced        INTEGER NOT NULL DEFAULT 0,
  created_at      INTEGER NOT NULL,
  FOREIGN KEY (tenant_id) REFERENCES tenants(id),
  FOREIGN KEY (run_id) REFERENCES consolidation_runs(id)
);

CREATE INDEX IF NOT EXISTS idx_consolidation_gaps_tenant
  ON consolidation_gaps(tenant_id, surfaced, priority);
