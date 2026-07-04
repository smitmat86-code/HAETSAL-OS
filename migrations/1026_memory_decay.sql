-- 1026: Phase 12 memory decay states (metadata + encrypted refs only: ids,
-- scores, counts, soft states — never content, never keys).
CREATE TABLE IF NOT EXISTS memory_decay (
  tenant_id TEXT NOT NULL,
  capture_id TEXT NOT NULL,
  score REAL NOT NULL,
  access_count INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL DEFAULT 'active',
  last_scored_at INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, capture_id)
);
