// src/services/ops-alert/registry.ts
// Per-source token verification for the ops-alert ingress (spec M4).
// D1 stores only SHA-256(token); the token itself lives with the source.

import type { Env } from '../../types/env'
import type { OpsAlertSource } from '../../types/ops-alert'

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

/** Constant-time compare of equal-length hex strings (Sendblue webhook pattern). */
function timingSafeEqualStrings(left: string, right: string): boolean {
  const leftBytes = new TextEncoder().encode(left)
  const rightBytes = new TextEncoder().encode(right)
  if (leftBytes.byteLength !== rightBytes.byteLength) return false
  return (crypto.subtle as unknown as { timingSafeEqual(a: ArrayBuffer, b: ArrayBuffer): boolean })
    .timingSafeEqual(leftBytes.buffer as ArrayBuffer, rightBytes.buffer as ArrayBuffer)
}

/**
 * Resolve the source a presented token belongs to, or null.
 * Hash the token, look up the row by hash, then constant-time re-compare —
 * the UNIQUE index does the heavy lifting; the compare guards hash-shape edge
 * cases and keeps the decision timing-uniform.
 */
export async function resolveOpsAlertSource(
  token: string,
  env: Env,
): Promise<OpsAlertSource | null> {
  const trimmed = token.trim()
  if (!trimmed) return null
  const tokenHash = await sha256Hex(trimmed)
  const row = await env.D1_US.prepare(
    `SELECT id, tenant_id, token_sha256, default_severity, dedupe_window_s, enabled
     FROM ops_alert_sources WHERE token_sha256 = ?`,
  ).bind(tokenHash).first<OpsAlertSource>()
  if (!row || row.enabled !== 1) return null
  if (!timingSafeEqualStrings(tokenHash, row.token_sha256)) return null
  return row
}
