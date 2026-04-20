CREATE TABLE IF NOT EXISTS canonical_broker_traces (
  id                      TEXT PRIMARY KEY,
  tenant_id               TEXT NOT NULL,
  query_text_sha256       TEXT NOT NULL,
  requested_mode          TEXT,
  primary_mode            TEXT NOT NULL,
  primary_reason          TEXT NOT NULL,
  primary_explicit        INTEGER NOT NULL,
  primary_status          TEXT NOT NULL,
  primary_latency_ms      INTEGER,
  primary_projection_kind TEXT,
  primary_projection_ref  TEXT,
  primary_capture_id      TEXT,
  shadow_mode             TEXT,
  shadow_status           TEXT NOT NULL,
  shadow_latency_ms       INTEGER,
  shadow_projection_kind  TEXT,
  shadow_projection_ref   TEXT,
  shadow_capture_id       TEXT,
  overlap                 TEXT NOT NULL,
  detail_r2_key           TEXT,
  detail_sha256           TEXT,
  created_at              INTEGER NOT NULL,
  updated_at              INTEGER NOT NULL,
  FOREIGN KEY (tenant_id) REFERENCES tenants(id)
);

CREATE INDEX IF NOT EXISTS idx_canonical_broker_traces_tenant_created
  ON canonical_broker_traces(tenant_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_canonical_broker_traces_tenant_query
  ON canonical_broker_traces(tenant_id, query_text_sha256, created_at DESC);
