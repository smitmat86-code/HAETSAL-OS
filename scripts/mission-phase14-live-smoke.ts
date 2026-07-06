// scripts/mission-phase14-live-smoke.ts
// Phase 14 gate smoke: System panel API against prod (smoke tenant).
// Overview → save override → verify live → history → rollback → reset →
// task toggle round-trip. Run: npx tsx scripts/mission-phase14-live-smoke.ts

const BASE = 'https://haetsalos.specialdarksystems.com'
const id = process.env.CF_ACCESS_CLIENT_ID
const secret = process.env.CF_ACCESS_CLIENT_SECRET
if (!id || !secret) { console.error('ABORT: service-token env missing'); process.exit(2) }
const HEADERS = { 'CF-Access-Client-Id': id, 'CF-Access-Client-Secret': secret }

let pass = 0, fail = 0
const check = (name: string, ok: boolean, note = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${note ? ' — ' + note : ''}`)
  ok ? pass++ : fail++
}

async function api(method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: body ? { ...HEADERS, 'Content-Type': 'application/json' } : HEADERS,
    body: body ? JSON.stringify(body) : undefined,
  })
  let json: any = null
  try { json = await res.json() } catch { /* non-json */ }
  return { status: res.status, json }
}

async function main(): Promise<void> {
  await api('GET', '/') // session refresh → provisions the smoke tenant's KEK

  const overview = await api('GET', '/api/system/overview')
  check('overview 200', overview.status === 200)
  check('overview: prompts catalog', (overview.json?.prompts?.length ?? 0) >= 7,
    `${overview.json?.prompts?.length} entries`)
  check('overview: models + profiles + tasks', !!overview.json?.models?.chat
    && !!overview.json?.profiles && (overview.json?.tasks?.length ?? 0) === 4)

  const marker = `smoke14-${Date.now().toString(36)}`
  const v1 = await api('POST', '/api/system/prompts/persona.chat',
    { body: `You are Smoke Haetsal over {channel}. Marker ${marker}-one.` })
  check('save v1', v1.status === 200 && typeof v1.json?.version === 'number', `v${v1.json?.version}`)
  const v2 = await api('POST', '/api/system/prompts/persona.chat',
    { body: `You are Smoke Haetsal over {channel}. Marker ${marker}-two.` })
  check('save v2', v2.status === 200 && v2.json?.version === v1.json?.version + 1, `v${v2.json?.version}`)

  const after = await api('GET', '/api/system/overview')
  const entry = after.json?.prompts?.find((p: any) => p.key === 'persona.chat')
  check('override live in overview', entry?.source === 'override' && entry?.text?.includes(`${marker}-two`))

  const versions = await api('GET', '/api/system/prompts/persona.chat/versions')
  check('history lists both versions', versions.status === 200
    && versions.json?.[0]?.version_no === v2.json?.version
    && versions.json?.some((r: any) => r.body.includes(`${marker}-one`)))

  const rb = await api('POST', '/api/system/prompts/persona.chat/rollback', { version: v1.json?.version })
  const afterRb = await api('GET', '/api/system/overview')
  const rbEntry = afterRb.json?.prompts?.find((p: any) => p.key === 'persona.chat')
  check('rollback restores v1', rb.status === 200 && rbEntry?.text?.includes(`${marker}-one`))

  const reset = await api('DELETE', '/api/system/prompts/persona.chat')
  const afterReset = await api('GET', '/api/system/overview')
  const resetEntry = afterReset.json?.prompts?.find((p: any) => p.key === 'persona.chat')
  check('reset returns to default', reset.status === 200 && resetEntry?.source === 'default')

  const off = await api('POST', '/api/system/tasks/heartbeat', { enabled: false })
  const midTasks = await api('GET', '/api/system/overview')
  const hb = midTasks.json?.tasks?.find((t: any) => t.name === 'heartbeat')
  const on = await api('POST', '/api/system/tasks/heartbeat', { enabled: true })
  check('task toggle round-trip', off.status === 200 && hb?.enabled === false && on.status === 200)

  const badKey = await api('POST', '/api/system/prompts/dream.extract', { body: 'nope' })
  check('read-only prompt rejected', badKey.status === 400)

  console.log(`\n── Phase 14 smoke: ${pass}/${pass + fail} ──`)
  process.exit(fail === 0 ? 0 : 1)
}

main().catch((e) => { console.error('SMOKE CRASH:', e instanceof Error ? e.message : String(e)); process.exit(1) })
