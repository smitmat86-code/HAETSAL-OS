// scripts/mission-phase11-live-smoke.ts
// Phase 11 gate (demo clause 7): the dashboard SPA serves from Workers Static
// Assets behind CF Access with all 8 panels present, and every panel's data
// feed answers live. Run: npx tsx scripts/mission-phase11-live-smoke.ts

const BASE = 'https://haetsalos.specialdarksystems.com'
const clientId = process.env.CF_ACCESS_CLIENT_ID
const clientSecret = process.env.CF_ACCESS_CLIENT_SECRET
if (!clientId || !clientSecret) { console.error('SMOKE ABORT: service-token env missing'); process.exit(2) }
const HEADERS: Record<string, string> = { 'CF-Access-Client-Id': clientId, 'CF-Access-Client-Secret': clientSecret }

const results: Array<{ step: string; ok: boolean; note: string }> = []
const record = (step: string, ok: boolean, note: string) => {
  results.push({ step, ok, note })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${step} — ${note}`)
}

async function get(path: string): Promise<{ status: number; text: string }> {
  const res = await fetch(`${BASE}${path}`, { headers: HEADERS })
  return { status: res.status, text: await res.text() }
}

const PANEL_IDS = ['memory', 'agents', 'timeline', 'dream', 'automations', 'connections', 'usage', 'traces']
const FEEDS: Array<[string, string]> = [
  ['agents+heartbeat', '/api/agents/runs?limit=5'],
  ['automations', '/api/automations'],
  ['dream-latest', '/api/dream/latest'],
  ['review-inbox', '/api/dream/reviews?status=pending'],
  ['connections', '/api/connections'],
  ['compiled-pages', '/api/compiled'],
  ['usage', '/api/usage/summary'],
  ['traces', '/api/traces/recent'],
  ['memory-search', '/api/memory/search?q=haetsal&mode=lexical'],
]

async function main(): Promise<void> {
  await get('/dashboard/agents') // session refresh (TMK for search)

  const spa = await get('/dashboard.html')
  const missing = PANEL_IDS.filter(id => !spa.text.includes(`<section id="${id}"`))
  record('spa-serves', spa.status === 200 && spa.text.includes('HAETSAL — Dashboard'), `status=${spa.status}, ${spa.text.length} chars`)
  record('all-8-panels', missing.length === 0, missing.length ? `missing: ${missing.join(',')}` : '8/8 panel sections present')

  for (const [name, path] of FEEDS) {
    const res = await get(path)
    record(`feed-${name}`, res.status === 200, `status=${res.status}, ${res.text.length} chars`)
  }

  // Traces panel end-to-end: the memory search above must have left a trace.
  const traces = await get('/api/traces/recent')
  const hasTrace = /queryId|query_id/.test(traces.text)
  record('trace-recorded', traces.status === 200 && hasTrace, hasTrace ? 'broker trace present after search' : 'no trace found')

  const failed = results.filter(r => !r.ok)
  console.log(`\nSMOKE ${failed.length === 0 ? 'GREEN' : 'RED'}: ${results.length - failed.length}/${results.length} checks passed`)
  process.exit(failed.length === 0 ? 0 : 1)
}

main().catch((error) => { console.error('SMOKE CRASH:', error instanceof Error ? error.message : String(error)); process.exit(1) })
