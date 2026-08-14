import { beforeAll, describe, expect, it, vi } from 'vitest'
import { env } from 'cloudflare:test'
import { finalizeArtifactCapture } from '../src/services/artifact-intake/finalize'
import {
  getArtifactIntakeOperation,
  getArtifactIntakeStatus,
  reserveArtifactUpload,
  uploadArtifactBytes,
} from '../src/services/artifact-intake/operations'
import { sha256Bytes } from '../src/services/artifact-intake/crypto'
import { getCanonicalMemoryStore } from '../src/services/canonical-postgres'
import { getCanonicalDocument } from '../src/services/canonical-memory-query'

const SUITE_ID = crypto.randomUUID()
const TENANT_A = `test-tenant-artifact-privacy-a-${SUITE_ID}`
const TENANT_B = `test-tenant-artifact-privacy-b-${SUITE_ID}`
const PRIVATE_FILENAME = 'board-acquisition-private.pdf'
const PRIVATE_URL = 'https://files.example.invalid/private-download-token'
const PRIVATE_CAPTION = 'caption that must never enter operational metadata'
const PRIVATE_EXTRACTION = 'confidential extraction marker session two privacy'
const PRIVATE_BODY = 'raw file body marker session two privacy'
let tenantADocumentId = ''

async function key(): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode('privacy-session-two-test-key!!!!'),
    { name: 'AES-GCM' },
    false,
    ['encrypt', 'decrypt'],
  )
}

async function ensureTenant(tenantId: string): Promise<void> {
  const now = Date.now()
  await env.D1_US.prepare(
    `INSERT OR IGNORE INTO tenants
     (id, created_at, updated_at, data_region, primary_channel, hindsight_tenant_id, ai_cost_reset_at)
     VALUES (?, ?, ?, 'us', 'sms', ?, ?)`,
  ).bind(tenantId, now, now, `hindsight-${tenantId}`, now).run()
}

beforeAll(async () => { await Promise.all([ensureTenant(TENANT_A), ensureTenant(TENANT_B)]) })

describe('12.4 artifact intake metadata minimization and tenant isolation', () => {
  it('keeps D1, queue calls, logs, and R2 free of raw recognizable content', async () => {
    const bytes = new TextEncoder().encode(PRIVATE_BODY)
    const plaintextSha256 = await sha256Bytes(bytes)
    const consoleCalls: unknown[][] = []
    const warn = vi.spyOn(console, 'warn').mockImplementation((...args) => { consoleCalls.push(args) })
    const log = vi.spyOn(console, 'log').mockImplementation((...args) => { consoleCalls.push(args) })
    const queue = vi.spyOn(env.QUEUE_BULK, 'send')
    const reserved = await reserveArtifactUpload({
      tenantId: TENANT_A,
      idempotencyKey: `privacy-upload-${SUITE_ID}`,
      byteLength: bytes.byteLength,
      plaintextSha256,
      declaredMimeType: 'application/pdf',
    }, env)
    await uploadArtifactBytes({
      tenantId: TENANT_A,
      uploadId: reserved.uploadId,
      bytes,
      declaredMimeType: 'application/pdf',
      detectedMimeType: 'application/pdf',
      encryptionFamily: 'tmk',
      key: await key(),
    }, env)
    const receipt = await finalizeArtifactCapture({
      tenantId: TENANT_A,
      content: PRIVATE_EXTRACTION,
      title: 'Privacy proof',
      scope: 'research',
      provenance: PRIVATE_CAPTION,
      clientName: 'Codex',
      sourceRef: 'privacy-source-ref',
      idempotencyKey: `privacy-finalize-${SUITE_ID}`,
      artifacts: [{
        uploadId: reserved.uploadId,
        role: 'source',
        primary: true,
        filename: PRIVATE_FILENAME,
        detectedMimeType: 'application/pdf',
        declaredMimeType: 'application/pdf',
        byteLength: bytes.byteLength,
        plaintextSha256,
        clientFileId: PRIVATE_URL,
      }],
    }, await key(), env)
    tenantADocumentId = receipt.documentId

    const operation = await getArtifactIntakeOperation(env, TENANT_A, reserved.uploadId)
    const d1Operation = await env.D1_US.prepare(
      `SELECT * FROM artifact_intake_operations WHERE tenant_id = ? AND upload_id = ?`,
    ).bind(TENANT_A, reserved.uploadId).first<Record<string, unknown>>()
    const d1Finalization = await env.D1_US.prepare(
      `SELECT * FROM artifact_intake_finalizations WHERE tenant_id = ? AND canonical_capture_id = ?`,
    ).bind(TENANT_A, receipt.captureId).first<Record<string, unknown>>()
    const operationalText = JSON.stringify([d1Operation, d1Finalization, consoleCalls, queue.mock.calls])
    for (const forbidden of [PRIVATE_FILENAME, PRIVATE_URL, PRIVATE_CAPTION, PRIVATE_EXTRACTION, PRIVATE_BODY]) {
      expect(operationalText).not.toContain(forbidden)
    }
    expect(queue).not.toHaveBeenCalled()
    const operationColumns = await env.D1_US.prepare(`PRAGMA table_info(artifact_intake_operations)`).all<{ name: string }>()
    expect(operationColumns.results.map((column: { name: string }) => column.name)).not.toEqual(expect.arrayContaining([
      'filename', 'url', 'caption', 'extraction', 'body', 'client_file_id',
    ]))
    const stored = await env.R2_ARTIFACTS.get(operation!.r2_key)
    const storedText = new TextDecoder().decode(await stored!.arrayBuffer())
    expect(storedText.startsWith('TMK1:')).toBe(true)
    expect(storedText).not.toContain(PRIVATE_BODY)
    warn.mockRestore()
    log.mockRestore()
  })

  it('returns the same non-enumerating failures for foreign and absent upload identifiers', async () => {
    const bytes = new TextEncoder().encode('tenant-a-owned-body')
    const plaintextSha256 = await sha256Bytes(bytes)
    const reserved = await reserveArtifactUpload({
      tenantId: TENANT_A,
      idempotencyKey: `tenant-a-isolation-${SUITE_ID}`,
      byteLength: bytes.byteLength,
      plaintextSha256,
      declaredMimeType: 'text/plain',
    }, env)
    await uploadArtifactBytes({
      tenantId: TENANT_A,
      uploadId: reserved.uploadId,
      bytes,
      declaredMimeType: 'text/plain',
      detectedMimeType: 'text/plain',
      encryptionFamily: 'tmk',
      key: await key(),
    }, env)

    const statusFailure = getArtifactIntakeStatus({ tenantId: TENANT_B, uploadId: reserved.uploadId }, env)
    const absentFailure = getArtifactIntakeStatus({ tenantId: TENANT_B, uploadId: crypto.randomUUID() }, env)
    await expect(statusFailure).rejects.toMatchObject({ code: 'not_found', message: 'not_found' })
    await expect(absentFailure).rejects.toMatchObject({ code: 'not_found', message: 'not_found' })

    const foreignFinalize = finalizeArtifactCapture({
      tenantId: TENANT_B,
      content: 'attacker extraction',
      scope: 'general',
      clientName: 'foreign-client',
      idempotencyKey: `foreign-finalize-${SUITE_ID}`,
      artifacts: [{
        uploadId: reserved.uploadId,
        role: 'source', primary: true, detectedMimeType: 'text/plain',
        byteLength: bytes.byteLength, plaintextSha256,
      }],
    }, await key(), env)
    await expect(foreignFinalize).rejects.toMatchObject({ code: 'not_found', message: 'not_found' })
    expect(await getCanonicalMemoryStore(env).getDocument(TENANT_B, tenantADocumentId)).toBeNull()
    await expect(getCanonicalDocument(
      { tenantId: TENANT_B, documentId: tenantADocumentId },
      env,
      TENANT_B,
      { tmk: await key() },
    )).rejects.toThrow('Canonical document not found')
  })
})
