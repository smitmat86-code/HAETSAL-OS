// Mission Phase 7: user automations — tz-correct recurrence (incl. DST
// boundaries), chat NL parsing, create/fire/re-arm/toggle/delete lifecycle
// against a scripted host, honest no-session skips, and the Sendblue
// reply-window skip event on delivery failure.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { env } from 'cloudflare:test'
import { nextOccurrence, wallClockInTz, describeRecurrence, zonedTimeToUtc } from '../src/services/automations/recurrence'
import { parseAutomationCommand, parseAutomationIntent } from '../src/services/automations/nl-parse'
import {
  createAutomation, fireAutomationTick, removeAutomation, toggleAutomation, type AutomationHost,
} from '../src/workers/mcpagent/do/automation-runtime'
import { listAutomationsView } from '../src/workers/mcpagent/do/automation-view'
import { handleExecutionTaskFinish } from '../src/workers/mcpagent/do/agent-finish'
import { dispatchExecutionTask } from '../src/workers/mcpagent/do/agent-dispatch'
import { decryptWithKek, encryptWithKek } from '../src/cron/kek'
import type { Env } from '../src/types/env'

const SUITE = crypto.randomUUID()
const TENANT = `test-tenant-mission-70-${SUITE}`
const LA = 'America/Los_Angeles'

async function testTmk(): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(`m70-${SUITE}`), { name: 'HKDF' }, false, ['deriveKey'])
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: new TextEncoder().encode('m70'), info: new TextEncoder().encode('m70') },
    material, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
}

describe('mission 7.0 — recurrence math (tz + DST correct)', () => {
  it('daily: same-day slot when still ahead, next day when passed', () => {
    // 2026-06-15 10:00 LA (UTC-7) = 17:00Z
    const now = Date.UTC(2026, 5, 15, 17, 0)
    const at11 = nextOccurrence({ kind: 'daily', hour: 11, minute: 0, tz: LA }, now)
    expect(wallClockInTz(at11, LA)).toMatchObject({ d: 15, h: 11, min: 0 })
    const at9 = nextOccurrence({ kind: 'daily', hour: 9, minute: 0, tz: LA }, now)
    expect(wallClockInTz(at9, LA)).toMatchObject({ d: 16, h: 9, min: 0 })
  })

  it('weekdays: Friday evening rolls to Monday', () => {
    // Fri 2026-06-19 20:00 LA = Sat 03:00Z(+1d)
    const now = Date.UTC(2026, 5, 20, 3, 0)
    const next = nextOccurrence({ kind: 'weekdays', hour: 8, minute: 0, tz: LA }, now)
    const wall = wallClockInTz(next, LA)
    expect(wall.weekday).toBe(1) // Monday
    expect(wall).toMatchObject({ d: 22, h: 8, min: 0 })
  })

  it('weekly: lands on the requested weekday', () => {
    const now = Date.UTC(2026, 5, 15, 17, 0) // Mon Jun 15
    const next = nextOccurrence({ kind: 'weekly', dayOfWeek: 3, hour: 14, minute: 30, tz: LA }, now)
    expect(wallClockInTz(next, LA)).toMatchObject({ weekday: 3, d: 17, h: 14, min: 30 })
  })

  it('spring-forward: 8am fires at 8am wall clock on both sides of the jump', () => {
    // US DST 2026 starts Sun Mar 8 (23h day). Fri Mar 6 12:00 LA (UTC-8) = 20:00Z.
    const beforeJump = Date.UTC(2026, 2, 6, 20, 0)
    const satSlot = nextOccurrence({ kind: 'daily', hour: 8, minute: 0, tz: LA }, beforeJump)
    expect(wallClockInTz(satSlot, LA)).toMatchObject({ d: 7, h: 8 })
    // Fixed-UTC cron would drift an hour here; wall clock must not.
    const sunSlot = nextOccurrence({ kind: 'daily', hour: 8, minute: 0, tz: LA }, satSlot)
    expect(wallClockInTz(sunSlot, LA)).toMatchObject({ d: 8, h: 8 })
    expect(sunSlot - satSlot).toBe(23 * 3600_000) // 23h day across the jump
  })

  it('fall-back: the 25-hour day still fires once at the right wall time', () => {
    // US DST 2026 ends Sun Nov 1 (25h day). Fri Oct 30 12:00 LA (UTC-7) = 19:00Z.
    const before = Date.UTC(2026, 9, 30, 19, 0)
    const satSlot = nextOccurrence({ kind: 'daily', hour: 8, minute: 0, tz: LA }, before)
    expect(wallClockInTz(satSlot, LA)).toMatchObject({ d: 31, h: 8 })
    const sunSlot = nextOccurrence({ kind: 'daily', hour: 8, minute: 0, tz: LA }, satSlot)
    expect(wallClockInTz(sunSlot, LA)).toMatchObject({ d: 1, h: 8 })
    expect(sunSlot - satSlot).toBe(25 * 3600_000) // 25h day
  })

  it('zonedTimeToUtc round-trips through wallClockInTz', () => {
    const epoch = zonedTimeToUtc(2026, 7, 4, 9, 30, LA)
    expect(wallClockInTz(epoch, LA)).toMatchObject({ y: 2026, m: 7, d: 4, h: 9, min: 30 })
  })

  it('describeRecurrence is content-free and stable', () => {
    expect(describeRecurrence({ kind: 'weekdays', hour: 8, minute: 0, tz: LA }))
      .toBe(`every weekday at 08:00 (${LA})`)
  })
})

describe('mission 7.0 — chat NL parsing', () => {
  it('parses the demo phrase', () => {
    const parsed = parseAutomationIntent('every weekday at 8am, brief me on my day')
    expect(parsed).not.toBeNull()
    expect(parsed!.spec).toMatchObject({ kind: 'weekdays', hour: 8, minute: 0 })
    expect(parsed!.task).toBe('brief me on my day')
  })

  it('parses named times, weekly days, and pm clock times', () => {
    expect(parseAutomationIntent('every morning, summarize my inbox')!.spec).toMatchObject({ kind: 'daily', hour: 8 })
    expect(parseAutomationIntent('every friday at 5:30 pm, recap the week')!.spec)
      .toMatchObject({ kind: 'weekly', dayOfWeek: 5, hour: 17, minute: 30 })
  })

  it('rejects non-automation phrasing and missing tasks', () => {
    expect(parseAutomationIntent('brief me on my day')).toBeNull()          // no cadence
    expect(parseAutomationIntent('every day at 8am')).toBeNull()            // no task
    expect(parseAutomationIntent('we meet every day at 3')).toBeNull()      // ambiguous bare hour 1-7
  })

  it('parses management commands', () => {
    expect(parseAutomationCommand('list automations')).toEqual({ kind: 'list' })
    expect(parseAutomationCommand('pause automation ab12cd34')).toEqual({ kind: 'toggle', idPrefix: 'ab12cd34', enabled: false })
    expect(parseAutomationCommand('resume automation ab12cd34')).toEqual({ kind: 'toggle', idPrefix: 'ab12cd34', enabled: true })
    expect(parseAutomationCommand('delete automation ab12cd34')).toEqual({ kind: 'delete', idPrefix: 'ab12cd34' })
    expect(parseAutomationCommand('what should I automate?')).toBeNull()
  })
})

// ── Scripted host over real automation tables (in-memory sql fake) ──────────

type Row = Record<string, string | number | null>

function memorySql() {
  const automations = new Map<string, Row>()
  const events: Row[] = []
  const tasks = new Map<string, Row>()
  const runs = new Map<string, Row>()
  const sql = (<T,>(strings: TemplateStringsArray, ...values: Array<string | number | boolean | null>): T[] => {
    const text = strings.join('?').replace(/\s+/g, ' ').trim()
    if (text.startsWith('CREATE TABLE')) return []
    if (text.startsWith('ALTER TABLE')) throw new Error('exists')
    if (text.startsWith('INSERT INTO haetsal_automations')) {
      const [id, kind, hour, minute, dow, tz, profile, channel, replyTo, cipher, enabled, scheduleId, createdAt] = values
      automations.set(String(id), {
        id: String(id), kind: String(kind), hour: Number(hour), minute: Number(minute),
        day_of_week: dow === null ? null : Number(dow), tz: String(tz), profile: String(profile),
        reply_channel: String(channel), reply_to: String(replyTo), spec_ciphertext: String(cipher),
        enabled: Number(enabled), schedule_id: scheduleId === null ? null : String(scheduleId),
        created_at: Number(createdAt), last_fired_at: null, last_status: null,
      })
      return []
    }
    if (text.startsWith('SELECT') && text.includes('FROM haetsal_automations WHERE id LIKE')) {
      const prefix = String(values[0]).replace(/%$/, '')
      const hits = [...automations.keys()].filter(k => k.startsWith(prefix)).slice(0, 2)
      return hits.map(id => ({ id })) as T[]
    }
    if (text.startsWith('SELECT') && text.includes('FROM haetsal_automations WHERE id =')) {
      const row = automations.get(String(values[0]))
      return row ? [row as T] : []
    }
    if (text.includes('FROM haetsal_automations ORDER BY')) {
      return [...automations.values()].sort((a, b) => Number(b.created_at) - Number(a.created_at)) as T[]
    }
    if (text.startsWith('UPDATE haetsal_automations SET enabled')) {
      const row = automations.get(String(values[2]))
      if (row) { row.enabled = values[0] ? 1 : 0; row.schedule_id = values[1] === null ? null : String(values[1]) }
      return []
    }
    if (text.startsWith('UPDATE haetsal_automations SET schedule_id')) {
      const row = automations.get(String(values[1]))
      if (row) row.schedule_id = values[0] === null ? null : String(values[0])
      return []
    }
    if (text.startsWith('UPDATE haetsal_automations SET last_fired_at')) {
      const row = automations.get(String(values[2] ?? values[1]))
      if (row) { row.last_fired_at = Number(values[0]); row.last_status = String(values[1]) }
      return []
    }
    if (text.startsWith('DELETE FROM haetsal_automations')) { automations.delete(String(values[0])); return [] }
    if (text.startsWith('DELETE FROM haetsal_automation_events')) return []
    if (text.startsWith('INSERT INTO haetsal_automation_events')) {
      events.push({ id: String(values[0]), automation_id: String(values[1]), at: Number(values[2]), status: String(values[3]), run_id: values[4] === null ? null : String(values[4]) })
      return []
    }
    if (text.includes('FROM haetsal_automation_events')) {
      return events.filter(e => e.automation_id === String(values[0])).slice(0, Number(values[1] ?? 10)) as T[]
    }
    if (text.startsWith('INSERT INTO haetsal_agent_tasks')) {
      const [runId, profile, tools, cipher, channel, replyTo, retryOf, origin, createdAt] = values
      tasks.set(String(runId), {
        run_id: String(runId), profile: String(profile), tools_json: String(tools), task_ciphertext: String(cipher),
        reply_channel: String(channel), reply_to: String(replyTo), retry_of: retryOf === null ? null : String(retryOf),
        origin: origin === null ? null : String(origin), created_at: Number(createdAt), delivered_final: 0, delivered_giveup: 0,
      })
      return []
    }
    if (text.includes('FROM haetsal_agent_tasks WHERE run_id')) {
      const row = tasks.get(String(values[0]))
      return row ? [row as T] : []
    }
    if (text.includes('SET delivered_final = 1, delivered_giveup = 1')) {
      const row = tasks.get(String(values[0]))
      if (row && row.delivered_final === 0) { row.delivered_final = 1; row.delivered_giveup = 1; return [{ run_id: row.run_id } as T] }
      return []
    }
    if (text.includes('SET delivered_giveup = 1')) {
      const row = tasks.get(String(values[0]))
      if (row && row.delivered_giveup === 0 && row.delivered_final === 0) { row.delivered_giveup = 1; return [{ run_id: row.run_id } as T] }
      return []
    }
    if (text.includes('SELECT output_json FROM cf_agent_tool_runs')) {
      const row = runs.get(String(values[0]))
      return row ? [{ output_json: row.output_json } as T] : []
    }
    throw new Error(`memorySql: unhandled: ${text.slice(0, 70)}`)
  })
  return { sql, automations, events, tasks, runs }
}

function makeAutomationHost(tmk: CryptoKey | null) {
  const mem = memorySql()
  const scheduled: Array<{ when: Date; callback: string; payload: unknown; id: string }> = []
  const cancelled: string[] = []
  let dispatchCount = 0
  const host: AutomationHost = {
    env: { ...env, TELEGRAM_BOT_TOKEN: 'test-token' } as unknown as Env,
    sql: mem.sql,
    tenantId: TENANT, tmk, jwtSub: 'test-sub',
    runAgentTool: async () => {
      const runId = `run-${++dispatchCount}`
      mem.runs.set(runId, { run_id: runId, output_json: null })
      return { runId, status: 'running' }
    },
    schedule: async (when, callback, payload) => {
      const id = `sched-${scheduled.length + 1}`
      scheduled.push({ when, callback, payload, id })
      return { id }
    },
    cancelSchedule: async (id) => { cancelled.push(id); return true },
  }
  return { host, mem, scheduled, cancelled }
}

beforeEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('mission 7.0 — automation lifecycle', () => {
  it('create encrypts the task, arms a future one-shot, and lists round-trip', async () => {
    const tmk = await testTmk()
    const { host, mem, scheduled } = makeAutomationHost(tmk)
    const secretTask = `brief me on the Alice project ${SUITE}`
    const { id, description } = await createAutomation(host, {
      task: secretTask,
      spec: { kind: 'weekdays', hour: 8, minute: 0, tz: LA },
      replyChannel: 'telegram', replyTo: '12345',
    })
    expect(description).toContain('every weekday at 08:00')
    const row = mem.automations.get(id)!
    expect(String(row.spec_ciphertext)).not.toContain('Alice')  // Law 2 at rest
    expect(scheduled).toHaveLength(1)
    expect(scheduled[0].callback).toBe('fireAutomation')
    expect(scheduled[0].when.getTime()).toBeGreaterThan(Date.now())
    expect(JSON.stringify(scheduled[0].payload)).not.toContain('Alice') // alarm payload content-free
    const views = await listAutomationsView(host)
    expect(views[0].task).toBe(secretTask) // transient decrypt for the view
    expect(views[0].enabled).toBe(true)
  })

  it('fire dispatches the decrypted task with automation origin and RE-ARMS', async () => {
    const tmk = await testTmk()
    const { host, mem, scheduled } = makeAutomationHost(tmk)
    const { id } = await createAutomation(host, {
      task: 'brief me on my day',
      spec: { kind: 'daily', hour: 8, minute: 0, tz: LA },
      replyChannel: 'telegram', replyTo: '12345',
    })
    await fireAutomationTick(host, { automationId: id })
    expect(mem.automations.get(id)!.last_status).toBe('dispatched')
    expect(mem.events.filter(e => e.automation_id === id && e.status === 'dispatched')).toHaveLength(1)
    expect(mem.tasks.get('run-1')!.origin).toBe(`automation:${id}`)
    const spec = JSON.parse(await decryptWithKek(String(mem.tasks.get('run-1')!.task_ciphertext), tmk)) as { task: string }
    expect(spec.task).toBe('brief me on my day')
    expect(scheduled).toHaveLength(2) // create-arm + post-fire re-arm
  })

  it('fire without a session key records an honest skip and still re-arms', async () => {
    const tmk = await testTmk()
    const { host, mem, scheduled } = makeAutomationHost(tmk)
    const { id } = await createAutomation(host, {
      task: 't x', spec: { kind: 'daily', hour: 8, minute: 0, tz: LA },
      replyChannel: 'telegram', replyTo: '1',
    })
    host.tmk = null
    await fireAutomationTick(host, { automationId: id })
    expect(mem.automations.get(id)!.last_status).toBe('skipped_no_session')
    expect(scheduled).toHaveLength(2)
  })

  it('toggle off cancels the alarm; toggle on re-arms; delete removes', async () => {
    const tmk = await testTmk()
    const { host, mem, scheduled, cancelled } = makeAutomationHost(tmk)
    const { id } = await createAutomation(host, {
      task: 'recap things', spec: { kind: 'daily', hour: 9, minute: 0, tz: LA },
      replyChannel: 'telegram', replyTo: '1',
    })
    await toggleAutomation(host, id.slice(0, 8), false)
    expect(cancelled).toEqual(['sched-1'])
    expect(mem.automations.get(id)!.enabled).toBe(0)
    await toggleAutomation(host, id.slice(0, 8), true)
    expect(scheduled).toHaveLength(2)
    await removeAutomation(host, id.slice(0, 8))
    expect(mem.automations.has(id)).toBe(false)
  })

  it('ambiguous id prefixes are rejected instead of guessing', async () => {
    const tmk = await testTmk()
    const { host, mem } = makeAutomationHost(tmk)
    const a = await createAutomation(host, { task: 'recap one', spec: { kind: 'daily', hour: 9, minute: 0, tz: LA }, replyChannel: 'telegram', replyTo: '1' })
    const b = await createAutomation(host, { task: 'recap two', spec: { kind: 'daily', hour: 10, minute: 0, tz: LA }, replyChannel: 'telegram', replyTo: '1' })
    // Force a shared prefix by rekeying the second row in the fake store.
    const shared = a.id.slice(0, 8)
    const rowB = mem.automations.get(b.id)!
    mem.automations.delete(b.id)
    rowB.id = `${shared}${b.id.slice(8)}`
    mem.automations.set(String(rowB.id), rowB)
    await expect(toggleAutomation(host, shared, false)).rejects.toThrow(/not found|ambiguous/)
  })

  it('disabled automations do not dispatch on a stale alarm', async () => {
    const tmk = await testTmk()
    const { host, mem } = makeAutomationHost(tmk)
    const { id } = await createAutomation(host, {
      task: 'recap', spec: { kind: 'daily', hour: 9, minute: 0, tz: LA },
      replyChannel: 'telegram', replyTo: '1',
    })
    await toggleAutomation(host, id.slice(0, 8), false)
    await fireAutomationTick(host, { automationId: id })
    expect(mem.events.filter(e => e.status === 'dispatched')).toHaveLength(0)
  })
})

describe('mission 7.0 — Sendblue reply-window skip on delivery', () => {
  it('a rejected Sendblue send logs skipped_outside_reply_window (no retry)', async () => {
    const tmk = await testTmk()
    const { host, mem } = makeAutomationHost(tmk)
    // Automation-origin task delivered over sendblue.
    await dispatchExecutionTask(host, {
      task: 'recap the day', profile: 'memory', replyChannel: 'sendblue', replyTo: '+15551234567',
      origin: 'automation:auto-1',
    })
    mem.runs.get('run-1')!.output_json = JSON.stringify({ ciphertext: await encryptWithKek('the recap', tmk) })
    vi.stubGlobal('fetch', vi.fn(async (url: RequestInfo | URL) => {
      if (String(url).includes('sendblue')) return new Response(JSON.stringify({ status: 'ERROR' }), { status: 422 })
      return new Response('{}')
    }))
    await handleExecutionTaskFinish(host, { runId: 'run-1', status: 'completed' }, { status: 'completed' })
    const skip = mem.events.find(e => e.automation_id === 'auto-1')
    expect(skip?.status).toBe('skipped_outside_reply_window')
    // Idempotent: the claim slot prevents a second attempt (no retry).
    await handleExecutionTaskFinish(host, { runId: 'run-1', status: 'completed' }, { status: 'completed' })
    expect(mem.events.filter(e => e.automation_id === 'auto-1')).toHaveLength(1)
  })

  it('successful telegram delivery logs delivered', async () => {
    const tmk = await testTmk()
    const { host, mem } = makeAutomationHost(tmk)
    await dispatchExecutionTask(host, {
      task: 'recap', profile: 'memory', replyChannel: 'telegram', replyTo: '12345',
      origin: 'automation:auto-2',
    })
    mem.runs.get('run-1')!.output_json = JSON.stringify({ ciphertext: await encryptWithKek('done', tmk) })
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ok: true }))))
    await handleExecutionTaskFinish(host, { runId: 'run-1', status: 'completed' }, { status: 'completed' })
    expect(mem.events.find(e => e.automation_id === 'auto-2')?.status).toBe('delivered')
  })
})
