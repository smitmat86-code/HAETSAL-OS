// Mission Phase 14: system panel contracts — sealed, versioned prompt
// overrides (resolve/save/history/rollback/reset), fail-open resolution when
// the KEK is gone (a chat surface must never die on config), Law 2 (rows are
// KEK1 ciphertext; audit rows content-free), Law 3 (no agent-facing tool
// reaches the prompt surface), and real scheduled-task toggles.

import { beforeAll, describe, expect, it } from 'vitest'
import { env } from 'cloudflare:test'
import {
  resolveSystemPrompt, savePromptOverride, resetPromptOverride, rollbackPromptOverride,
} from '../src/services/prompts/overrides'
import { listPromptVersions } from '../src/services/prompts/override-history'
import { PERSONA_CHAT_DEFAULT } from '../src/services/prompts/registry'
import { isTaskEnabled, setTaskEnabled } from '../src/services/system/tasks'
import { BRAIN_MEMORY_TOOL_NAMES } from '../src/tools/brain-memory-surface'
import type { Env } from '../src/types/env'

const SUITE = crypto.randomUUID()
const TENANT = `test-tenant-mission-140-${SUITE}`
const KEY = 'persona.chat'
const KEK_RAW = crypto.getRandomValues(new Uint8Array(32))

beforeAll(async () => {
  const now = Date.now()
  await env.D1_US.prepare(
    `INSERT INTO tenants
     (id, created_at, updated_at, data_region, primary_channel, hindsight_tenant_id, ai_cost_reset_at, cron_kek_expires_at)
     VALUES (?, ?, ?, 'us', 'sms', ?, ?, ?)`,
  ).bind(TENANT, now, now, `legacy-${TENANT}`, now, now + 3600_000).run()
  await env.KV_SESSION.put(`cron_kek:${TENANT}`, btoa(String.fromCharCode(...KEK_RAW)))
})

describe('mission 14.0 — prompt overrides', () => {
  it('resolves the code default (with var substitution) when no override exists', async () => {
    const r = await resolveSystemPrompt(env as unknown as Env, TENANT, KEY, { channel: 'Telegram' })
    expect(r.source).toBe('default')
    expect(r.text).toBe(PERSONA_CHAT_DEFAULT.replaceAll('{channel}', 'Telegram'))
  })

  it('save → resolve returns the override; row is KEK1-sealed; audit is content-free', async () => {
    const body = `You are Custom Haetsal v1 over {channel}. Marker ${SUITE}.`
    const saved = await savePromptOverride(env as unknown as Env, TENANT, KEY, body)
    expect(saved.version).toBe(1)
    const r = await resolveSystemPrompt(env as unknown as Env, TENANT, KEY, { channel: 'SMS' })
    expect(r.source).toBe('override')
    expect(r.text).toContain('Custom Haetsal v1 over SMS')
    const row = await env.D1_US.prepare(
      `SELECT body_ciphertext FROM system_prompt_overrides WHERE tenant_id = ? AND prompt_key = ? AND status = 'active'`,
    ).bind(TENANT, KEY).first<{ body_ciphertext: string }>()
    expect(row?.body_ciphertext.startsWith('KEK1:')).toBe(true)
    expect(row?.body_ciphertext).not.toContain('Custom Haetsal')
    const audit = await env.D1_US.prepare(
      `SELECT operation, domain FROM memory_audit WHERE tenant_id = ? AND operation = 'system.prompt_updated'`,
    ).bind(TENANT).all<{ operation: string; domain: string }>()
    expect(audit.results?.length).toBeGreaterThanOrEqual(1)
    expect(JSON.stringify(audit.results)).not.toContain('Custom Haetsal')
  })

  it('history + rollback + reset keep every version', async () => {
    await savePromptOverride(env as unknown as Env, TENANT, KEY, `Version two. Marker ${SUITE}.`)
    const versions = await listPromptVersions(env as unknown as Env, TENANT, KEY)
    expect(versions.map(v => v.version_no)).toEqual([2, 1])
    expect(versions[0].status).toBe('active')
    await rollbackPromptOverride(env as unknown as Env, TENANT, KEY, 1)
    const afterRollback = await resolveSystemPrompt(env as unknown as Env, TENANT, KEY)
    expect(afterRollback.text).toContain('Custom Haetsal v1')
    await resetPromptOverride(env as unknown as Env, TENANT, KEY)
    const afterReset = await resolveSystemPrompt(env as unknown as Env, TENANT, KEY, { channel: 'x' })
    expect(afterReset.source).toBe('default')
    expect((await listPromptVersions(env as unknown as Env, TENANT, KEY)).length).toBe(2)
  })

  it('fails OPEN to the default when the KEK disappears (chat must not die)', async () => {
    await savePromptOverride(env as unknown as Env, TENANT, KEY, 'Sealed but soon unreadable.')
    await env.KV_SESSION.delete(`cron_kek:${TENANT}`)
    const r = await resolveSystemPrompt(env as unknown as Env, TENANT, KEY, { channel: 'Telegram' })
    expect(r.source).toBe('default')
    expect(r.text).toContain('warm and capable')
    await env.KV_SESSION.put(`cron_kek:${TENANT}`, btoa(String.fromCharCode(...KEK_RAW)))
  })

  it('rejects non-editable keys and oversized bodies', async () => {
    await expect(savePromptOverride(env as unknown as Env, TENANT, 'dream.extract', 'x'))
      .rejects.toThrow('PromptNotEditable')
    await expect(savePromptOverride(env as unknown as Env, TENANT, KEY, 'y'.repeat(5000)))
      .rejects.toThrow('PromptBodyInvalid')
  })

  it('Law 3: no agent-facing memory tool touches prompts', () => {
    expect(BRAIN_MEMORY_TOOL_NAMES.some(n => /prompt|system/i.test(n))).toBe(false)
  })
})

describe('mission 14.0 — scheduled task toggles', () => {
  it('defaults enabled, flips off and back on, and audits the change', async () => {
    expect(await isTaskEnabled(env as unknown as Env, TENANT, 'morning_brief')).toBe(true)
    await setTaskEnabled(env as unknown as Env, TENANT, 'morning_brief', false)
    expect(await isTaskEnabled(env as unknown as Env, TENANT, 'morning_brief')).toBe(false)
    await setTaskEnabled(env as unknown as Env, TENANT, 'morning_brief', true)
    expect(await isTaskEnabled(env as unknown as Env, TENANT, 'morning_brief')).toBe(true)
    const audit = await env.D1_US.prepare(
      `SELECT COUNT(*) AS n FROM memory_audit WHERE tenant_id = ? AND operation LIKE 'system.task_%'`,
    ).bind(TENANT).first<{ n: number }>()
    expect(audit?.n).toBe(2)
    await expect(setTaskEnabled(env as unknown as Env, TENANT, 'nonsense', true)).rejects.toThrow('UnknownTask')
  })
})
