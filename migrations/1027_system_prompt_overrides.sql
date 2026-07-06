-- 1027: Phase 14 — user-editable system prompts with version history.
-- Law 2: bodies are KEK1-tagged AES-GCM ciphertext (prompt text is
-- user-authored config and may reference personal context).
-- Law 3: rows are written ONLY by the authenticated user via the dashboard
-- routes — no agent tool can reach this table.
CREATE TABLE IF NOT EXISTS system_prompt_overrides (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  prompt_key TEXT NOT NULL,
  version_no INTEGER NOT NULL,
  body_ciphertext TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'inactive',
  created_at INTEGER NOT NULL,
  created_by TEXT NOT NULL DEFAULT 'user',
  UNIQUE (tenant_id, prompt_key, version_no)
);

CREATE INDEX IF NOT EXISTS idx_prompt_overrides_lookup
  ON system_prompt_overrides (tenant_id, prompt_key, status, version_no);
