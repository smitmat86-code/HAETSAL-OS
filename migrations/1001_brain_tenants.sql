-- THE Brain: Tenant schema
-- Every tenant-scoped table MUST include tenant_id TEXT NOT NULL

CREATE TABLE IF NOT EXISTS tenants (
  id                    TEXT PRIMARY KEY,          -- ulid
  created_at            INTEGER NOT NULL,          -- unix ms
  updated_at            INTEGER NOT NULL,
  data_region           TEXT NOT NULL DEFAULT 'us',-- 'us' | 'eu' — DLS routing
  primary_channel       TEXT NOT NULL DEFAULT 'sms',-- 'sms' | 'email'
  primary_phone         TEXT,                      -- E.164 format
  primary_email         TEXT,
  hindsight_tenant_id   TEXT NOT NULL UNIQUE,      -- Hindsight's internal tenant UUID
  cron_kek_encrypted    TEXT,                      -- Cron KEK encrypted at rest
                                                   -- NULL until first auth session
                                                   -- Provisioned by auth middleware (1.2)
  cron_kek_expires_at   INTEGER,                   -- unix ms — 24h rolling expiry
  ai_cost_daily_usd     REAL NOT NULL DEFAULT 0,   -- rolling daily spend
  ai_cost_monthly_usd   REAL NOT NULL DEFAULT 0,   -- rolling monthly spend
  ai_cost_reset_at      INTEGER NOT NULL,          -- unix ms — midnight UTC
  ai_ceiling_daily_usd  REAL NOT NULL DEFAULT 5.0,
  ai_ceiling_monthly_usd REAL NOT NULL DEFAULT 50.0,
  obsidian_sync_enabled INTEGER NOT NULL DEFAULT 0,-- 0|1 boolean
  obsidian_drive_folder TEXT                       -- Google Drive folder ID for sync
);

CREATE TABLE IF NOT EXISTS tenant_members (
  id          TEXT PRIMARY KEY,          -- ulid
  tenant_id   TEXT NOT NULL,
  role        TEXT NOT NULL DEFAULT 'owner', -- 'owner' | 'member' (future)
  display_name TEXT,
  passkey_id  TEXT,                      -- WebAuthn credential ID
  created_at  INTEGER NOT NULL,
  last_seen_at INTEGER,
  FOREIGN KEY (tenant_id) REFERENCES tenants(id)
);

CREATE INDEX IF NOT EXISTS idx_tenant_members_tenant
  ON tenant_members(tenant_id);
