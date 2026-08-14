// src/services/ops-alert/registry.ts
// Per-source token verification for the ops-alert ingress (spec M4).
// D1 stores only SHA-256(token); the token itself lives with the source.
// Auth decision = the UNIQUE index lookup on the token hash — hashing the
// presented token first is what blunts timing probes; there is no separate
// constant-time compare because the row is fetched BY the hash.

import type { Env } from '../../types/env'
import type { OpsAlertSource } from '../../types/ops-alert'
import { sha256Hex } from '../canonical-memory-artifacts'

export { sha256Hex }

/** Resolve the source a presented token belongs to, or null. */
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
  // The registry column is unconstrained TEXT filled by hand-written INSERTs
  // (runbook). An out-of-range value must fail TOWARD paging, never silently
  // downgrade to notice — a typo'd row that never pages is invisible.
  if (row.default_severity !== 'page' && row.default_severity !== 'notice') {
    console.warn('OPS_ALERT_SOURCE_BAD_SEVERITY', {
      source: row.id, value: row.default_severity,
    })
    return { ...row, default_severity: 'page' }
  }
  return row
}
