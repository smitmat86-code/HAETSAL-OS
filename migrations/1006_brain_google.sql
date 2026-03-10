-- THE Brain: Google integration (Phase 2.2)
-- Webhook channels + OAuth metadata (actual tokens in KV encrypted)

CREATE TABLE IF NOT EXISTS google_webhook_channels (
  id              TEXT PRIMARY KEY,    -- ulid
  tenant_id       TEXT NOT NULL,
  channel_id      TEXT NOT NULL,
  channel_token   TEXT NOT NULL,       -- pre-shared secret for webhook verification
  resource_type   TEXT NOT NULL,       -- 'gmail' | 'calendar'
  expires_at      INTEGER NOT NULL,    -- unix ms
  created_at      INTEGER NOT NULL,
  FOREIGN KEY (tenant_id) REFERENCES tenants(id)
);

CREATE INDEX IF NOT EXISTS idx_google_webhook_channel_token
  ON google_webhook_channels(channel_token);

CREATE INDEX IF NOT EXISTS idx_google_webhook_tenant_resource
  ON google_webhook_channels(tenant_id, resource_type);

CREATE TABLE IF NOT EXISTS google_oauth_tokens (
  id              TEXT PRIMARY KEY,    -- ulid
  tenant_id       TEXT NOT NULL,
  scope           TEXT NOT NULL,       -- 'gmail.readonly' | 'calendar.readonly' | 'drive.readonly'
  kv_key          TEXT NOT NULL,       -- KV key where encrypted tokens are stored
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  FOREIGN KEY (tenant_id) REFERENCES tenants(id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_google_oauth_tenant_scope
  ON google_oauth_tokens(tenant_id, scope);
