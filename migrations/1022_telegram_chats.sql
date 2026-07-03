-- Mission Phase 4.1: Telegram inbound tenant routing.
-- Mirrors tenant_phone_numbers: chat.id (Telegram integer) -> tenant_id.
-- Self-registration is via GET /?telegram_chat_id=<N> after CF Access login.

CREATE TABLE IF NOT EXISTS telegram_chats (
  id          TEXT PRIMARY KEY,
  tenant_id   TEXT NOT NULL,
  chat_id     INTEGER NOT NULL,
  label       TEXT,
  created_at  INTEGER NOT NULL,
  FOREIGN KEY (tenant_id) REFERENCES tenants(id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_telegram_chat_id
  ON telegram_chats(chat_id);

CREATE INDEX IF NOT EXISTS idx_telegram_chat_tenant
  ON telegram_chats(tenant_id);
