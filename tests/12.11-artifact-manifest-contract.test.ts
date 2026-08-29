import { describe, expect, it } from 'vitest'
import { env } from 'cloudflare:test'
import { ARTIFACT_INTAKE_ERROR } from '../src/services/artifact-intake/contracts'
import { finalizeArtifactCaptureSchema } from '../src/services/artifact-intake/schemas'
import { finalizeArtifactCapture } from '../src/services/artifact-intake/finalize'
import type { FinalizeArtifactCaptureInput } from '../src/types/artifact-intake'

const SUITE_ID = crypto.randomUUID()
const TENANT = `test-tenant-manifest-contract-${SUITE_ID}`

interface Entry {
  upload_id: string
  tenant_id?: string
  role: 'source' | 'derivative'
  parent_upload_id?: string
  primary: boolean
  byte_length?: number
}

function parseManifest(artifacts: Entry[], declared?: string[]) {
  return finalizeArtifactCaptureSchema.safeParse({
    tenant_id: TENANT,
    searchable_content: 'extraction',
    declared_derivative_upload_ids: declared ??
      artifacts.filter((entry) => entry.role === 'derivative').map((entry) => entry.upload_id),
    artifacts: artifacts.map((entry) => ({
      upload_id: entry.upload_id,
      tenant_id: entry.tenant_id ?? TENANT,
      role: entry.role,
      parent_upload_id: entry.parent_upload_id,
      primary: entry.primary,
      byte_length: entry.byte_length ?? 1,
    })),
  })
}

function invalidManifest(artifacts: Entry[], declared?: string[]): boolean {
  const result = parseManifest(artifacts, declared)
  if (result.success) return false
  return result.error.issues.some((issue) => issue.message === ARTIFACT_INTAKE_ERROR.INVALID_MANIFEST)
}

describe('12.11 one shared artifact manifest contract', () => {
  it('accepts a valid source plus derivative chain', () => {
    expect(parseManifest([
      { upload_id: 'u-source', role: 'source', primary: true },
      { upload_id: 'u-d1', role: 'derivative', parent_upload_id: 'u-source', primary: false },
      { upload_id: 'u-d2', role: 'derivative', parent_upload_id: 'u-d1', primary: false },
    ]).success).toBe(true)
  })

  it('rejects a derivative-only manifest', () => {
    expect(invalidManifest([
      { upload_id: 'u-d1', role: 'derivative', parent_upload_id: 'u-d0', primary: true },
    ])).toBe(true)
  })

  it('rejects a parentless first derivative even when a source follows', () => {
    expect(invalidManifest([
      { upload_id: 'u-d1', role: 'derivative', primary: false },
      { upload_id: 'u-source', role: 'source', primary: true },
    ])).toBe(true)
  })

  it('rejects a derivative marked primary', () => {
    expect(invalidManifest([
      { upload_id: 'u-source', role: 'source', primary: false },
      { upload_id: 'u-d1', role: 'derivative', parent_upload_id: 'u-source', primary: true },
    ])).toBe(true)
  })

  it('rejects a source that is not primary', () => {
    expect(invalidManifest([
      { upload_id: 'u-source', role: 'source', primary: false },
      { upload_id: 'u-d1', role: 'derivative', parent_upload_id: 'u-source', primary: false },
    ])).toBe(true)
  })

  it('rejects a source that is not the first manifest entry', () => {
    expect(invalidManifest([
      { upload_id: 'u-d1', role: 'derivative', parent_upload_id: 'u-source', primary: false },
      { upload_id: 'u-source', role: 'source', primary: true },
    ])).toBe(true)
  })

  it('rejects a derivative whose parent is missing from the manifest', () => {
    expect(invalidManifest([
      { upload_id: 'u-source', role: 'source', primary: true },
      { upload_id: 'u-d1', role: 'derivative', parent_upload_id: 'u-absent', primary: false },
    ])).toBe(true)
  })

  it('rejects forward parent references and self-parenting', () => {
    expect(invalidManifest([
      { upload_id: 'u-source', role: 'source', primary: true },
      { upload_id: 'u-d1', role: 'derivative', parent_upload_id: 'u-d2', primary: false },
      { upload_id: 'u-d2', role: 'derivative', parent_upload_id: 'u-source', primary: false },
    ])).toBe(true)
    expect(invalidManifest([
      { upload_id: 'u-source', role: 'source', primary: true },
      { upload_id: 'u-d1', role: 'derivative', parent_upload_id: 'u-d1', primary: false },
    ])).toBe(true)
  })

  it('rejects duplicate sources and multiple primary artifacts', () => {
    expect(invalidManifest([
      { upload_id: 'u-source-1', role: 'source', primary: true },
      { upload_id: 'u-source-2', role: 'source', primary: false },
    ])).toBe(true)
    expect(invalidManifest([
      { upload_id: 'u-source', role: 'source', primary: true },
      { upload_id: 'u-d1', role: 'derivative', parent_upload_id: 'u-source', primary: true },
    ])).toBe(true)
  })

  it('rejects a source carrying a parent upload id', () => {
    expect(invalidManifest([
      { upload_id: 'u-source', role: 'source', parent_upload_id: 'u-source', primary: true },
    ])).toBe(true)
  })

  it('rejects a malformed manifest before creating any persistent finalization', async () => {
    const now = Date.now()
    await env.D1_US.prepare(
      `INSERT OR IGNORE INTO tenants
       (id, created_at, updated_at, data_region, primary_channel, hindsight_tenant_id, ai_cost_reset_at)
       VALUES (?, ?, ?, 'us', 'sms', ?, ?)`,
    ).bind(TENANT, now, now, `hindsight-${TENANT}`, now).run()
    const key = await crypto.subtle.importKey(
      'raw', new TextEncoder().encode('session-two-artifact-test-key!!!'),
      { name: 'AES-GCM' }, false, ['encrypt', 'decrypt'],
    )
    const input: FinalizeArtifactCaptureInput = {
      tenantId: TENANT,
      content: 'derivative only rejection',
      scope: 'research',
      clientName: 'Codex',
      idempotencyKey: `manifest-contract-reject-${SUITE_ID}`,
      declaredDerivativeUploadIds: ['0f0e0d0c-0b0a-4990-8807-060504030201'],
      artifacts: [{
        uploadId: '0f0e0d0c-0b0a-4990-8807-060504030201',
        role: 'derivative', primary: true, detectedMimeType: 'text/plain',
        byteLength: 4, plaintextSha256: 'a'.repeat(64),
      }],
    }
    await expect(finalizeArtifactCapture(input, key, env))
      .rejects.toMatchObject({ code: ARTIFACT_INTAKE_ERROR.INVALID_MANIFEST })
    const persisted = await env.D1_US.prepare(
      `SELECT COUNT(*) AS count FROM artifact_intake_finalizations WHERE tenant_id = ?`,
    ).bind(TENANT).first<{ count: number }>()
    expect(Number(persisted?.count ?? 0)).toBe(0)
  })
})
