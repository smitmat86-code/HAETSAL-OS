// Read-only Session 5 legacy Telegram/Sendblue media reconciliation.
// Prints aggregate counts, byte totals, and a canonical-content fingerprint;
// never prints an object key, tenant ID, capture ID, URL, filename, or content.

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import pg from 'pg'
import {
  classifyLegacyMediaObjects,
  type LegacyCanonicalReference,
  type LegacyObjectInventoryInput,
} from '../src/services/artifact-intake/legacy-inventory'

const ACCOUNT_ID = 'd3f0a1c579945862edc9c6f6e36e448a'
const D1_DATABASE_ID = 'b934a2d4-c429-4eea-9153-42a2796a9c63'
const BUCKET = 'brain-artifacts'
const API = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}`
let stage = 'startup'

function devVar(name: string): string {
  const line = readFileSync('.dev.vars', 'utf8').split(/\r?\n/)
    .find(item => item.trimStart().startsWith(`${name}=`))
  const value = line?.slice(line.indexOf('=') + 1).trim().replace(/^['"]|['"]$/g, '')
  if (!value) throw new Error(`missing_${name.toLowerCase()}`)
  return value
}

function token(): string {
  const value = process.env.CLOUDFLARE_API_TOKEN
  if (!value) throw new Error('missing_cloudflare_api_token')
  return value
}

async function cloudflare(path: string, init?: RequestInit): Promise<Record<string, unknown>> {
  const response = await fetch(`${API}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token()}`, 'Content-Type': 'application/json', ...init?.headers },
  })
  if (!response.ok) throw new Error(`cloudflare_read_failed_${response.status}`)
  return response.json() as Promise<Record<string, unknown>>
}

async function listPrefix(prefix: string): Promise<Array<{ key: string; size: number }>> {
  const objects: Array<{ key: string; size: number }> = []
  let cursor = ''
  do {
    const query = new URLSearchParams({ prefix, per_page: '1000' })
    if (cursor) query.set('cursor', cursor)
    const page = await cloudflare(`/r2/buckets/${BUCKET}/objects?${query}`)
    const result = Array.isArray(page.result) ? page.result as Array<Record<string, unknown>> : []
    for (const item of result) {
      if (typeof item.key === 'string' && typeof item.size === 'number') {
        objects.push({ key: item.key, size: item.size })
      }
    }
    const info = page.result_info as Record<string, unknown> | undefined
    cursor = typeof info?.cursor === 'string' ? info.cursor : ''
  } while (cursor)
  return objects
}

function objectPath(key: string): string {
  return key.split('/').map(encodeURIComponent).join('/')
}

async function envelopeFamily(key: string): Promise<'tmk' | 'kek' | 'plaintext' | 'unknown'> {
  const response = await fetch(`${API}/r2/buckets/${BUCKET}/objects/${objectPath(key)}`, {
    headers: { Authorization: `Bearer ${token()}`, Range: 'bytes=0-4' },
  })
  if (!response.ok && response.status !== 206) return 'unknown'
  const prefix = new TextDecoder().decode(await response.arrayBuffer())
  if (prefix.startsWith('TMK1:')) return 'tmk'
  if (prefix.startsWith('KEK1:')) return 'kek'
  return 'plaintext'
}

async function d1References(): Promise<LegacyCanonicalReference[]> {
  const result = await cloudflare(`/d1/database/${D1_DATABASE_ID}/query`, {
    method: 'POST',
    body: JSON.stringify({
      sql: `SELECT r2_key, tenant_id, capture_id FROM canonical_artifacts
            WHERE r2_key LIKE 'telegram-media/%' OR r2_key LIKE 'sendblue-media/%'`,
    }),
  })
  const blocks = Array.isArray(result.result) ? result.result as Array<Record<string, unknown>> : []
  const rows = Array.isArray(blocks[0]?.results) ? blocks[0]!.results as Array<Record<string, unknown>> : []
  return rows.flatMap(row => typeof row.r2_key === 'string' && typeof row.tenant_id === 'string' && typeof row.capture_id === 'string'
    ? [{ key: row.r2_key, tenantId: row.tenant_id, captureId: row.capture_id }]
    : [])
}

async function main(): Promise<void> {
  stage = 'r2_list'
  const [telegram, sendblue] = await Promise.all([listPrefix('telegram-media/'), listPrefix('sendblue-media/')])
  const rawObjects = [
    ...telegram.map(item => ({ ...item, channel: 'telegram' as const })),
    ...sendblue.map(item => ({ ...item, channel: 'sendblue' as const })),
  ]
  stage = 'r2_envelope_read'
  const objects: LegacyObjectInventoryInput[] = []
  for (const item of rawObjects) objects.push({ ...item, envelopeFamily: await envelopeFamily(item.key) })

  stage = 'neon_connect'
  const client = new pg.Client({ connectionString: devVar('CANONICAL_POSTGRES_CONNECTION_STRING') })
  await client.connect()
  try {
    stage = 'neon_query'
    await client.query('BEGIN READ ONLY')
    const legacy = await client.query<{
      r2_key: string; tenant_id: string; capture_id: string
    }>(`SELECT r2_key, tenant_id, capture_id FROM haetsal_canonical.canonical_artifacts
        WHERE r2_key LIKE 'telegram-media/%' OR r2_key LIKE 'sendblue-media/%'`)
    const managed = await client.query<{ capture_id: string }>(
      `SELECT DISTINCT capture_id FROM haetsal_canonical.canonical_artifacts
       WHERE storage_kind = 'managed_r2' AND r2_key LIKE 'artifact-intake/v1/%'`,
    )
    const documents = await client.query<{ id: string; body_sha256: string; chunk_count: number }>(
      `SELECT DISTINCT d.id, d.body_sha256, d.chunk_count
       FROM haetsal_canonical.canonical_documents d
       JOIN haetsal_canonical.canonical_artifacts a ON a.capture_id = d.capture_id
       WHERE a.r2_key LIKE 'telegram-media/%' OR a.r2_key LIKE 'sendblue-media/%'
       ORDER BY d.id`,
    )
    stage = 'd1_query'
    const report = classifyLegacyMediaObjects({
      objects,
      neonReferences: legacy.rows.map(row => ({ key: row.r2_key, tenantId: row.tenant_id, captureId: row.capture_id })),
      d1References: await d1References(),
      capturesWithManagedArtifact: new Set(managed.rows.map(row => row.capture_id)),
    })
    const canonicalContentFingerprint = createHash('sha256')
      .update(JSON.stringify(documents.rows)).digest('hex')
    stage = 'report'
    console.log(JSON.stringify({
      generatedAt: new Date().toISOString(),
      mode: 'read_only',
      ...report,
      canonicalContent: { documentCount: documents.rowCount ?? documents.rows.length, fingerprintSha256: canonicalContentFingerprint },
    }, null, 2))
    await client.query('ROLLBACK')
  } finally {
    await client.end()
  }
}

main().catch(error => {
  const code = error instanceof Error && /^[a-z0-9_]+$/i.test(error.message) ? error.message : `${stage}_failed`
  console.error(code)
  process.exitCode = 1
})
