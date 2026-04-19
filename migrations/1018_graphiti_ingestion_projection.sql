CREATE TABLE IF NOT EXISTS canonical_graph_identity_mappings (
  id                TEXT PRIMARY KEY,
  tenant_id         TEXT NOT NULL,
  projection_job_id TEXT NOT NULL,
  canonical_key     TEXT NOT NULL,
  graph_ref         TEXT NOT NULL,
  graph_kind        TEXT NOT NULL,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  FOREIGN KEY (tenant_id) REFERENCES tenants(id),
  FOREIGN KEY (projection_job_id) REFERENCES canonical_projection_jobs(id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_canonical_graph_identity_unique
  ON canonical_graph_identity_mappings(projection_job_id, canonical_key, graph_kind);

CREATE INDEX IF NOT EXISTS idx_canonical_graph_identity_lookup
  ON canonical_graph_identity_mappings(tenant_id, canonical_key, graph_kind, updated_at DESC);
