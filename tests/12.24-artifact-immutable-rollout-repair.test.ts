import { beforeAll, describe, expect, it } from 'vitest'
import { env } from 'cloudflare:test'
import { sealArtifactBytes, sha256Bytes } from '../src/services/artifact-intake/crypto'
import {
  immutableRolloutStatus,
  repairImmutableArtifactRollout,
} from '../src/services/artifact-intake/immutable-rollout'
import { IMMUTABLE_ROLLOUT_CATEGORY } from '../src/services/artifact-intake/immutable-rollout-digest'
import { managedArtifactR2Key } from '../src/services/artifact-intake/storage-keys'
import { getCanonicalMemoryStore } from '../src/services/canonical-postgres'

const TENANT = `immutable-rollout-${crypto.randomUUID()}`
const ids = {
  upload: crypto.randomUUID(), operation: crypto.randomUUID(), artifact: crypto.randomUUID(),
  capture: crypto.randomUUID(), document: crypto.randomUUID(), canonicalOperation: crypto.randomUUID(),
  finalization: crypto.randomUUID(),
}

async function key(): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', new Uint8Array(32).fill(41),
    { name: 'AES-GCM' }, false, ['encrypt', 'decrypt'])
}

beforeAll(async () => {
  const now = Date.now()
  await env.D1_US.prepare(
    `INSERT INTO tenants
     (id, created_at, updated_at, data_region, primary_channel, hindsight_tenant_id, ai_cost_reset_at)
     VALUES (?, ?, ?, 'us', 'sms', ?, ?)`,
  ).bind(TENANT, now, now, `retired-${TENANT}`, now).run()
  const plaintext = new TextEncoder().encode('immutable rollout exact-source fixture')
  const sealed = await sealArtifactBytes(plaintext, await key(), 'tmk')
  const originalKey = await managedArtifactR2Key(TENANT, ids.upload)
  await env.R2_ARTIFACTS.put(originalKey, sealed.envelope)
  await env.D1_US.prepare(
    `INSERT INTO artifact_intake_operations
     (id, tenant_id, upload_id, idempotency_hash, status, artifact_id, r2_key,
      byte_length, plaintext_sha256, ciphertext_sha256, encryption_family,
      canonical_capture_id, canonical_document_id, canonical_operation_id,
      created_at, updated_at, expires_at, finalization_id, ciphertext_byte_length)
     VALUES (?, ?, ?, ?, 'finalized', ?, ?, ?, ?, ?, 'tmk', ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(ids.operation, TENANT, ids.upload, await sha256Bytes(new TextEncoder().encode(ids.upload)),
    ids.artifact, originalKey, plaintext.byteLength, sealed.plaintextSha256,
    sealed.ciphertextSha256, ids.capture, ids.document, ids.canonicalOperation,
    now, now, now + 60_000, ids.finalization, sealed.envelope.byteLength).run()
  await env.D1_US.prepare(
    `INSERT INTO artifact_immutable_rollout_repairs
     (tenant_id, upload_id, operation_id, artifact_id, original_r2_key, byte_length,
      plaintext_sha256, ciphertext_sha256, ciphertext_byte_length, encryption_family,
      canonical_capture_id, canonical_document_id, canonical_operation_id, finalization_id,
      created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'tmk', ?, ?, ?, ?, ?, ?)`,
  ).bind(TENANT, ids.upload, ids.operation, ids.artifact, originalKey, plaintext.byteLength,
    sealed.plaintextSha256, sealed.ciphertextSha256, sealed.envelope.byteLength,
    ids.capture, ids.document, ids.canonicalOperation, ids.finalization, now, now).run()
  await getCanonicalMemoryStore(env).writeCapture({
    capture: {
      id: ids.capture, tenant_id: TENANT, source_system: 'file', source_ref: null,
      scope: 'general', title: 'Immutable rollout', body_r2_key: 'canonical/test/body.enc',
      body_sha256: 'b'.repeat(64), artifact_id: ids.artifact, captured_at: now, created_at: now,
      memory_class: 'episode', trust_state: 'evidence', use_policy: 'can_use_as_evidence',
      author_kind: 'external_client', agent_identity: 'Codex', model_runtime: null,
      confidence: null, retention: 'standard', provenance_note: null, memory_type: null,
      dedup_hash: null, salience_tier: null, governance_downgraded_json: null,
    },
    artifacts: [{
      id: ids.artifact, tenant_id: TENANT, capture_id: ids.capture, storage_kind: 'managed_r2',
      r2_key: originalKey, media_type: 'text/plain', filename: null, byte_length: plaintext.byteLength,
      sha256: sealed.plaintextSha256, cipher_sha256: sealed.ciphertextSha256,
      encryption_family: 'tmk', role: 'source', parent_artifact_id: null, ordinal: 0, created_at: now,
    }],
    document: {
      id: ids.document, tenant_id: TENANT, capture_id: ids.capture, artifact_id: ids.artifact,
      title: 'Immutable rollout', body_r2_key: 'canonical/test/body.enc', body_sha256: 'b'.repeat(64),
      chunk_count: 0, created_at: now,
    },
    chunks: [],
    operation: {
      id: ids.canonicalOperation, tenant_id: TENANT, capture_id: ids.capture,
      operation_type: 'capture.accepted', status: 'accepted', created_at: now, updated_at: now,
    },
    projectionJobs: [], event: null,
  })
})

describe('12.24 immutable rollout repair', () => {
  it('binds the exact digest, survives a Neon-to-D1 interruption, and retains the old object', async () => {
    const status = await immutableRolloutStatus(TENANT, env)
    expect(status).toMatchObject({
      target_count: 1, pending_count: 1, completed_count: 0, approved_count: 0,
    })
    await expect(repairImmutableArtifactRollout({
      tenantId: TENANT, category: IMMUTABLE_ROLLOUT_CATEGORY, expectedTargetCount: 1,
      approvalDigest: '0'.repeat(64), tmk: await key(),
    }, env)).rejects.toMatchObject({ code: 'invalid_state' })
    await expect(repairImmutableArtifactRollout({
      tenantId: TENANT, category: IMMUTABLE_ROLLOUT_CATEGORY, expectedTargetCount: 1,
      approvalDigest: status.exact_target_digest, tmk: await key(),
    }, env)).rejects.toMatchObject({ code: 'invalid_state' })
    await env.D1_US.prepare(
      `UPDATE artifact_immutable_rollout_repairs SET approval_digest = ?
       WHERE tenant_id = ? AND upload_id = ?`,
    ).bind(status.exact_target_digest, TENANT, ids.upload).run()

    await expect(repairImmutableArtifactRollout({
      tenantId: TENANT, category: IMMUTABLE_ROLLOUT_CATEGORY, expectedTargetCount: 1,
      approvalDigest: status.exact_target_digest, tmk: await key(),
    }, env, { afterCanonicalPromotion: async () => { throw new Error('injected interruption') } }))
      .rejects.toThrow('injected interruption')

    const originalKey = await managedArtifactR2Key(TENANT, ids.upload)
    expect(await env.R2_ARTIFACTS.head(originalKey)).not.toBeNull()
    const completed = await repairImmutableArtifactRollout({
      tenantId: TENANT, category: IMMUTABLE_ROLLOUT_CATEGORY, expectedTargetCount: 1,
      approvalDigest: status.exact_target_digest, tmk: await key(),
    }, env)
    expect(completed).toMatchObject({ pending_count: 0, completed_count: 1, approved_count: 1 })

    const row = await env.D1_US.prepare(
      `SELECT r2_key, adopted_attempt_token, upload_protocol, immutable_finalize_authorized
       FROM artifact_intake_operations WHERE tenant_id = ? AND upload_id = ?`,
    ).bind(TENANT, ids.upload).first<Record<string, unknown>>()
    expect(row).toMatchObject({ upload_protocol: 'fenced_v2', immutable_finalize_authorized: 1 })
    expect(row?.adopted_attempt_token).toBeTruthy()
    expect(row?.r2_key).not.toBe(originalKey)
    expect(await env.R2_ARTIFACTS.head(originalKey)).not.toBeNull()
    expect((await getCanonicalMemoryStore(env).getDocument(TENANT, ids.document))
      ?.artifact_manifest[0]?.r2_key).toBe(row?.r2_key)

    await env.D1_US.prepare(
      `UPDATE artifact_immutable_rollout_repairs SET approval_digest = ?
       WHERE tenant_id = ? AND upload_id = ?`,
    ).bind('f'.repeat(64), TENANT, ids.upload).run()
    await expect(repairImmutableArtifactRollout({
      tenantId: TENANT, category: IMMUTABLE_ROLLOUT_CATEGORY, expectedTargetCount: 1,
      approvalDigest: status.exact_target_digest, tmk: await key(),
    }, env)).rejects.toMatchObject({ code: 'invalid_state' })
    await env.D1_US.prepare(
      `UPDATE artifact_immutable_rollout_repairs SET approval_digest = ?
       WHERE tenant_id = ? AND upload_id = ?`,
    ).bind(status.exact_target_digest, TENANT, ids.upload).run()

    await expect(repairImmutableArtifactRollout({
      tenantId: TENANT, category: IMMUTABLE_ROLLOUT_CATEGORY, expectedTargetCount: 1,
      approvalDigest: status.exact_target_digest, tmk: await key(),
    }, env)).resolves.toMatchObject({ pending_count: 0, completed_count: 1 })
  })
})
