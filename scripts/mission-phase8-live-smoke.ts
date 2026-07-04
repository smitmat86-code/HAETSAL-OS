// scripts/mission-phase8-live-smoke.ts
// Phase 8 gate live smoke: trigger the dream cycle manually against prod,
// watch the Workflow run to completion, and verify the report + review inbox
// surfaces. The overnight cron assertion (demo clause 9 in Matt's 8am brief)
// follows naturally the next morning — this proves the mechanism live.
// Run: npx tsx scripts/mission-phase8-live-smoke.ts

const BASE = 'https://haetsalos.specialdarksystems.com'
const clientId = process.env.CF_ACCESS_CLIENT_ID
const clientSecret = process.env.CF_ACCESS_CLIENT_SECRET
if (!clientId || !clientSecret) { console.error('SMOKE ABORT: service-token env missing'); process.exit(2) }
const HEADERS: Record<string, string> = { 'CF-Access-Client-Id': clientId, 'CF-Access-Client-Secret': clientSecret }

interface DreamRun {
  id: string; status: string; events_seen: number; proposals_written: number
  report_document_id: string | null; error_message: string | null
}

const results: Array<{ step: string; ok: boolean; note: string }> = []
const record = (step: string, ok: boolean, note: string) => {
  results.push({ step, ok, note })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${step} — ${note}`)
}

async function api<T>(method: string, path: string): Promise<{ status: number; json: T | null }> {
  const res = await fetch(`${BASE}${path}`, { method, headers: HEADERS })
  const text = await res.text()
  let json: T | null = null
  try { json = JSON.parse(text) as T } catch { /* html */ }
  return { status: res.status, json }
}

async function main(): Promise<void> {
  await api('GET', '/dashboard/agents') // session refresh

  const started = await api<{ runId?: string; started?: boolean }>('POST', '/api/dream/run')
  const runId = started.json?.runId
  record('trigger', started.status === 202 && started.json?.started === true && !!runId,
    `status=${started.status}, started=${started.json?.started}`)
  if (!runId) return finish()

  // Match OUR run id — /latest also surfaces stale terminal rows.
  let run: DreamRun | null = null
  let report: string | null = null
  const deadline = Date.now() + 4 * 60_000
  while (Date.now() < deadline) {
    const latest = await api<{ run: DreamRun | null; report: string | null }>('GET', '/api/dream/latest')
    if (latest.json?.run?.id === runId && ['completed', 'failed'].includes(latest.json.run.status)) {
      run = latest.json.run
      report = latest.json.report
      break
    }
    await new Promise(resolve => setTimeout(resolve, 8000))
  }
  record('workflow-completed', run?.status === 'completed',
    `status=${run?.status ?? 'timeout'}${run?.error_message ? ` error=${run.error_message.slice(0, 80)}` : ''}`)
  record('window-read', (run?.events_seen ?? 0) >= 0 && run !== null,
    `events_seen=${run?.events_seen}, proposals=${run?.proposals_written}`)
  record('report-persisted', !!run?.report_document_id && !!report,
    run?.report_document_id ? `doc=${run.report_document_id.slice(0, 8)}, body=${report ? report.length + ' chars' : 'unreadable'}` : 'no report document')
  record('report-honest', !!report && (report.includes('Nothing was auto-promoted') || report.includes('Quiet night')),
    'report carries the report-only guarantee line')

  const reviews = await api<Array<{ kind: string; status: string }>>('GET', '/api/dream/reviews?status=pending')
  record('review-inbox', reviews.status === 200 && Array.isArray(reviews.json),
    `pending dream proposals=${reviews.json?.length ?? 'n/a'}`)
  finish()
}

function finish(): void {
  const failed = results.filter(r => !r.ok)
  console.log(`\nSMOKE ${failed.length === 0 ? 'GREEN' : 'RED'}: ${results.length - failed.length}/${results.length} checks passed`)
  process.exit(failed.length === 0 ? 0 : 1)
}

main().catch((error) => { console.error('SMOKE CRASH:', error instanceof Error ? error.message : String(error)); process.exit(1) })
