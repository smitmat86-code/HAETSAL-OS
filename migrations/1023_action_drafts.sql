-- Mission Phase 5: operational pointer table for act_draft (note/plan drafts).
-- Law 2: NO draft content here. The draft body is retained as a canonical
-- capture (encrypted, Neon via Hyperdrive); this table only tracks the
-- operational state and points at the canonical capture id.

CREATE TABLE IF NOT EXISTS action_drafts (
  id           TEXT PRIMARY KEY,        -- uuid
  tenant_id    TEXT NOT NULL,
  action_id    TEXT,                    -- originating pending_actions.id
  capture_id   TEXT,                    -- canonical capture holding the body
  draft_type   TEXT NOT NULL,           -- 'note' | 'plan' (email -> Gmail, S5)
  status       TEXT NOT NULL DEFAULT 'draft',  -- draft | sent | discarded
  created_at   INTEGER NOT NULL,        -- unix ms
  updated_at   INTEGER NOT NULL,
  FOREIGN KEY (tenant_id) REFERENCES tenants(id)
);

CREATE INDEX IF NOT EXISTS idx_action_drafts_tenant
  ON action_drafts(tenant_id, created_at DESC);
