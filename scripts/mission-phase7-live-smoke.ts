// scripts/mission-phase7-live-smoke.ts
// Phase 7 gate live smoke (demo clause 5 mechanism): create an automation
// whose next occurrence is ~2 minutes out, watch it FIRE (dispatch a scoped
// execution-agent run + event row + re-arm), then toggle + delete. Runs
// against the deployed Worker via the haetsal-brain-shell-smoke service
// token. G2: never prints header values.
//
// Run: npx tsx scripts/mission-phase7-live-smoke.ts

const BASE = 'https://haetsalos.specialdarksystems.com'
const LA = 'America/Los_Angeles'

const clientId = process.env.CF_ACCESS_CLIENT_ID
const clientSecret = process.env.CF_ACCESS_CLIENT_SECRET
if (!clientId || !clientSecret) {
  console.error('SMOKE ABORT: CF Access service-token env vars not set')
  process.exit(2)
}
const HEADERS: Record<string, string> = {
  'CF-Access-Client-Id': clientId,
  'CF-Access-Client-Secret': clientSecret,
}

interface AutomationView {
  id: string; idShort: string; task: string; schedule: string; enabled: boolean
  nextFireAt: number | null; lastFiredAt: number | null; lastStatus: string | null
  events: Array<{ at: number; status: string; run_id: string | null }>
}

const results: Array<{ step: string; ok: boolean; note: string }> = []
function record(step: string, ok: boolean, note: string): void {
  results.push({ step, ok, note })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${step} — ${note}`)
}

async function api<T>(method: string, path: string, body?: unknown): Promise<{ status: number; json: T | null }> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: body ? { ...HEADERS, 'Content-Type': 'application/json' } : HEADERS,
    body: body ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  let json: T | null = null
  try { json = JSON.parse(text) as T } catch { /* html */ }
  return { status: res.status, json }
}

function laWallClockPlus(minutes: number): { hour: number; minute: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: LA, hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(Date.now() + minutes * 60_000))
  const get = (t: string) => Number(parts.find(p => p.type === t)?.value ?? '0')
  return { hour: get('hour'), minute: get('minute') }
}

async function findAutomation(id: string): Promise<AutomationView | null> {
  const { json } = await api<AutomationView[]>('GET', '/api/automations')
  return json?.find(a => a.id === id) ?? null
}

async function main(): Promise<void> {
  // 0. Session refresh (TMK for the smoke tenant DO).
  await api('GET', '/dashboard/agents')

  // 1. Create an automation ~2 minutes out (daily kind → today's slot).
  const { hour, minute } = laWallClockPlus(2)
  const created = await api<{ id?: string; description?: string; error?: string }>(
    'POST', '/api/automations',
    { task: 'Summarize what you know about serverless cold starts in two sentences.', kind: 'daily', hour, minute },
  )
  const id = created.json?.id
  record('create', created.status === 201 && !!id,
    `status=${created.status}${created.json?.error ? ` error=${created.json.error}` : ` id=${id?.slice(0, 8)} (${created.json?.description})`}`)
  if (!id) return finish()

  // 2. Listed, enabled, armed for the near future.
  const view = await findAutomation(id)
  const armedSoon = !!view?.nextFireAt && view.nextFireAt - Date.now() < 3.5 * 60_000
  record('armed', !!view?.enabled && armedSoon,
    view ? `enabled=${view.enabled}, fires in ${view.nextFireAt ? Math.round((view.nextFireAt - Date.now()) / 1000) : '?'}s` : 'not listed')

  // 3. Wait for the fire: lastStatus flips to dispatched + event row + re-arm.
  let fired: AutomationView | null = null
  const deadline = Date.now() + 4.5 * 60_000
  while (Date.now() < deadline) {
    const current = await findAutomation(id)
    if (current?.lastStatus) { fired = current; break }
    await new Promise(resolve => setTimeout(resolve, 10_000))
  }
  const dispatched = fired?.lastStatus === 'dispatched'
  record('fired', dispatched, `lastStatus=${fired?.lastStatus ?? 'never fired'}`)
  const rearmed = !!fired?.nextFireAt && fired.nextFireAt > Date.now() + 60_000
  record('re-armed', rearmed,
    fired?.nextFireAt ? `next in ${Math.round((fired.nextFireAt - Date.now()) / 3600_000)}h` : 'no next slot')

  // 4. The fire spawned a real execution run; follow it to terminal.
  const runId = fired?.events.find(e => e.status === 'dispatched')?.run_id
  record('run-linked', !!runId, runId ? `run=${runId.slice(0, 8)}` : 'no run id on event')
  if (runId) {
    const runDeadline = Date.now() + 150_000
    let terminal: string | null = null
    while (Date.now() < runDeadline) {
      const { json } = await api<Array<{ runId: string; status: string }>>('GET', '/api/agents/runs?limit=50')
      const run = json?.find(r => r.runId === runId)
      if (run && ['completed', 'error', 'aborted', 'interrupted'].includes(run.status)) { terminal = run.status; break }
      await new Promise(resolve => setTimeout(resolve, 8_000))
    }
    record('run-terminal', terminal === 'completed', `status=${terminal ?? 'timeout'}`)
    const delivery = (await findAutomation(id))?.events.find(e => e.status === 'delivered' || e.status === 'delivery_failed' || e.status === 'skipped_outside_reply_window')
    record('delivery-event', !!delivery, `status=${delivery?.status ?? 'none'} (smoke tenant has no chat registered — delivery_failed is expected)`)
  }

  // 5. Toggle off disarms; delete removes.
  const toggled = await api<{ enabled?: boolean }>('POST', `/api/automations/${id}/toggle?enabled=false`)
  const afterToggle = await findAutomation(id)
  record('toggle-off', toggled.status === 200 && afterToggle?.enabled === false && afterToggle.nextFireAt === null,
    `enabled=${afterToggle?.enabled}, nextFireAt=${afterToggle?.nextFireAt}`)
  const deleted = await api('DELETE', `/api/automations/${id}`)
  const afterDelete = await findAutomation(id)
  record('delete', deleted.status === 200 && afterDelete === null, `status=${deleted.status}, listed=${afterDelete !== null}`)
  finish()
}

function finish(): void {
  const failed = results.filter(r => !r.ok)
  console.log(`\nSMOKE ${failed.length === 0 ? 'GREEN' : 'RED'}: ${results.length - failed.length}/${results.length} checks passed`)
  process.exit(failed.length === 0 ? 0 : 1)
}

main().catch((error) => {
  console.error('SMOKE CRASH:', error instanceof Error ? error.message : String(error))
  process.exit(1)
})
