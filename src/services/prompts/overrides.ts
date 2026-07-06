// src/services/prompts/overrides.ts
// Phase 14: per-tenant prompt overrides — sealed (KEK1, Law 2), versioned,
// rollback-able, audited. Resolution FAILS OPEN to the code default with a
// content-free warn: a missing KEK or a decrypt error must never take a chat
// surface down. Law 3: only the authenticated user reaches the write paths
// (dashboard routes); no MCP/agent tool is registered for this table.

import type { Env } from '../../types/env'
import { decryptWithKek, encryptWithKek, fetchAndValidateKek } from '../../cron/kek'
import { writeAuditLog } from '../../middleware/audit'
import { promptEntry, substitutePromptVars } from './registry'

const MAX_PROMPT_CHARS = 4000

const DDL = `CREATE TABLE IF NOT EXISTS system_prompt_overrides (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, prompt_key TEXT NOT NULL,
  version_no INTEGER NOT NULL, body_ciphertext TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'inactive', created_at INTEGER NOT NULL,
  created_by TEXT NOT NULL DEFAULT 'user',
  UNIQUE (tenant_id, prompt_key, version_no))`

export async function ensureOverridesTable(env: Env): Promise<void> {
  await env.D1_US.prepare(DDL).run()
}

export interface ResolvedPrompt { text: string; source: 'default' | 'override' }

/** Live resolution used by chat/agent surfaces. Never throws. */
export async function resolveSystemPrompt(
  env: Env, tenantId: string, key: string, vars?: Record<string, string>,
): Promise<ResolvedPrompt> {
  const entry = promptEntry(key)
  const fallback: ResolvedPrompt = {
    text: substitutePromptVars(entry?.defaultText ?? '', vars), source: 'default',
  }
  if (!entry?.editable) return fallback
  try {
    await ensureOverridesTable(env)
    const row = await env.D1_US.prepare(
      `SELECT body_ciphertext FROM system_prompt_overrides
       WHERE tenant_id = ? AND prompt_key = ? AND status = 'active'
       ORDER BY version_no DESC LIMIT 1`,
    ).bind(tenantId, key).first<{ body_ciphertext: string }>()
    if (!row) return fallback
    const kek = await fetchAndValidateKek(tenantId, env)
    if (!kek) {
      console.warn('PROMPT_OVERRIDE_FALLBACK', { key, reason: 'KekUnavailable' })
      return fallback
    }
    const blob = row.body_ciphertext
    const body = await decryptWithKek(blob.startsWith('KEK1:') ? blob.slice(5) : blob, kek)
    return { text: substitutePromptVars(body, vars), source: 'override' }
  } catch (error) {
    console.warn('PROMPT_OVERRIDE_FALLBACK', {
      key, reason: error instanceof Error ? error.constructor.name : 'error',
    })
    return fallback
  }
}

export async function savePromptOverride(
  env: Env, tenantId: string, key: string, body: string,
): Promise<{ version: number }> {
  const entry = promptEntry(key)
  if (!entry?.editable) throw new Error('PromptNotEditable')
  const trimmed = body.trim()
  if (!trimmed || trimmed.length > MAX_PROMPT_CHARS) throw new Error('PromptBodyInvalid')
  await ensureOverridesTable(env)
  const kek = await fetchAndValidateKek(tenantId, env)
  if (!kek) throw new Error('KekUnavailable')
  const max = await env.D1_US.prepare(
    `SELECT MAX(version_no) AS v FROM system_prompt_overrides WHERE tenant_id = ? AND prompt_key = ?`,
  ).bind(tenantId, key).first<{ v: number | null }>()
  const version = (max?.v ?? 0) + 1
  const sealed = 'KEK1:' + await encryptWithKek(trimmed, kek)
  await env.D1_US.batch([
    env.D1_US.prepare(
      `UPDATE system_prompt_overrides SET status = 'inactive' WHERE tenant_id = ? AND prompt_key = ?`,
    ).bind(tenantId, key),
    env.D1_US.prepare(
      `INSERT INTO system_prompt_overrides
       (id, tenant_id, prompt_key, version_no, body_ciphertext, status, created_at, created_by)
       VALUES (?, ?, ?, ?, ?, 'active', ?, 'user')`,
    ).bind(crypto.randomUUID(), tenantId, key, version, sealed, Date.now()),
  ])
  await writeAuditLog(env, 'system.prompt_updated', tenantId, { agentIdentity: 'user', domain: key })
  return { version }
}

export async function rollbackPromptOverride(
  env: Env, tenantId: string, key: string, version: number,
): Promise<void> {
  await ensureOverridesTable(env)
  const target = await env.D1_US.prepare(
    `SELECT id FROM system_prompt_overrides WHERE tenant_id = ? AND prompt_key = ? AND version_no = ?`,
  ).bind(tenantId, key, version).first<{ id: string }>()
  if (!target) throw new Error('PromptVersionNotFound')
  await env.D1_US.batch([
    env.D1_US.prepare(
      `UPDATE system_prompt_overrides SET status = 'inactive' WHERE tenant_id = ? AND prompt_key = ?`,
    ).bind(tenantId, key),
    env.D1_US.prepare(
      `UPDATE system_prompt_overrides SET status = 'active' WHERE id = ?`,
    ).bind(target.id),
  ])
  await writeAuditLog(env, 'system.prompt_rolled_back', tenantId, { agentIdentity: 'user', domain: key })
}

/** Back to the code default; history rows are kept. */
export async function resetPromptOverride(env: Env, tenantId: string, key: string): Promise<void> {
  await ensureOverridesTable(env)
  await env.D1_US.prepare(
    `UPDATE system_prompt_overrides SET status = 'inactive' WHERE tenant_id = ? AND prompt_key = ?`,
  ).bind(tenantId, key).run()
  await writeAuditLog(env, 'system.prompt_reset', tenantId, { agentIdentity: 'user', domain: key })
}

