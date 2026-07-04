// Mission Phase 9: working-session context — TMK-encrypted window at rest,
// SDK-shaped messages, idle-close lifecycle with evidence summary into
// canonical, honest fallbacks, and the execution-trace encryption contract.

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { env } from 'cloudflare:test'
import {
  appendSessionMessage, clearSession, ensureSessionTables, readSessionMeta,
  readSessionWindow, windowAsPromptBlock, type SessionSql,
} from '../src/services/session/working-session'
import { closeSessionWithSummary } from '../src/services/session/close-summary'
import { recordExchange, type SessionHost } from '../src/workers/mcpagent/do/session-runtime'
import { persistExecutionTrace } from '../src/agents/execution/trace'
import { decryptWithKek } from '../src/cron/kek'
import { installCanonicalMemoryTestStore } from '../src/services/canonical-postgres'
import { getCanonicalMemoryStore } from '../src/services/canonical-postgres'
import type { Env } from '../src/types/env'

const SUITE = crypto.randomUUID()
const TENANT = `test-tenant-mission-90-${SUITE}`
installCanonicalMemoryTestStore(env as unknown as Env)

async function testTmk(): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(`m90-${SUITE}`), { name: 'HKDF' }, false, ['deriveKey'])
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: new TextEncoder().encode('m90'), info: new TextEncoder().encode('m90') },
    material, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
}

/** In-memory tagged-template sql fake over the two session tables. */
function memorySql() {
  const messages: Array<Record<string, string | number | null>> = []
  const sessions = new Map<string, Record<string, string | number | null>>()
  const sql = (<T,>(strings: TemplateStringsArray, ...values: Array<string | number | boolean | null>): T[] => {
    const text = strings.join('?').replace(/\s+/g, ' ').trim()
    if (text.startsWith('CREATE TABLE') || text.startsWith('CREATE INDEX')) return []
    if (text.startsWith('SELECT MAX(seq)')) {
      const rows = messages.filter(m => m.session_key === values[0])
      return [{ maxSeq: rows.length ? Math.max(...rows.map(r => Number(r.seq))) : null } as T]
    }
    if (text.startsWith('INSERT INTO haetsal_session_messages')) {
      const [id, key, seq, role, cipher, createdAt] = values
      messages.push({ id: String(id), session_key: String(key), seq: Number(seq), role: String(role), parts_ciphertext: String(cipher), created_at: Number(createdAt) })
      return []
    }
    if (text.startsWith('INSERT INTO haetsal_sessions')) {
      const [key, , lastAt, createdAt] = values
      const existing = sessions.get(String(key))
      if (existing) { existing.turn_count = Number(existing.turn_count) + 1; existing.last_activity_at = Number(lastAt) }
      else sessions.set(String(key), { session_key: String(key), turn_count: 1, close_schedule_id: null, last_activity_at: Number(lastAt), created_at: Number(createdAt) })
      return []
    }
    if (text.startsWith('SELECT turn_count FROM haetsal_sessions')) {
      const row = sessions.get(String(values[0]))
      return row ? [{ turn_count: row.turn_count } as T] : []
    }
    if (text.startsWith('SELECT turn_count, close_schedule_id')) {
      const row = sessions.get(String(values[0]))
      return row ? [row as T] : []
    }
    if (text.startsWith('SELECT id, role, parts_ciphertext')) {
      const rows = messages.filter(m => m.session_key === values[0])
        .sort((a, b) => Number(b.seq) - Number(a.seq)).slice(0, Number(values[1]))
      return rows as T[]
    }
    if (text.startsWith('UPDATE haetsal_sessions SET close_schedule_id')) {
      const row = sessions.get(String(values[1]))
      if (row) row.close_schedule_id = values[0] === null ? null : String(values[0])
      return []
    }
    if (text.startsWith('DELETE FROM haetsal_session_messages')) {
      for (let i = messages.length - 1; i >= 0; i--) if (messages[i].session_key === values[0]) messages.splice(i, 1)
      return []
    }
    if (text.startsWith('DELETE FROM haetsal_sessions')) { sessions.delete(String(values[0])); return [] }
    throw new Error(`memorySql: unhandled: ${text.slice(0, 60)}`)
  })
  return { sql: sql as SessionSql, messages, sessions }
}

beforeAll(async () => {
  const now = Date.now()
  await env.D1_US.prepare(
    `INSERT OR IGNORE INTO tenants
     (id, created_at, updated_at, data_region, primary_channel, hindsight_tenant_id, ai_cost_reset_at)
     VALUES (?, ?, ?, 'us', 'sms', ?, ?)`,
  ).bind(TENANT, now, now, `hindsight-${TENANT}`, now).run()
})

beforeEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('mission 9.0 — encrypted window at rest', () => {
  it('messages rest as ciphertext; window round-trips in order', async () => {
    const tmk = await testTmk()
    const { sql, messages } = memorySql()
    ensureSessionTables(sql)
    await appendSessionMessage(sql, tmk, 'telegram:1', 'user', `met Alice about the roadmap ${SUITE}`)
    await appendSessionMessage(sql, tmk, 'telegram:1', 'assistant', 'Noted — want a reminder?')
    expect(messages.every(m => !String(m.parts_ciphertext).includes('Alice'))).toBe(true) // Law 2 at rest
    const window = await readSessionWindow(sql, tmk, 'telegram:1')
    expect(window).toHaveLength(2)
    expect(window[0].role).toBe('user')
    expect(window[0].parts[0].text).toContain('Alice')
    expect(window[1].role).toBe('assistant')
    const block = windowAsPromptBlock(window)
    expect(block).toMatch(/User: .*Alice/)
    expect(block).toMatch(/Haetsal: Noted/)
  })

  it('window respects the limit and unreadable rows are skipped', async () => {
    const tmk = await testTmk()
    const { sql, messages } = memorySql()
    for (let i = 0; i < 15; i++) await appendSessionMessage(sql, tmk, 'k', 'user', `turn ${i}`)
    expect(await readSessionWindow(sql, tmk, 'k', 4)).toHaveLength(4)
    messages[messages.length - 1].parts_ciphertext = 'garbage'
    const window = await readSessionWindow(sql, tmk, 'k', 4)
    expect(window).toHaveLength(3) // skipped, not thrown
  })
})

describe('mission 9.0 — exchange lifecycle', () => {
  function makeHost(tmk: CryptoKey | null) {
    const mem = memorySql()
    const scheduled: Array<{ when: Date; callback: string; payload: unknown; id: string }> = []
    const cancelled: string[] = []
    const host: SessionHost = {
      env: { ...env, AI_GATEWAY_ID: 'g', AI: { run: async () => ({ response: 'They discussed the roadmap and set a follow-up.' }) } } as unknown as Env,
      sql: mem.sql, tenantId: TENANT, tmk,
      schedule: async (when, callback, payload) => {
        const id = `s-${scheduled.length + 1}`
        scheduled.push({ when, callback, payload, id })
        return { id }
      },
      cancelSchedule: async (id) => { cancelled.push(id); return true },
    }
    return { host, mem, scheduled, cancelled }
  }

  it('records both turns and re-arms the idle-close alarm (replacing the old one)', async () => {
    const tmk = await testTmk()
    const { host, scheduled, cancelled } = makeHost(tmk)
    await recordExchange(host, 'telegram:9', 'hello', 'hi there')
    await recordExchange(host, 'telegram:9', 'second', 'reply')
    expect(scheduled).toHaveLength(2)
    expect(scheduled.every(s => s.callback === 'closeIdleSession')).toBe(true)
    expect(cancelled).toEqual(['s-1']) // first alarm replaced
    expect(JSON.stringify(scheduled[0].payload)).not.toContain('hello') // content-free alarm payload
  })

  it('without a session key it degrades honestly (no throw, nothing recorded)', async () => {
    const { host, mem } = makeHost(null)
    const result = await recordExchange(host, 'telegram:9', 'hello', 'hi')
    expect(result.recorded).toBe(false)
    expect(mem.messages).toHaveLength(0)
  })

  it('close summarizes into canonical as session-source evidence and clears', async () => {
    const tmk = await testTmk()
    const { host, mem } = makeHost(tmk)
    await recordExchange(host, 'telegram:9', 'met Alice re roadmap', 'Noted!')
    const result = await closeSessionWithSummary(host.env, host.sql, tmk, TENANT, 'telegram:9')
    expect(result.closed).toBe(true)
    expect(result.captureId).not.toBeNull()
    expect(mem.messages).toHaveLength(0) // window cleared
    const store = getCanonicalMemoryStore(env as unknown as Env)
    const rows = await store.searchChunksLexical(TENANT, 'roadmap follow-up', null, 5)
    expect(rows.length).toBeGreaterThanOrEqual(1)
  })
})

describe('mission 9.0 — execution reasoning trace (Law 2)', () => {
  it('persists the trace AES-GCM encrypted, decryptable with the same key', async () => {
    const tmk = await testTmk()
    const stored = new Map<string, string>()
    const fakeEnv = {
      R2_OBSERVABILITY: { put: async (key: string, value: string) => { stored.set(key, value) } },
    } as unknown as Env
    await persistExecutionTrace(fakeEnv, tmk, {
      runId: 'r1', tenantId: TENANT, profile: 'research',
      task: `research Alice's roadmap ${SUITE}`, status: 'completed',
      turns: 2, toolCalls: 1, toolsUsed: ['web_search'],
      resultText: 'found it', startedAt: 1, endedAt: 2,
    })
    const [key, ciphertext] = [...stored.entries()][0]
    expect(key).toBe(`traces/${TENANT}/exec-r1`)
    expect(ciphertext).not.toContain('Alice')
    const plaintext = await decryptWithKek(ciphertext, tmk)
    expect(JSON.parse(plaintext)).toMatchObject({ runId: 'r1', toolsUsed: ['web_search'] })
  })
})
