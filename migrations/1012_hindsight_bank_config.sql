-- 1012_hindsight_bank_config.sql
-- Drift-aware Hindsight bank provisioning ledger.
-- Tracks the last applied config hash so bootstrap can safely no-op or re-apply.

CREATE TABLE IF NOT EXISTS hindsight_bank_config (
  bank_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  config_version TEXT NOT NULL,
  config_json TEXT NOT NULL,
  mental_model_count INTEGER NOT NULL DEFAULT 0,
  webhook_url TEXT,
  applied_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_hindsight_bank_config_tenant
  ON hindsight_bank_config(tenant_id);
