// src/services/google/webhook.ts
// Google Push Notification channel management
// Channel token is a pre-shared secret stored in D1 — verified on each webhook

import type { Env } from '../../types/env'

/**
 * Verify a Google webhook channel token against D1 records
 * Returns tenant_id if valid, null if invalid
 */
export async function verifyGoogleChannelToken(
  channelToken: string, env: Env,
): Promise<{ tenantId: string; resourceType: string } | null> {
  const row = await env.D1_US.prepare(
    `SELECT tenant_id, resource_type FROM google_webhook_channels
     WHERE channel_token = ? AND expires_at > ?`,
  ).bind(channelToken, Date.now()).first<{ tenant_id: string; resource_type: string }>()

  if (!row) return null
  return { tenantId: row.tenant_id, resourceType: row.resource_type }
}

/**
 * Register a new webhook channel for Google Push Notifications
 */
export async function registerWebhookChannel(
  tenantId: string,
  resourceType: 'gmail' | 'calendar',
  channelId: string,
  channelToken: string,
  expiresAt: number,
  env: Env,
): Promise<void> {
  await env.D1_US.prepare(
    `INSERT OR IGNORE INTO google_webhook_channels
     (id, tenant_id, channel_id, channel_token, resource_type, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    crypto.randomUUID(), tenantId, channelId, channelToken,
    resourceType, expiresAt, Date.now(),
  ).run()
}
