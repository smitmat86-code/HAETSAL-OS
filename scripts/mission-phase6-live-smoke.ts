// scripts/mission-phase6-live-smoke.ts
// Phase 6 gate live smoke (demo clause 6 mechanism): sub-agent spawn
// visibility, cancel-from-dashboard within 5s, retry lineage, completion —
// all against the deployed Worker through CF Access with the
// haetsal-brain-shell-smoke service token.
//
// Run: npx tsx scripts/mission-phase6-live-smoke.ts
// Auth comes from CF_ACCESS_CLIENT_ID / CF_ACCESS_CLIENT_SECRET env vars.
// G2: this script never prints header values or response bodies verbatim
// beyond content-free ledger fields.

const BASE = 'https://haetsalos.specialdarksystems.com'

const clientId = process.env.CF_ACCESS_CLIENT_ID
const clientSecret = process.env.CF_ACCESS_CLIENT_SECRET
if (!clientId || !clientSecret) {
  console.error('SMOKE ABORT: CF_ACCESS_CLIENT_ID / CF_ACCESS_CLIENT_SECRET not set')
  process.exit(2)
}

const HEADERS: Record<string, string> = {
  'CF-Access-Client-Id': clientId,
  'CF-Access-Client-Secret': clientSecret,
}

interface RunView {
  runId: string
  status: string
  tools: string[]
  profile: string | null
  progress: { fraction: number; phase: string; at: number } | null
  heartbeatAgeMs: number | null
  retryOf: string | null
  startedAt: number
  completedAt: number | null
}

const results: Array<{ step: string; ok: boolean; note: string }> = []
function record(step: string, ok: boolean, note: string): void {
  results.push({ step, ok, note })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${step} — ${note}`)
}

async function api<T>(method: string, path: string, body?: unknown): Promise<{ status: number; json: T | null; text: string }> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: body ? { ...HEADERS, 'Content-Type': 'application/json' } : HEADERS,
    body: body ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  let json: T | null = null
  try { json = JSON.parse(text) as T } catch { /* html or empty */ }
  return { status: res.status, json, text }
}

async function pollRun(runId: string, until: (run: RunView) => boolean, timeoutMs: number): Promise<RunView | null> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const { json } = await api<RunView[]>('GET', '/api/agents/runs?limit=50')
    const run = json?.find(r => r.runId === runId) ?? null
    if (run && until(run)) return run
    await new Promise(resolve => setTimeout(resolve, 700))
  }
  return null
}

async function main(): Promise<void> {
  // 1. Dashboard panel + tenant session (initTenant runs on this route)
  const dash = await api<never>('GET', '/dashboard/agents')
  record('dashboard-panel', dash.status === 200 && dash.text.includes('Live agents'),
    `status=${dash.status}, panel markup=${dash.text.includes('Live agents')}`)

  // 2. Ledger wiring
  const list0 = await api<RunView[]>('GET', '/api/agents/runs')
  record('runs-list', list0.status === 200 && Array.isArray(list0.json),
    `status=${list0.status}, rows=${list0.json?.length ?? 'n/a'}`)

  // 3. Spawn (facets go/no-go)
  const created = await api<{ runId?: string; error?: string }>('POST', '/api/agents/runs', {
    task: 'Research current best practices for reducing cold-start latency on serverless Postgres connections. Cite sources.',
    profile: 'research',
  })
  const runId = created.json?.runId
  record('spawn', created.status === 201 && !!runId,
    `status=${created.status}${created.json?.error ? `, error=${created.json.error}` : `, runId=${runId?.slice(0, 8)}`}`)
  if (!runId) return

  // 4. Visibility: running row with scoped tools (+ progress if a heartbeat landed)
  const running = await pollRun(runId, r => r.status === 'running' || r.status === 'starting', 15_000)
  const scopedOk = !!running && running.tools.includes('web_search') && running.tools.includes('recall_memory')
    && !running.tools.includes('propose_message')
  record('visibility-scoped-tools', scopedOk,
    running ? `status=${running.status}, tools=[${running.tools.join(',')}], phase=${running.progress?.phase ?? '(none yet)'}` : 'run never appeared')

  // 5. Cancel within 5s (demo clause 6 bar)
  const cancelSent = Date.now()
  const cancel = await api<{ cancelled?: boolean }>('POST', `/api/agents/runs/${runId}/cancel`)
  const aborted = await pollRun(runId, r => r.status === 'aborted', 5_000)
  const cancelMs = Date.now() - cancelSent
  record('cancel-under-5s', cancel.status === 200 && !!aborted && cancelMs <= 5_000,
    `cancelStatus=${cancel.status}, ledger=aborted in ${cancelMs}ms`)

  // 6. Retry with lineage, then run to terminal
  const retried = await api<{ runId?: string; error?: string }>('POST', `/api/agents/runs/${runId}/retry`)
  const retryId = retried.json?.runId
  record('retry', retried.status === 200 && !!retryId, `status=${retried.status}, newRun=${retryId?.slice(0, 8)}`)
  if (retryId) {
    const lineage = await pollRun(retryId, r => r.retryOf === runId, 10_000)
    record('retry-lineage', !!lineage, lineage ? `retryOf=${lineage.retryOf?.slice(0, 8)}` : 'lineage missing')
    const terminal = await pollRun(retryId, r => ['completed', 'error', 'aborted', 'interrupted'].includes(r.status), 180_000)
    record('retry-terminal', terminal?.status === 'completed',
      `status=${terminal?.status ?? 'timeout'}${terminal?.completedAt && terminal.startedAt ? `, ${Math.round((terminal.completedAt - terminal.startedAt) / 1000)}s` : ''}`)
  }

  const failed = results.filter(r => !r.ok)
  console.log(`\nSMOKE ${failed.length === 0 ? 'GREEN' : 'RED'}: ${results.length - failed.length}/${results.length} checks passed`)
  process.exit(failed.length === 0 ? 0 : 1)
}

main().catch((error) => {
  console.error('SMOKE CRASH:', error instanceof Error ? error.message : String(error))
  process.exit(1)
})
