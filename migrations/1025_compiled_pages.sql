-- 1025: Phase 10 compiled-page registry (content-free: kind + caller slug +
-- stable key + counts). Page bodies live in canonical compiled_* tables.
CREATE TABLE IF NOT EXISTS compiled_pages (
  tenant_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  page_key TEXT NOT NULL,
  stable_key TEXT NOT NULL,
  segment TEXT NOT NULL DEFAULT '',
  source_count INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, kind, page_key)
);
