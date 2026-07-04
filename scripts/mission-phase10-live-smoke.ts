// scripts/mission-phase10-live-smoke.ts
// Phase 10 gate: build the three mission pages (person/project/topic) from
// canonical truth on prod, read them back as markdown with frontmatter,
// verify list + delete + rebuild (regenerable). Run: npx tsx scripts/mission-phase10-live-smoke.ts

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

async function api(method: string, path: string, body?: unknown): Promise<{ status: number; text: string }> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: body ? { ...HEADERS, 'Content-Type': 'application/json' } : HEADERS,
    body: body ? JSON.stringify(body) : undefined,
  })
  return { status: res.status, text: await res.text() }
}

const PAGES = [
  { kind: 'person', key: 'matt', name: 'Matt', keywords: ['matt', 'user'] },
  { kind: 'project', key: 'haetsal', name: 'HAETSAL', keywords: ['haetsal', 'agent', 'research'] },
  { kind: 'topic', key: 'serverless-postgres', name: 'Serverless Postgres', keywords: ['postgres', 'serverless', 'cold'] },
]

async function main(): Promise<void> {
  await api('GET', '/dashboard/agents') // session refresh

  for (const page of PAGES) {
    const built = await api('POST', `/api/compiled/${page.kind}/${page.key}/rebuild`,
      { name: page.name, keywords: page.keywords })
    record(`rebuild-${page.kind}`, built.status === 201, `status=${built.status} ${built.text.slice(0, 80)}`)
  }

  for (const page of PAGES) {
    const got = await api('GET', `/api/compiled/${page.kind}/${page.key}`)
    const hasFrontmatter = got.text.startsWith('---') && got.text.includes('regenerable: true')
      && got.text.includes('source_count:') && got.text.includes('freshness:')
    record(`page-${page.kind}`, got.status === 200 && hasFrontmatter,
      `status=${got.status}, frontmatter=${hasFrontmatter}, ${got.text.length} chars`)
  }

  const list = await api('GET', '/api/compiled')
  const pages = JSON.parse(list.text) as Array<{ stableKey: string }>
  record('list', list.status === 200 && pages.length >= 3, `pages=${pages.length}`)

  const del = await api('DELETE', '/api/compiled/topic/serverless-postgres')
  const gone = await api('GET', '/api/compiled/topic/serverless-postgres')
  record('delete', del.status === 200 && gone.status === 404, `delete=${del.status}, after=${gone.status}`)
  const rebuilt = await api('POST', '/api/compiled/topic/serverless-postgres/rebuild',
    { name: 'Serverless Postgres', keywords: ['postgres'] })
  const back = await api('GET', '/api/compiled/topic/serverless-postgres')
  record('regenerable', rebuilt.status === 201 && back.status === 200, `rebuild=${rebuilt.status}, read=${back.status}`)

  const failed = results.filter(r => !r.ok)
  console.log(`\nSMOKE ${failed.length === 0 ? 'GREEN' : 'RED'}: ${results.length - failed.length}/${results.length} checks passed`)
  process.exit(failed.length === 0 ? 0 : 1)
}

main().catch((error) => { console.error('SMOKE CRASH:', error instanceof Error ? error.message : String(error)); process.exit(1) })
