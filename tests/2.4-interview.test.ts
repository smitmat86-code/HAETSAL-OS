// tests/2.4-interview.test.ts
// Bootstrap interview tests — question flow, answer retention, write policy

import { describe, it, expect, beforeAll } from 'vitest'
import { env } from 'cloudflare:test'
import {
  createInitialState, currentQuestion, currentDomain,
  recordAnswer, totalQuestions, answeredCount,
} from '../src/services/bootstrap/interview'
import { INTERVIEW_DOMAINS } from '../src/types/bootstrap'

const TEST_TENANT = 'interview-test-tenant'

async function deriveTestTmk(): Promise<CryptoKey> {
  const keyMaterial = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode('test-interview-key'),
    { name: 'HKDF' }, false, ['deriveKey'],
  )
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: new TextEncoder().encode('test'), info: new TextEncoder().encode('interview') },
    keyMaterial, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'],
  )
}

beforeAll(async () => {
  const now = Date.now()
  await env.D1_US.prepare(
    `INSERT OR IGNORE INTO tenants
     (id, created_at, updated_at, data_region, primary_channel, hindsight_tenant_id, ai_cost_reset_at)
     VALUES (?, ?, ?, 'us', 'sms', ?, ?)`,
  ).bind(TEST_TENANT, now, now, `hindsight-${TEST_TENANT}`, now).run()
})

describe('Interview question flow', () => {
  it('starts with identity domain, first question', () => {
    const state = createInitialState()
    expect(currentDomain(state)).toBe('identity')
    expect(currentQuestion(state)).toContain('name')
  })

  it('has 12 total questions across 5 domains', () => {
    expect(totalQuestions()).toBe(12)
    expect(INTERVIEW_DOMAINS).toHaveLength(5)
  })

  it('advances through questions within a domain', async () => {
    const tmk = await deriveTestTmk()
    let state = createInitialState()
    const result = await recordAnswer(state, 'My name is Matt', TEST_TENANT, tmk, env)
    state = result.state

    expect(result.complete).toBe(false)
    expect(result.nextQuestion).not.toBeNull()
    expect(currentDomain(state)).toBe('identity')
    expect(answeredCount(state)).toBe(1)
  })

  it('transitions between domains correctly', async () => {
    const tmk = await deriveTestTmk()
    let state = createInitialState()

    // Answer all 3 identity questions
    for (let i = 0; i < 3; i++) {
      const result = await recordAnswer(state, `Answer ${i}`, TEST_TENANT, tmk, env)
      state = result.state
    }

    // Should now be in career domain
    expect(currentDomain(state)).toBe('career')
    expect(answeredCount(state)).toBe(3)
  })

  it('completes after all questions answered', async () => {
    const tmk = await deriveTestTmk()
    let state = createInitialState()

    for (let i = 0; i < totalQuestions(); i++) {
      const result = await recordAnswer(state, `Answer ${i}`, TEST_TENANT, tmk, env)
      state = result.state
      if (i < totalQuestions() - 1) {
        expect(result.complete).toBe(false)
        expect(result.nextQuestion).not.toBeNull()
      } else {
        expect(result.complete).toBe(true)
        expect(result.nextQuestion).toBeNull()
      }
    }
  })

  it('answers retained as semantic, user_authored, tier 3', async () => {
    const tmk = await deriveTestTmk()
    const state = createInitialState()
    await recordAnswer(state, 'I am a software engineer', TEST_TENANT, tmk, env)

    // Verify memory_audit has the retain entry
    const audit = await env.D1_US.prepare(
      `SELECT * FROM memory_audit WHERE tenant_id = ? AND provenance = 'user_authored'
       ORDER BY created_at DESC LIMIT 1`,
    ).bind(TEST_TENANT).first()

    expect(audit).not.toBeNull()
    expect(audit!.memory_type).toBe('semantic')
    expect(audit!.provenance).toBe('user_authored')
  })
})
