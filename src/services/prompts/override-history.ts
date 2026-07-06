// src/services/prompts/override-history.ts
// Phase 14: read-side of prompt overrides — decrypted version history for the
// dashboard diff/rollback UI, and content-free active-version metadata for
// the overview. Split from overrides.ts for the file-size limit.

import type { Env } from '../../types/env'
import { decryptWithKek, fetchAndValidateKek } from '../../cron/kek'
import { ensureOverridesTable } from './overrides'

export interface PromptVersionRow {
  version_no: number; status: string; created_at: number; body: string
}

/** Dashboard read: full decrypted history (throws honestly if the KEK is gone). */
export async function listPromptVersions(
  env: Env, tenantId: string, key: string,
): Promise<PromptVersionRow[]> {
  await ensureOverridesTable(env)
  const rows = await env.D1_US.prepare(
    `SELECT version_no, status, created_at, body_ciphertext FROM system_prompt_overrides
     WHERE tenant_id = ? AND prompt_key = ? ORDER BY version_no DESC`,
  ).bind(tenantId, key).all<{ version_no: number; status: string; created_at: number; body_ciphertext: string }>()
  if (!rows.results?.length) return []
  const kek = await fetchAndValidateKek(tenantId, env)
  if (!kek) throw new Error('KekUnavailable: open the dashboard root page to refresh the session key, then retry')
  return Promise.all(rows.results.map(async (r) => ({
    version_no: r.version_no, status: r.status, created_at: r.created_at,
    body: await decryptWithKek(r.body_ciphertext.startsWith('KEK1:') ? r.body_ciphertext.slice(5) : r.body_ciphertext, kek),
  })))
}

/** Content-free status for the overview (no decrypt needed). */
export async function activeOverrideMeta(
  env: Env, tenantId: string, key: string,
): Promise<{ version: number; updatedAt: number } | null> {
  await ensureOverridesTable(env)
  const row = await env.D1_US.prepare(
    `SELECT version_no, created_at FROM system_prompt_overrides
     WHERE tenant_id = ? AND prompt_key = ? AND status = 'active'
     ORDER BY version_no DESC LIMIT 1`,
  ).bind(tenantId, key).first<{ version_no: number; created_at: number }>()
  return row ? { version: row.version_no, updatedAt: row.created_at } : null
}
