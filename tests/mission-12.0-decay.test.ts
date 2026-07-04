// Mission Phase 12: adaptive decay — metadata-only scoring (the pass takes no
// key material at all), archive/reinforce thresholds on a fixture, trace-hit
// reinforcement, idempotent re-runs, and soft states only.

import { beforeAll, describe, expect, it } from 'vitest'
import { env } from 'cloudflare:test'
import { decaySummary, runDecayPass, scoreCapture } from '../src/services/decay/pass'
import { installCanonicalMemoryTestStore } from '../src/services/canonical-postgres'
import { retainContent } from '../src/services/ingestion/retain'
import type { Env } from '../src/types/env'

const SUITE = crypto.randomUUID()
const TENANT = `test-tenant-mission-120-${SUITE}`
installCanonicalMemoryTestStore(env as unknown as Env)

const DAY = 86_400_000
let oldCaptureId: string
let freshCaptureId: string
let accessedCaptureId: string

async function testTmk(): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(`m120-${SUITE}`), { name: 'HKDF' }, false, ['deriveKey'])
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: new TextEncoder().encode('m120'), info: new TextEncoder().encode('m120') },
    material, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
}

async function seed(content: string, occurredAt: number, source: 'telegram' | 'cron:consolidation' = 'telegram'): Promise<string> {
  const result = await retainContent({
    tenantId: TENANT, content, source, memoryType: 'episodic',
    domain: 'general', occurredAt,
  }, await testTmk(), env as unknown as Env)
  return result!.canonicalCaptureId!
}

beforeAll(async () => {
  const now = Date.now()
  await env.D1_US.prepare(
    `INSERT OR IGNORE INTO tenants
     (id, created_at, updated_at, data_region, primary_channel, hindsight_tenant_id, ai_cost_reset_at)
     VALUES (?, ?, ?, 'us', 'sms', ?, ?)`,
  ).bind(TENANT, now, now, `hindsight-${TENANT}`, now).run()
  // Genuinely low value: old AND system-written (user sources decay slower).
  oldCaptureId = await seed(`stale system digest ${SUITE}`, now - 90 * DAY, 'cron:consolidation')
  freshCaptureId = await seed(`fresh roadmap decision ${SUITE}`, now - 1 * DAY)
  accessedCaptureId = await seed(`often-recalled fact ${SUITE}`, now - 45 * DAY)
  // Three broker-trace hits for the accessed capture (reinforcement signal).
  for (let i = 0; i < 3; i++) {
    await env.D1_US.prepare(
      `INSERT INTO canonical_broker_traces
       (id, tenant_id, query_text_sha256, primary_mode, primary_reason, primary_explicit,
        primary_status, primary_capture_id, shadow_status, overlap, created_at, updated_at)
       VALUES (?, ?, ?, 'lexical', 'test', 0, 'ok', ?, 'skipped', 'none', ?, ?)`,
    ).bind(crypto.randomUUID(), TENANT, `sha-${i}-${SUITE}`, accessedCaptureId, now - i * 1000, now).run()
  }
})

describe('mission 12.0 — scoring model', () => {
  it('recency decays on the half-life; access and user-source boost', () => {
    expect(scoreCapture({ ageDays: 0, accessCount: 0, sourceSystem: 'telegram' })).toBeCloseTo(1.2, 1)
    expect(scoreCapture({ ageDays: 30, accessCount: 0, sourceSystem: 'telegram' })).toBeCloseTo(0.7, 1)
    const cold = scoreCapture({ ageDays: 90, accessCount: 0, sourceSystem: 'cron:dream' })
    expect(cold).toBeLessThan(0.15)
    const reinforced = scoreCapture({ ageDays: 90, accessCount: 3, sourceSystem: 'cron:dream' })
    expect(reinforced).toBeGreaterThan(cold + 0.5)
  })
})

describe('mission 12.0 — fixture pass', () => {
  it('archives low-value, reinforces accessed, keeps fresh active+', async () => {
    const summary = await runDecayPass(env as unknown as Env, TENANT)
    expect(summary.scored).toBeGreaterThanOrEqual(3)
    const states = new Map<string, { state: string; access_count: number }>()
    const rows = await env.D1_US.prepare(
      'SELECT capture_id, state, access_count FROM memory_decay WHERE tenant_id = ?',
    ).bind(TENANT).all<{ capture_id: string; state: string; access_count: number }>()
    for (const row of rows.results ?? []) states.set(row.capture_id, row)

    expect(states.get(oldCaptureId)?.state).toBe('archived')          // old + system-written + unaccessed
    expect(states.get(accessedCaptureId)?.state).toBe('reinforced')   // 3 trace hits
    expect(states.get(accessedCaptureId)?.access_count).toBe(3)
    expect(['active', 'reinforced']).toContain(states.get(freshCaptureId)?.state) // fresh survives
  })

  it('re-running is idempotent (upserts, no row growth)', async () => {
    const before = await decaySummary(env as unknown as Env, TENANT)
    await runDecayPass(env as unknown as Env, TENANT)
    const after = await decaySummary(env as unknown as Env, TENANT)
    expect(after.scored).toBe(before.scored)
    expect(after.archived).toBe(before.archived)
  })

  it('summary reports counts and freshness', async () => {
    const summary = await decaySummary(env as unknown as Env, TENANT)
    expect(summary.scored).toBeGreaterThanOrEqual(3)
    expect(summary.lastScoredAt).not.toBeNull()
  })
})
