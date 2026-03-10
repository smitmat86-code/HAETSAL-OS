-- THE Brain: Ingestion infrastructure (Phase 2.1)
-- Maps E.164 phone numbers to tenant IDs for SMS routing

CREATE TABLE IF NOT EXISTS tenant_phone_numbers (
  id          TEXT PRIMARY KEY,    -- ulid
  tenant_id   TEXT NOT NULL,
  phone_e164  TEXT NOT NULL,       -- E.164 format: +1234567890
  label       TEXT,                -- 'primary' | 'secondary'
  created_at  INTEGER NOT NULL,    -- unix ms
  FOREIGN KEY (tenant_id) REFERENCES tenants(id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_tenant_phone_e164
  ON tenant_phone_numbers(phone_e164);

CREATE INDEX IF NOT EXISTS idx_tenant_phone_tenant
  ON tenant_phone_numbers(tenant_id);
