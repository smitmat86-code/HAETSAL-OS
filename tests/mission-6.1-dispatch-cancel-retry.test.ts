// Mission Phase 6: parent-side dispatch + detached finish delivery + cancel +
// retry. Runs against a scripted host (fake SQL over the two ledger tables +
// captured runAgentTool/cancelAgentTool) so the contracts are exact: budget
// wiring, content-free previews, encrypted task specs, idempotent delivery
// slots, retry lineage.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { env } from 'cloudflare:test'
import {
  dispatchExecutionTask, handleExecutionTaskFinish, DispatchUnavailableError,
  EXECUTION_MAX_BUDGET_MS, EXECUTION_NO_PROGRESS_BUDGET_MS,
} from '../src/workers/mcpagent/do/agent-dispatch'
import { cancelAgentRun, listAgentRuns, retryAgentRun, type RunsHost } from '../src/workers/mcpagent/do/agent-runs-view'
import { encryptWithKek, decryptWithKek } from '../src/cron/kek'
import type { Env } from '../src/types/env'

const SUITE = crypto.randomUUID()
const TENANT = `test-tenant-mission-61-${SUITE}`

async function testTmk(): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(`m61-${SUITE}`), { name: 'HKDF' }, false, ['deriveKey'],
  )
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: new TextEncoder().encode('m61'), info: new TextEncoder().encode('m61') },
    material, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'],
  )
}

interface TaskRow {
  run_id: string; profile: string; tools_json: string; task_ciphertext: string
  reply_channel: string; reply_to: string; retry_of: string | null
  created_at: number; delivered_final: number; delivered_giveup: number
}
interface LedgerRow {
  run_id: string; agent_type: string; input_preview: string | null; status: string
  output_json: string | null; error_message: string | null; started_at: number; completed_at: number | null
}

/** Minimal tagged-template SQL fake covering exactly the statements the
 *  dispatch/view modules issue against the two DO ledger tables. */
function fakeSql(tasks: Map<string, TaskRow>, runs: Map<string, LedgerRow>) {
  return (<T,>(strings: TemplateStringsArray, ...values: Array<string | number | boolean | null>): T[] => {
    const sql = strings.join('?').replace(/\s+/g, ' ').trim()
    if (sql.startsWith('CREATE TABLE')) return []
    if (sql.startsWith('INSERT INTO haetsal_agent_tasks')) {
      const [runId, profile, tools, ciphertext, channel, replyTo, retryOf, createdAt] = values
      if (!tasks.has(String(runId))) {
        tasks.set(String(runId), {
          run_id: String(runId), profile: String(profile), tools_json: String(tools),
          task_ciphertext: String(ciphertext), reply_channel: String(channel), reply_to: String(replyTo),
          retry_of: retryOf === null ? null : String(retryOf), created_at: Number(createdAt),
          delivered_final: 0, delivered_giveup: 0,
        })
      }
      return []
    }
    if (sql.includes('FROM haetsal_agent_tasks WHERE run_id')) {
      const row = tasks.get(String(values[0]))
      return row ? [row as T] : []
    }
    if (sql.includes('SET delivered_final = 1, delivered_giveup = 1')) {
      const row = tasks.get(String(values[0]))
      if (row && row.delivered_final === 0) {
        row.delivered_final = 1; row.delivered_giveup = 1
        return [{ run_id: row.run_id } as T]
      }
      return []
    }
    if (sql.includes('SET delivered_giveup = 1')) {
      const row = tasks.get(String(values[0]))
      if (row && row.delivered_giveup === 0 && row.delivered_final === 0) {
        row.delivered_giveup = 1
        return [{ run_id: row.run_id } as T]
      }
      return []
    }
    if (sql.includes('SELECT output_json FROM cf_agent_tool_runs')) {
      const row = runs.get(String(values[0]))
      return row ? [{ output_json: row.output_json } as T] : []
    }
    if (sql.includes('SELECT status FROM cf_agent_tool_runs')) {
      const row = runs.get(String(values[0]))
      return row ? [{ status: row.status } as T] : []
    }
    if (sql.includes('FROM cf_agent_tool_runs ORDER BY started_at')) {
      return [...runs.values()].sort((a, b) => b.started_at - a.started_at) as T[]
    }
    throw new Error(`fakeSql: unhandled statement: ${sql.slice(0, 80)}`)
  })
}

function makeHost(tmk: CryptoKey | null) {
  const tasks = new Map<string, TaskRow>()
  const runs = new Map<string, LedgerRow>()
  const dispatched: Array<{ cls: unknown; opts: Record<string, unknown> }> = []
  const cancelled: string[] = []
  let nextRunId = 0
  const host: RunsHost = {
    env: { ...env, TELEGRAM_BOT_TOKEN: 'test-token' } as unknown as Env,
    sql: fakeSql(tasks, runs),
    tenantId: TENANT,
    tmk,
    jwtSub: 'test-sub',
    runAgentTool: async (cls, opts) => {
      dispatched.push({ cls, opts: opts as unknown as Record<string, unknown> })
      const runId = `run-${++nextRunId}`
      runs.set(runId, {
        run_id: runId, agent_type: 'ExecutionAgent',
        input_preview: JSON.stringify(opts.inputPreview), status: 'running',
        output_json: null, error_message: null, started_at: Date.now(), completed_at: null,
      })
      return { runId, status: 'running' }
    },
    cancelAgentTool: async (runId) => { cancelled.push(runId) },
    subAgent: async () => ({
      inspectAgentToolRun: async () => ({ progress: { fraction: 0.5, phase: 'tool:web_search', at: Date.now() - 1500 } }),
    }),
  }
  return { host, tasks, runs, dispatched, cancelled }
}

function stubTelegram(): { sends: string[] } {
  const sends: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    if (String(url).includes('api.telegram.org')) {
      sends.push(String(init?.body ?? ''))
      return new Response(JSON.stringify({ ok: true }))
    }
    return new Response('{}')
  }))
  return { sends }
}

beforeEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

const TASK_TEXT = `research the best e-ink tablets ${SUITE}`

describe('mission 6.1 — dispatch contract', () => {
  it('spawns detached with the 15-minute budget and a content-free preview', async () => {
    const tmk = await testTmk()
    const { host, tasks, dispatched } = makeHost(tmk)
    const { runId } = await dispatchExecutionTask(host, {
      task: TASK_TEXT, profile: 'research', replyChannel: 'telegram', replyTo: '12345',
    })
    expect(runId).toBe('run-1')
    const opts = dispatched[0].opts as {
      inputPreview: unknown
      detached: { onFinish: string; maxBudgetMs: number; noProgressBudgetMs: number }
      input: { allowedTools: string[] }
    }
    expect(opts.detached.onFinish).toBe('onExecutionTaskFinish')
    expect(opts.detached.maxBudgetMs).toBe(EXECUTION_MAX_BUDGET_MS)
    expect(EXECUTION_MAX_BUDGET_MS).toBe(15 * 60_000) // boop 15-min stuck-agent auto-fail
    expect(opts.detached.noProgressBudgetMs).toBe(EXECUTION_NO_PROGRESS_BUDGET_MS)
    expect(opts.input.allowedTools).toEqual(['web_search', 'recall_memory'])
    expect(JSON.stringify(opts.inputPreview)).not.toContain('e-ink') // Law 2: preview carries no task text
    const row = tasks.get('run-1')!
    expect(row.task_ciphertext).not.toContain('e-ink')
    const spec = JSON.parse(await decryptWithKek(row.task_ciphertext, tmk)) as { task: string }
    expect(spec.task).toBe(TASK_TEXT)
  })

  it('fails honestly without a session key (no spawn, no row)', async () => {
    const { host, dispatched } = makeHost(null)
    await expect(dispatchExecutionTask(host, {
      task: 't', profile: 'memory', replyChannel: 'telegram', replyTo: '1',
    })).rejects.toBeInstanceOf(DispatchUnavailableError)
    expect(dispatched).toHaveLength(0)
  })
})

describe('mission 6.1 — detached finish delivery', () => {
  async function finishedHost() {
    const tmk = await testTmk()
    const { host, runs, tasks } = makeHost(tmk)
    await dispatchExecutionTask(host, {
      task: TASK_TEXT, profile: 'research', replyChannel: 'telegram', replyTo: '12345',
    })
    return { tmk, host, runs, tasks }
  }

  it('decrypts the run output and delivers it over the channel exactly once', async () => {
    const { tmk, host, runs } = await finishedHost()
    const { sends } = stubTelegram()
    const resultText = `Found three strong options ${SUITE}`
    runs.get('run-1')!.output_json = JSON.stringify({ ciphertext: await encryptWithKek(resultText, tmk) })
    runs.get('run-1')!.status = 'completed'
    await handleExecutionTaskFinish(host, { runId: 'run-1', status: 'completed' }, { status: 'completed' })
    await handleExecutionTaskFinish(host, { runId: 'run-1', status: 'completed' }, { status: 'completed' })
    expect(sends).toHaveLength(1) // idempotent across at-least-once delivery
    expect(sends[0]).toContain('Found three strong options')
  })

  it('budget give-up notifies, and a late real completion still delivers', async () => {
    const { tmk, host, runs } = await finishedHost()
    const { sends } = stubTelegram()
    await handleExecutionTaskFinish(host, { runId: 'run-1', status: 'interrupted' },
      { status: 'interrupted', reason: 'budget-exceeded' })
    expect(sends).toHaveLength(1)
    expect(sends[0]).toContain('stalled')
    runs.get('run-1')!.output_json = JSON.stringify({ ciphertext: await encryptWithKek('late result', tmk) })
    await handleExecutionTaskFinish(host, { runId: 'run-1', status: 'completed' }, { status: 'completed' })
    expect(sends).toHaveLength(2)
    expect(sends[1]).toContain('late result')
  })

  it('cancellation delivers a cancelled note', async () => {
    const { host } = await finishedHost()
    const { sends } = stubTelegram()
    await handleExecutionTaskFinish(host, { runId: 'run-1', status: 'aborted' }, { status: 'aborted' })
    expect(sends).toHaveLength(1)
    expect(sends[0]).toContain('cancelled')
  })
})

describe('mission 6.1 — cancel + retry + run listing', () => {
  it('cancel routes through cancelAgentTool', async () => {
    const { host, cancelled } = makeHost(await testTmk())
    await cancelAgentRun(host, 'run-x')
    expect(cancelled).toEqual(['run-x'])
  })

  it('retry re-dispatches the decrypted task with lineage; active runs refuse', async () => {
    const tmk = await testTmk()
    const { host, runs, dispatched } = makeHost(tmk)
    await dispatchExecutionTask(host, {
      task: TASK_TEXT, profile: 'research', replyChannel: 'telegram', replyTo: '12345',
    })
    await expect(retryAgentRun(host, 'run-1')).rejects.toThrow(/still active/)
    runs.get('run-1')!.status = 'error'
    const { runId } = await retryAgentRun(host, 'run-1')
    expect(runId).toBe('run-2')
    const retryOpts = dispatched[1].opts as { input: { task: string } }
    expect(retryOpts.input.task).toBe(TASK_TEXT)
    expect(JSON.stringify(dispatched[1].opts.inputPreview)).not.toContain('e-ink')
  })

  it('listAgentRuns is content-free and carries live heartbeat age', async () => {
    const tmk = await testTmk()
    const { host } = makeHost(tmk)
    await dispatchExecutionTask(host, {
      task: TASK_TEXT, profile: 'research', replyChannel: 'telegram', replyTo: '12345',
    })
    const views = await listAgentRuns(host)
    expect(views).toHaveLength(1)
    expect(views[0].profile).toBe('research')
    expect(views[0].tools).toEqual(['web_search', 'recall_memory'])
    expect(views[0].status).toBe('running')
    expect(views[0].progress?.phase).toBe('tool:web_search')
    expect(views[0].heartbeatAgeMs).toBeGreaterThanOrEqual(1000)
    expect(JSON.stringify(views)).not.toContain('e-ink') // Law 2: dashboard view carries no content
  })
})
