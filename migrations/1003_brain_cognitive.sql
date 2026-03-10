-- THE Brain: Cognitive layer metadata
-- Tracks gaps, predictions, mental model history, anomaly signals

CREATE TABLE IF NOT EXISTS anomaly_signals (
  id              TEXT PRIMARY KEY,   -- ulid
  tenant_id       TEXT NOT NULL,
  created_at      INTEGER NOT NULL,
  signal_type     TEXT NOT NULL,
  -- 'stale_pending_action' | 'repeated_yellow_rejection' | 'action_retry_exhaustion'
  -- 'authz_downgrade_attempt' | 'toctou_violation' | 'cost_ceiling_warning'
  -- 'cost_ceiling_degraded' | 'intention_behavior_drift' | 'confidence_declining'
  -- 'write_policy_violation' | 'doom_loop_detected' | 'cron_kek_expired'
  severity        TEXT NOT NULL,      -- 'low' | 'medium' | 'high' | 'critical'
  surfaced        INTEGER NOT NULL DEFAULT 0, -- 0|1 — has been shown in morning brief
  resolved        INTEGER NOT NULL DEFAULT 0, -- 0|1
  resolved_at     INTEGER,
  related_id      TEXT,               -- action_id, trace_id, etc. (context-dependent)
  detail_json     TEXT,               -- JSON — metadata only, never content
  FOREIGN KEY (tenant_id) REFERENCES tenants(id)
);

CREATE INDEX IF NOT EXISTS idx_anomaly_signals_tenant_unresolved
  ON anomaly_signals(tenant_id, resolved, severity, created_at DESC);

CREATE TABLE IF NOT EXISTS graph_health_snapshots (
  id              TEXT PRIMARY KEY,   -- ulid
  tenant_id       TEXT NOT NULL,
  captured_at     INTEGER NOT NULL,
  node_count      INTEGER NOT NULL,
  edge_count      INTEGER NOT NULL,
  domain_counts   TEXT NOT NULL,      -- JSON: { career: 42, health: 18, ... }
  bridge_edge_count INTEGER NOT NULL,
  isolated_node_count INTEGER NOT NULL,
  avg_confidence  REAL,
  FOREIGN KEY (tenant_id) REFERENCES tenants(id)
);

CREATE INDEX IF NOT EXISTS idx_graph_health_tenant_captured
  ON graph_health_snapshots(tenant_id, captured_at DESC);

CREATE TABLE IF NOT EXISTS mental_model_history (
  id              TEXT PRIMARY KEY,   -- ulid
  tenant_id       TEXT NOT NULL,
  domain          TEXT NOT NULL,
  version         INTEGER NOT NULL,
  created_at      INTEGER NOT NULL,
  hindsight_model_id TEXT NOT NULL,   -- Hindsight's internal ID for this version
  summary_encrypted TEXT,             -- encrypted snapshot for audit/diff
  -- Full content lives in Hindsight — this is version tracking metadata
  FOREIGN KEY (tenant_id) REFERENCES tenants(id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_mental_model_history_version
  ON mental_model_history(tenant_id, domain, version);

CREATE TABLE IF NOT EXISTS predictions (
  id              TEXT PRIMARY KEY,   -- ulid
  tenant_id       TEXT NOT NULL,
  created_at      INTEGER NOT NULL,
  domain          TEXT NOT NULL,
  prediction_type TEXT NOT NULL,      -- 'event' | 'pattern' | 'risk' | 'opportunity'
  confidence      REAL NOT NULL,      -- 0.0–1.0 at time of prediction
  time_horizon_days INTEGER,
  resolved        INTEGER NOT NULL DEFAULT 0,
  resolved_at     INTEGER,
  outcome         TEXT,               -- 'correct' | 'incorrect' | 'partial' | 'expired'
  outcome_confidence REAL,            -- actual confidence at resolution
  -- Prediction text content lives in Hindsight — this tracks accuracy
  hindsight_prediction_id TEXT,
  FOREIGN KEY (tenant_id) REFERENCES tenants(id)
);

CREATE INDEX IF NOT EXISTS idx_predictions_tenant_domain
  ON predictions(tenant_id, domain, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_predictions_tenant_unresolved
  ON predictions(tenant_id, resolved, time_horizon_days);
