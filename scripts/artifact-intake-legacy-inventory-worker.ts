// Read-only remote-dev Worker for Session 5 inventory when Neon is reachable
// only through the production Hyperdrive binding. The response is aggregate.

import { createHash } from 'node:crypto'
import { Client } from 'pg'
import {
  classifyLegacyMediaInventory,
  exactManagedPrimarySourceReplacements,
  LEGACY_D1_CANONICAL_REFERENCES_SQL,
  LEGACY_MANAGED_REPLACEMENT_CANDIDATES_SQL,
  type LegacyCanonicalReference,
  type LegacyManagedReplacementQueryRow,
  type LegacyObjectInventoryInput,
} from '../src/services/artifact-intake/legacy-inventory'
import { buildLegacyRemediationPlan } from '../src/services/artifact-intake/legacy-remediation'

interface InventoryEnv {
  R2_ARTIFACTS: R2Bucket
  D1_US: D1Database
  HYPERDRIVE_CANONICAL: Hyperdrive
  PROOF_TOKEN: string
  HMAC_SECRET: string
  EXECUTOR_COMMIT: string
}

async function listObjects(env: InventoryEnv): Promise<LegacyObjectInventoryInput[]> {
  const output: LegacyObjectInventoryInput[] = []
  for (const [prefix, channel] of [['telegram-media/', 'telegram'], ['sendblue-media/', 'sendblue']] as const) {
    let cursor: string | undefined
    do {
      const page = await env.R2_ARTIFACTS.list({ prefix, cursor, limit: 1000 })
      for (const object of page.objects) {
        const body = await env.R2_ARTIFACTS.get(object.key)
        const bytes = body ? new Uint8Array(await body.arrayBuffer()) : null
        const first = bytes ? new TextDecoder().decode(bytes.slice(0, 5)) : ''
        const envelopeFamily = first.startsWith('TMK1:') ? 'tmk'
          : first.startsWith('KEK1:') ? 'kek'
            : body ? 'plaintext' : 'unknown'
        output.push({
          key: object.key, size: object.size, channel, envelopeFamily,
          etag: body?.etag ?? object.etag ?? null,
          version: body?.version ?? object.version ?? null,
          objectSha256: bytes ? createHash('sha256').update(bytes).digest('hex') : null,
        })
      }
      cursor = page.truncated ? page.cursor : undefined
    } while (cursor)
  }
  return output
}

async function d1References(env: InventoryEnv): Promise<LegacyCanonicalReference[]> {
  const result = await env.D1_US.prepare(
    LEGACY_D1_CANONICAL_REFERENCES_SQL,
  ).all<{ r2_key: string; tenant_id: string; capture_id: string; role: string | null }>()
  return result.results.map(row => ({
    key: row.r2_key, tenantId: row.tenant_id, captureId: row.capture_id, role: row.role,
  }))
}

export default {
  async fetch(request: Request, env: InventoryEnv): Promise<Response> {
    if (request.method !== 'GET' || request.headers.get('x-session-proof') !== env.PROOF_TOKEN) {
      return new Response('not_found', { status: 404 })
    }
    const client = new Client({ connectionString: env.HYPERDRIVE_CANONICAL.connectionString })
    await client.connect()
    try {
      await client.query('BEGIN READ ONLY')
      const [objects, d1, legacy, managed, documents] = await Promise.all([
        listObjects(env),
        d1References(env),
        client.query<{ r2_key: string; tenant_id: string; capture_id: string; role: string | null }>(
          `SELECT r2_key, tenant_id, capture_id, role FROM haetsal_canonical.canonical_artifacts
           WHERE r2_key LIKE 'telegram-media/%' OR r2_key LIKE 'sendblue-media/%'`,
        ),
        client.query<LegacyManagedReplacementQueryRow>(LEGACY_MANAGED_REPLACEMENT_CANDIDATES_SQL),
        client.query<{ id: string; body_sha256: string; chunk_count: number }>(
          `SELECT DISTINCT d.id, d.body_sha256, d.chunk_count
           FROM haetsal_canonical.canonical_documents d
           JOIN haetsal_canonical.canonical_artifacts a ON a.capture_id = d.capture_id
           WHERE a.r2_key LIKE 'telegram-media/%' OR a.r2_key LIKE 'sendblue-media/%'
           ORDER BY d.id`,
        ),
      ])
      const classification = classifyLegacyMediaInventory({
        objects,
        d1References: d1,
        neonReferences: legacy.rows.map(row => ({
          key: row.r2_key, tenantId: row.tenant_id, captureId: row.capture_id, role: row.role,
        })),
        managedPrimarySourceReplacements: exactManagedPrimarySourceReplacements(managed.rows),
      })
      const fingerprint = createHash('sha256').update(JSON.stringify(documents.rows)).digest('hex')
      const inventoryAt = new Date().toISOString()
      const plan = await buildLegacyRemediationPlan({
        report: classification.report,
        privateEntries: classification.privateEntries,
        canonicalContentFingerprintSha256: fingerprint,
        inventoryAt,
        executorCommit: env.EXECUTOR_COMMIT,
        approvalHmacSecret: env.HMAC_SECRET,
      })
      await client.query('ROLLBACK')
      return Response.json({
        mode: 'read_only', generatedAt: inventoryAt, ...classification.report,
        canonicalContent: { documentCount: documents.rowCount ?? documents.rows.length, fingerprintSha256: fingerprint },
        remediationApproval: plan,
      })
    } catch {
      await client.query('ROLLBACK').catch(() => undefined)
      return Response.json({ error: 'inventory_failed' }, { status: 500 })
    } finally {
      await client.end()
    }
  },
}
