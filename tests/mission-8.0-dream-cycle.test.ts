// Mission Phase 8: dream cycle — tolerant findings parsing, confidence floor,
// report composition, REPORT-ONLY proposal writes with dedup against the
// review inbox, D1 run ledger (claim/dedup/finish/latest), and the morning
// brief section fallback shapes.

import { beforeAll, describe, expect, it } from 'vitest'
import { env } from 'cloudflare:test'
import { buildWindowBlock, parseFindings } from '../src/services/dream/extract'
import { writeDreamProposals, DREAM_REVIEW_TYPE } from '../src/services/dream/proposals'
import {
  claimDreamRun, composeDreamReport, ensureDreamRunsTable, finishDreamRun, latestDreamRun,
} from '../src/services/dream/report'
import { fetchDreamSection } from '../src/services/dream/brief-section'
import { executeDreamStage } from '../src/services/dream/stage'
import { installCanonicalGovernanceTestStore } from '../src/services/canonical-governance-memory'
import { installCanonicalMemoryTestStore } from '../src/services/canonical-postgres'
import type { DreamCounts, DreamFindings } from '../src/services/dream/types'
import type { Env } from '../src/types/env'

const SUITE = crypto.randomUUID()
const TENANT = `test-tenant-mission-80-${SUITE}`
const store = installCanonicalGovernanceTestStore(env as unknown as Env)
installCanonicalMemoryTestStore(env as unknown as Env)

const FINDING = (statement: string, confidence = 0.8) =>
  ({ kind: 'contradiction' as const, statement, rationale: 'seen in window', confidence, refs: [] })

function findings(partial: Partial<DreamFindings> = {}): DreamFindings {
  return { facts: [], contradictions: [], supersessions: [], promotions: [], entityLinks: [], gaps: [], ...partial }
}

beforeAll(async () => {
  const now = Date.now()
  await env.D1_US.prepare(
    `INSERT OR IGNORE INTO tenants
     (id, created_at, updated_at, data_region, primary_channel, hindsight_tenant_id, ai_cost_reset_at)
     VALUES (?, ?, ?, 'us', 'sms', ?, ?)`,
  ).bind(TENANT, now, now, `hindsight-${TENANT}`, now).run()
})

describe('mission 8.0 — findings parsing', () => {
  it('parses strict JSON and JSON embedded in prose', () => {
    const payload = '{"facts":["Matt prefers Telegram"],"contradictions":[{"statement":"Meeting moved","rationale":"newer","confidence":0.9,"refs":["ab"]}],"supersessions":[],"promotions":[],"entity_links":[],"gaps":[]}'
    expect(parseFindings({ response: payload }).facts).toEqual(['Matt prefers Telegram'])
    expect(parseFindings({ response: `Sure! Here you go:\n${payload}\nHope that helps.` }).contradictions).toHaveLength(1)
  })

  it('drops low-confidence findings and malformed replies degrade to empty', () => {
    const low = '{"facts":[],"contradictions":[{"statement":"weak guess","rationale":"","confidence":0.2}],"supersessions":[],"promotions":[],"entity_links":[],"gaps":[]}'
    expect(parseFindings({ response: low }).contradictions).toHaveLength(0)
    expect(parseFindings({ response: 'not json at all' })).toMatchObject({ facts: [], gaps: [] })
    expect(parseFindings({ response: '{"facts": [broken' })).toMatchObject({ facts: [] })
  })

  it('window block respects the char budget', () => {
    const items = Array.from({ length: 100 }, (_, index) => ({
      ref: `r${index}`, when: Date.now(), text: 'x'.repeat(400),
    }))
    expect(buildWindowBlock(items).length).toBeLessThanOrEqual(9200)
  })
})

describe('mission 8.0 — report composition', () => {
  const counts: DreamCounts = { eventsSeen: 12, proposalsWritten: 3, contradictions: 1, supersessions: 0, promotions: 1, gaps: 1 }

  it('renders sections and the no-auto-promotion line', () => {
    const report = composeDreamReport('2026-07-05', findings({
      facts: ['New fact A'],
      contradictions: [FINDING('X contradicts Y')],
      promotions: [FINDING('Matt always reviews PRs at 9am')],
      gaps: [FINDING('No home address on file')],
    }), counts)
    expect(report).toContain('New facts learned:')
    expect(report).toContain('X contradicts Y')
    expect(report).toContain('Promotion candidates (awaiting review):')
    expect(report).toContain('Nothing was auto-promoted')
  })

  it('quiet night renders honestly', () => {
    const report = composeDreamReport('2026-07-05', findings(), { ...counts, proposalsWritten: 0 })
    expect(report).toContain('Quiet night')
  })
})

describe('mission 8.0 — report-only proposals with dedup', () => {
  it('writes pending reviews once per unique finding', async () => {
    const set = findings({
      contradictions: [FINDING('Calendar says Tue, note says Wed')],
      promotions: [FINDING('Prefers async updates')],
    })
    const first = await writeDreamProposals(env as unknown as Env, TENANT, set)
    expect(first).toBe(2)
    const second = await writeDreamProposals(env as unknown as Env, TENANT, set)
    expect(second).toBe(0) // dedup against pending inbox
    const pending = await store.listReviews(TENANT, 'pending', 50)
    const dreamReviews = pending.filter(r => r.review_type === DREAM_REVIEW_TYPE)
    expect(dreamReviews).toHaveLength(2)
    expect(dreamReviews.every(r => r.status === 'pending')).toBe(true) // report-only: nothing approved
    const proposal = JSON.parse(dreamReviews[0].proposal_json) as { statement: string; confidence: number }
    expect(proposal.statement.length).toBeGreaterThan(4)
  })

  it('decided proposals (approved or rejected) never re-file', async () => {
    const set = findings({ gaps: [FINDING('No emergency contact on file')] })
    expect(await writeDreamProposals(env as unknown as Env, TENANT, set)).toBe(1)
    const review = (await store.listReviews(TENANT, 'pending', 50))
      .find(r => r.review_type === DREAM_REVIEW_TYPE && r.proposal_json.includes('emergency contact'))!
    await store.decideReview(TENANT, review.id, { status: 'rejected', decidedBy: 'matt', decidedAt: Date.now() })
    expect(await writeDreamProposals(env as unknown as Env, TENANT, set)).toBe(0)
  })
})

describe('mission 8.0 — D1 run ledger', () => {
  it('claims once per tenant/date, finishes with counts, reads latest', async () => {
    await ensureDreamRunsTable(env as unknown as Env)
    const runId = await claimDreamRun(env as unknown as Env, TENANT, '2026-07-05', 'cron')
    expect(runId).not.toBeNull()
    expect(await claimDreamRun(env as unknown as Env, TENANT, '2026-07-05', 'cron')).toBeNull() // dedup
    await finishDreamRun(env as unknown as Env, runId!, {
      status: 'completed',
      counts: { eventsSeen: 10, proposalsWritten: 2, contradictions: 1, supersessions: 0, promotions: 1, gaps: 0 },
      captureId: 'cap-1', documentId: 'doc-1',
    })
    const latest = await latestDreamRun(env as unknown as Env, TENANT)
    expect(latest).toMatchObject({ status: 'completed', proposals_written: 2, report_document_id: 'doc-1' })
  })
})

describe('mission 8.0 — stage KEK discipline (Law 2 corollary)', () => {
  it('defers when the Cron KEK is unavailable — never bypasses', async () => {
    const bare = `kekless-${SUITE}`
    const now = Date.now()
    await env.D1_US.prepare(
      `INSERT OR IGNORE INTO tenants (id, created_at, updated_at, data_region, primary_channel, hindsight_tenant_id, ai_cost_reset_at)
       VALUES (?, ?, ?, 'us', 'sms', ?, ?)`,
    ).bind(bare, now, now, `h-${bare}`, now).run()
    const result = await executeDreamStage(env as unknown as Env, bare, '2026-07-05')
    expect(result).toEqual({ deferred: true })
  })

  it('runs end-to-end with a valid KEK: proposals + encrypted report persisted', async () => {
    const now = Date.now()
    await env.D1_US.prepare(
      'UPDATE tenants SET cron_kek_expires_at = ? WHERE id = ?',
    ).bind(now + 3600_000, TENANT).run()
    const raw = crypto.getRandomValues(new Uint8Array(32))
    await env.KV_SESSION.put(`cron_kek:${TENANT}`, btoa(String.fromCharCode(...raw)))

    const findingsPayload = '{"facts":["Fact from window"],"contradictions":[],"supersessions":[],"promotions":[{"statement":"Reads news each morning","rationale":"repeated","confidence":0.7,"refs":[]}],"entity_links":[],"gaps":[]}'
    const fakeEnv = {
      ...env,
      AI_GATEWAY_ID: 'g',
      AI: { run: async () => ({ response: findingsPayload }) },
    } as unknown as Env

    // Seed one window memory so extraction runs.
    const { retainContent } = await import('../src/services/ingestion/retain')
    const kek = await crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt'])
    await retainContent({
      tenantId: TENANT, content: 'Matt read the morning news digest today.',
      source: 'telegram', memoryType: 'episodic', occurredAt: now,
    }, kek, fakeEnv)

    const result = await executeDreamStage(fakeEnv, TENANT, '2026-07-06')
    expect(result.deferred).toBe(false)
    if (!result.deferred) {
      expect(result.counts.eventsSeen).toBeGreaterThanOrEqual(1)
      expect(result.counts.proposalsWritten).toBeGreaterThanOrEqual(1)
      expect(result.captureId).not.toBeNull()
    }
  })
})

describe('mission 8.0 — morning brief section', () => {
  it('falls back to a count line when the report body is unreadable', async () => {
    const tmk = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']) as CryptoKey
    const section = await fetchDreamSection(TENANT, tmk, env as unknown as Env)
    // doc-1 does not exist in the canonical store → honest fallback line.
    expect(section).toContain('proposals filed')
  })

  it('returns empty for tenants with no completed run', async () => {
    const tmk = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']) as CryptoKey
    expect(await fetchDreamSection(`no-such-${SUITE}`, tmk, env as unknown as Env)).toBe('')
  })
})
