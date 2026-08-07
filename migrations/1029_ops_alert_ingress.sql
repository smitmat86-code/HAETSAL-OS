-- M4: generic ops-alert ingress (ADR-0006, Fitness App repo).
-- Operational metadata only (T2): source registry stores a token HASH, never
-- the token; alert rows carry system-health title/body (truncated), not
-- tenant memory content. The episodic memory write goes to T1 via the queue.

CREATE TABLE IF NOT EXISTS ops_alert_sources (
  id                TEXT PRIMARY KEY,          -- source name, e.g. 'haetsal-health'
  tenant_id         TEXT NOT NULL,             -- who gets paged / briefed
  token_sha256      TEXT NOT NULL UNIQUE,      -- SHA-256 hex of the bearer token
  default_severity  TEXT NOT NULL DEFAULT 'page',
  dedupe_window_s   INTEGER NOT NULL DEFAULT 21600,
  enabled           INTEGER NOT NULL DEFAULT 1,
  created_at        INTEGER NOT NULL,
  FOREIGN KEY (tenant_id) REFERENCES tenants(id)
);

CREATE TABLE IF NOT EXISTS ops_alerts (
  id                 TEXT PRIMARY KEY,
  tenant_id          TEXT NOT NULL,
  source_id          TEXT NOT NULL,
  dedupe_key         TEXT NOT NULL,
  severity           TEXT NOT NULL,            -- 'page' | 'notice'
  title              TEXT NOT NULL,            -- alert bodies stay OUT of D1:
                                               -- full text goes to T1 via the
                                               -- episodic memory write only
  first_seen_at      INTEGER NOT NULL,
  last_seen_at       INTEGER NOT NULL,
  replay_count       INTEGER NOT NULL DEFAULT 0,
  paged_at           INTEGER,                  -- when the page was delivered
  page_channel       TEXT,                     -- 'sendblue' | 'sms'
  brief_surfaced_at  INTEGER,
  FOREIGN KEY (tenant_id) REFERENCES tenants(id),
  UNIQUE (source_id, dedupe_key)
);

CREATE INDEX IF NOT EXISTS idx_ops_alerts_recent
  ON ops_alerts(tenant_id, last_seen_at DESC);
