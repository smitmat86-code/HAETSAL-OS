import { afterEach, describe, expect, it, vi } from 'vitest'
import { env } from 'cloudflare:test'
import {
  ARTIFACT_MANIFEST_MAX_COUNT,
  ARTIFACT_MAX_BYTES,
  ARTIFACT_MAX_CIPHERTEXT_BYTES,
} from '../src/services/artifact-intake/config'
import type { ArtifactFinalizationRow } from '../src/services/artifact-intake/finalize'
import { proveArtifactFinalizationCanonicalSuccess } from '../src/services/artifact-intake/finalization-proof'
import type { ArtifactIntakeOperationRow } from '../src/services/artifact-intake/operations'
import { recoverOrFailStaleArtifactFinalizations } from '../src/services/artifact-intake/stale-finalization-recovery'
import type { Env } from '../src/types/env'

const SUITE_ID = crypto.randomUUID()
const TENANT = `test-tenant-bounded-recovery-${SUITE_ID}`

async function ensureTenant(): Promise<void> {
  const now = Date.now()
  await env.D1_US.prepare(
    `INSERT OR IGNORE INTO tenants
     (id, created_at, updated_at, data_region, primary_channel, hindsight_tenant_id, ai_cost_reset_at)
     VALUES (?, ?, ?, 'us', 'sms', ?, ?)`,
  ).bind(TENANT, now, now, `hindsight-${TENANT}`, now).run()
}

async function insertStaleFinalization(expectedOperationCount: number): Promise<string> {
  await ensureTenant()
  const finalizationId = crypto.randomUUID()
  const now = Date.now()
  await env.D1_US.prepare(
    `INSERT INTO artifact_intake_finalizations
     (id, tenant_id, idempotency_hash, manifest_sha256, status, error_code,
      canonical_capture_id, canonical_document_id, canonical_operation_id,
      created_at, updated_at, expected_operation_count, artifact_manifest_sha256,
      recovery_expires_at)
     VALUES (?, ?, ?, ?, 'reserved', NULL, ?, ?, ?, ?, ?, ?, ?, 1)`,
  ).bind(
    finalizationId, TENANT, crypto.randomUUID(), crypto.randomUUID(),
    crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID(),
    now, now, expectedOperationCount, 'a'.repeat(64),
  ).run()
  return finalizationId
}

async function insertBoundOperation(finalizationId: string, ordinal: number): Promise<string> {
  const uploadId = crypto.randomUUID()
  const now = Date.now()
  await env.D1_US.prepare(
    `INSERT INTO artifact_intake_operations
     (id, tenant_id, upload_id, idempotency_hash, status, error_code, artifact_id, r2_key,
      byte_length, plaintext_sha256, ciphertext_sha256, ciphertext_byte_length,
      encryption_family, finalization_id, created_at, updated_at, expires_at)
     VALUES (?, ?, ?, ?, 'sealed', NULL, ?, ?, 4, ?, ?, 37, 'tmk', ?, ?, ?, ?)`,
  ).bind(
    crypto.randomUUID(), TENANT, uploadId, `${finalizationId}-${ordinal}`,
    crypto.randomUUID(), `bounded-test/${uploadId}.enc`,
    'b'.repeat(64), 'c'.repeat(64), finalizationId, now, now, now + 60_000,
  ).run()
  return uploadId
}

async function finalizationState(finalizationId: string) {
  return env.D1_US.prepare(
    `SELECT status,
       (SELECT COUNT(*) FROM artifact_intake_operations o
        WHERE o.tenant_id = ? AND o.finalization_id = ?) AS bound_count
     FROM artifact_intake_finalizations WHERE tenant_id = ? AND id = ?`,
  ).bind(TENANT, finalizationId, TENANT, finalizationId)
    .first<{ status: string; bound_count: number }>()
}

function operationRow(overrides: Partial<ArtifactIntakeOperationRow>): ArtifactIntakeOperationRow {
  return {
    id: crypto.randomUUID(), tenant_id: TENANT, upload_id: crypto.randomUUID(),
    idempotency_hash: crypto.randomUUID(), status: 'sealed', error_code: null,
    artifact_id: crypto.randomUUID(), r2_key: 'bounded/row.enc',
    declared_mime_category: null, detected_mime_category: 'text',
    byte_length: 4, plaintext_sha256: 'b'.repeat(64), ciphertext_sha256: 'c'.repeat(64),
    ciphertext_byte_length: 37, encryption_family: 'tmk',
    finalization_id: 'finalization-id', finalization_protected_until: null,
    expiry_claim_token: null, expiry_claim_expires_at: null,
    upload_attempt_token: null, upload_attempt_expires_at: null, adopted_attempt_token: null,
    canonical_capture_id: 'capture-id', canonical_document_id: 'document-id',
    canonical_operation_id: 'operation-id',
    created_at: 1, updated_at: 1, expires_at: Date.now() + 60_000,
    ...overrides,
  }
}

function finalizationRow(expectedCount: number): ArtifactFinalizationRow {
  return {
    id: 'finalization-id', tenant_id: TENANT, idempotency_hash: 'hash',
    manifest_sha256: 'm'.repeat(64), artifact_manifest_sha256: 'a'.repeat(64),
    status: 'reserved', error_code: null,
    canonical_capture_id: 'capture-id', canonical_document_id: 'document-id',
    canonical_operation_id: 'operation-id', expected_operation_count: expectedCount,
    lease_owner: null, lease_expires_at: null, recovery_expires_at: null,
    created_at: 1, updated_at: 1,
  }
}

function countingEnv(): { env: Env; reads: () => number } {
  let reads = 0
  const r2 = new Proxy(env.R2_ARTIFACTS, {
    get(target, property) {
      if (property === 'get' || property === 'head') {
        return async (...getArgs: unknown[]) => {
          reads += 1
          return (Reflect.get(target, property) as (...a: unknown[]) => unknown)
            .apply(target, getArgs)
        }
      }
      const value = Reflect.get(target, property)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
  return {
    env: new Proxy(env as Env, {
      get: (target, property) =>
        property === 'R2_ARTIFACTS' ? r2 : Reflect.get(target, property),
    }),
    reads: () => reads,
  }
}

afterEach(() => vi.restoreAllMocks())

describe('12.14 bounded artifact recovery over persisted state', () => {
  it('protects a stale finalization whose stored operations exceed the manifest bound', async () => {
    const finalizationId = await insertStaleFinalization(9)
    for (let ordinal = 0; ordinal < 9; ordinal += 1) {
      await insertBoundOperation(finalizationId, ordinal)
    }
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const result = await recoverOrFailStaleArtifactFinalizations(env, Date.now(), 100)
    expect(result.integrityIncidents).toBeGreaterThanOrEqual(1)
    expect(result.failed).toBe(0)
    // Preserved for review: still reserved, every binding intact.
    expect(await finalizationState(finalizationId)).toMatchObject({
      status: 'reserved', bound_count: 9,
    })
    const logged = consoleError.mock.calls.find(call => call[0] === 'ARTIFACT_INTEGRITY_INCIDENT')
    expect(logged?.[1]).toEqual({ reason: 'bounds_exceeded', finalizationId })
  })

  it('protects a false low expected count with extra bound rows', async () => {
    const finalizationId = await insertStaleFinalization(1)
    await insertBoundOperation(finalizationId, 0)
    await insertBoundOperation(finalizationId, 1)
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const result = await recoverOrFailStaleArtifactFinalizations(env, Date.now(), 100)
    expect(result.integrityIncidents).toBeGreaterThanOrEqual(1)
    expect(result.failed).toBe(0)
    expect(await finalizationState(finalizationId)).toMatchObject({
      status: 'reserved', bound_count: 2,
    })
  })

  it('rejects an oversized recorded per-object ciphertext without any R2 read', async () => {
    const counting = countingEnv()
    const proof = await proveArtifactFinalizationCanonicalSuccess({
      finalization: finalizationRow(1),
      operations: [operationRow({ ciphertext_byte_length: ARTIFACT_MAX_CIPHERTEXT_BYTES + 1 })],
      env: counting.env,
    })
    expect(proof).toEqual({ status: 'indeterminate', reason: 'bounds_exceeded' })
    expect(counting.reads()).toBe(0)
  })

  it('rejects an excessive recorded aggregate without any R2 read', async () => {
    const counting = countingEnv()
    const oversizedEach = Math.floor(ARTIFACT_MAX_BYTES * 0.9)
    const operations = Array.from(
      { length: ARTIFACT_MANIFEST_MAX_COUNT },
      () => operationRow({ byte_length: oversizedEach, ciphertext_byte_length: oversizedEach + 33 }),
    )
    const proof = await proveArtifactFinalizationCanonicalSuccess({
      finalization: finalizationRow(ARTIFACT_MANIFEST_MAX_COUNT),
      operations, env: counting.env,
    })
    expect(proof).toEqual({ status: 'indeterminate', reason: 'bounds_exceeded' })
    expect(counting.reads()).toBe(0)
  })
})
