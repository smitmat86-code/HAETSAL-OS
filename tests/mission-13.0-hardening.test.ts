// Mission Phase 13: hardening contracts — key-family-tagged approved-action
// payloads (TMK1/KEK1/legacy; families are NOT interchangeable), the canary
// sweep's six probes with content-free run rows, and the gateway empty-reply
// log carrying shape metadata only.

import { beforeAll, describe, expect, it, vi } from 'vitest'
import { env } from 'cloudflare:test'
import { executeApprovedAction } from '../src/services/action/approved-execution'
import { runCanarySweep, latestCanary } from '../src/services/canary/sweep'
import { encryptWithKek } from '../src/cron/kek'
import { installCanonicalMemoryTestStore } from '../src/services/canonical-postgres'
import { installCanonicalGovernanceTestStore } from '../src/services/canonical-governance-memory'
import type { Env } from '../src/types/env'

const SUITE = crypto.randomUUID()
const TENANT = `test-tenant-mission-130-${SUITE}`
installCanonicalMemoryTestStore(env as unknown as Env)
installCanonicalGovernanceTestStore(env as unknown as Env)

async function keyFrom(seed: string): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(seed), { name: 'HKDF' }, false, ['deriveKey'])
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: new TextEncoder().encode('m130'), info: new TextEncoder().encode('m130') },
    material, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
}

const KEK_RAW = crypto.getRandomValues(new Uint8Array(32))
async function kekKey(): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', KEK_RAW, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt'])
}

beforeAll(async () => {
  const now = Date.now()
  await env.D1_US.prepare(
    `INSERT OR IGNORE INTO tenants
     (id, created_at, updated_at, data_region, primary_channel, hindsight_tenant_id, ai_cost_reset_at)
     VALUES (?, ?, ?, 'us', 'sms', ?, ?)`,
  ).bind(TENANT, now, now, `hindsight-${TENANT}`, now).run()
  await env.D1_US.prepare('UPDATE tenants SET cron_kek_expires_at = ? WHERE id = ?')
    .bind(now + 3600_000, TENANT).run()
  await env.KV_SESSION.put(`cron_kek:${TENANT}`, btoa(String.fromCharCode(...KEK_RAW)))
})

async function seedAction(id: string, blob: string): Promise<void> {
  const key = `actions/${TENANT}/${id}`
  await env.R2_ARTIFACTS.put(key, blob)
  await env.D1_US.prepare(
    `INSERT INTO pending_actions
     (id, tenant_id, proposed_at, proposed_by, capability_class, integration, action_type,
      state, authorization_level, payload_r2_key, payload_hash)
     VALUES (?, ?, ?, 'test', 'READ', 'web', 'brain_v1_act_search', 'queued', 'YELLOW', ?, 'h')`,
  ).bind(id, TENANT, Date.now(), key).run()
}

describe('mission 13.0 — key-family-tagged approved payloads', () => {
  const payload = JSON.stringify({ query: `family test ${SUITE}` })
  const noopCtx = { waitUntil: () => {} } as unknown as ExecutionContext

  it('KEK1 blobs decrypt with the Cron KEK even when the session TMK differs', async () => {
    const id = crypto.randomUUID()
    await seedAction(id, 'KEK1:' + await encryptWithKek(payload, await kekKey()))
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ web: { results: [] } }))))
    const wrongTmk = await keyFrom('completely-different-session-key')
    await expect(executeApprovedAction(id, TENANT, wrongTmk, {
      ...env, BRAVE_API_KEY: 'test-key',
    } as unknown as Env, noopCtx)).resolves.toBeUndefined()
  })

  it('TMK1 blobs decrypt with the session key; legacy untagged blobs too', async () => {
    const tmk = await keyFrom('session-key')
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ web: { results: [] } }))))
    const tagged = crypto.randomUUID()
    await seedAction(tagged, 'TMK1:' + await encryptWithKek(payload, tmk))
    await expect(executeApprovedAction(tagged, TENANT, tmk, { ...env, BRAVE_API_KEY: 'k' } as unknown as Env, noopCtx))
      .resolves.toBeUndefined()
    const legacy = crypto.randomUUID()
    await seedAction(legacy, await encryptWithKek(payload, tmk))
    await expect(executeApprovedAction(legacy, TENANT, tmk, { ...env, BRAVE_API_KEY: 'k' } as unknown as Env, noopCtx))
      .resolves.toBeUndefined()
  })

  it('cross-family decrypt fails loudly (KEK-sealed + no KEK available)', async () => {
    const id = crypto.randomUUID()
    const bare = `kekless-${SUITE}`
    const now = Date.now()
    await env.D1_US.prepare(
      `INSERT OR IGNORE INTO tenants (id, created_at, updated_at, data_region, primary_channel, hindsight_tenant_id, ai_cost_reset_at)
       VALUES (?, ?, ?, 'us', 'sms', ?, ?)`,
    ).bind(bare, now, now, `h-${bare}`, now).run()
    const key = `actions/${bare}/${id}`
    await env.R2_ARTIFACTS.put(key, 'KEK1:' + await encryptWithKek(payload, await kekKey()))
    await env.D1_US.prepare(
      `INSERT INTO pending_actions
       (id, tenant_id, proposed_at, proposed_by, capability_class, integration, action_type,
        state, authorization_level, payload_r2_key, payload_hash)
       VALUES (?, ?, ?, 'test', 'READ', 'web', 'brain_v1_act_search', 'queued', 'YELLOW', ?, 'h')`,
    ).bind(id, bare, Date.now(), key).run()
    await expect(executeApprovedAction(id, bare, await keyFrom('x'), env as unknown as Env, {
      waitUntil: () => {},
    } as unknown as ExecutionContext)).rejects.toThrow(/KEK-sealed/)
  })
})

describe('mission 13.0 — canary sweep', () => {
  it('runs seven probes and records content-free canary and artifact lifecycle rows', async () => {
    const results = await runCanarySweep(env as unknown as Env, TENANT)
    expect(results.map(r => r.probe)).toEqual([
      'capture', 'recall', 'graph', 'contradiction-surface', 'compiled-regen', 'session-evidence', 'artifact',
    ])
    expect(results.filter(r => r.ok).length).toBeGreaterThanOrEqual(5) // capture requires the KEK (present here)
    const latest = await latestCanary(env as unknown as Env, TENANT)
    expect(latest?.total).toBe(7)
    expect(JSON.stringify(latest?.detail)).not.toContain('Canary heartbeat') // content-free detail
    const eventTypes = await env.D1_US.prepare(
      `SELECT DISTINCT event_type FROM artifact_intake_events WHERE tenant_id = ? ORDER BY event_type`,
    ).bind(TENANT).all<{ event_type: string }>()
    expect(eventTypes.results.map(row => row.event_type)).toEqual([
      'expired', 'finalized', 'reaped', 'reserved', 'sealed',
    ])
  })
})
