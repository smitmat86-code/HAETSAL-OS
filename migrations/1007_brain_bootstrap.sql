-- THE Brain: Bootstrap import schema additions
-- Phase 2.4 — adds bootstrap status tracking to tenants table

ALTER TABLE tenants ADD COLUMN bootstrap_status TEXT NOT NULL DEFAULT 'not_started';
-- 'not_started' | 'interview_in_progress' | 'interview_complete' | 'import_in_progress' | 'completed'
ALTER TABLE tenants ADD COLUMN bootstrap_workflow_id TEXT;
ALTER TABLE tenants ADD COLUMN bootstrap_completed_at INTEGER;
ALTER TABLE tenants ADD COLUMN interview_completed_at INTEGER;
ALTER TABLE tenants ADD COLUMN bootstrap_items_imported INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_tenants_bootstrap_status
  ON tenants(bootstrap_status);
