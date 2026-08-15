import { beforeAll, describe, expect, it, vi } from 'vitest'
import { env } from 'cloudflare:test'
import { ArtifactIntakeContractError, ARTIFACT_INTAKE_ERROR } from '../src/services/artifact-intake/contracts'
import { unsealArtifactBytes } from '../src/services/artifact-intake/crypto'
import { channelMediaHandoffKey, readChannelMediaHandoff } from '../src/services/channel-media/handoff'
import {
  claimChannelMediaJob,
  getChannelMediaJob,
  reserveChannelMediaJob,
} from '../src/services/channel-media/jobs'
import {
  markChannelMediaFailed,
  markChannelMediaFinalized,
  markChannelMediaRetryable,
} from '../src/services/channel-media/job-transitions'
import { processChannelMediaJob } from '../src/services/channel-media/orchestrator'
import { prepareChannelMediaCapture } from '../src/services/channel-media/finalize-job'
import { reapExpiredChannelMediaJobs } from '../src/services/channel-media/reaper'
import { channelMediaRecoveryKey } from '../src/services/channel-media/recovery'
import { getArtifactIntakeOperation } from '../src/services/artifact-intake/operations'
import { getCanonicalMemoryStore, installCanonicalMemoryTestStore } from '../src/services/canonical-postgres'
import { getCanonicalDocument } from '../src/services/canonical-memory-query'
import type { Env } from '../src/types/env'
import type { ChannelMediaDescriptor } from '../src/types/channel-media'

const SUITE = crypto.randomUUID()
const TENANT_A = `test-channel-media-a-${SUITE}`
const TENANT_B = `test-channel-media-b-${SUITE}`
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46])

installCanonicalMemoryTestStore(env)

async function key(): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', crypto.getRandomValues(new Uint8Array(32)), { name: 'AES-GCM' }, false, ['encrypt', 'decrypt'])
}

async function ensureTenant(tenantId: string): Promise<void> {
  const now = Date.now()
  await env.D1_US.prepare(
    `INSERT OR IGNORE INTO tenants
     (id, created_at, updated_at, data_region, primary_channel, hindsight_tenant_id, ai_cost_reset_at)
     VALUES (?, ?, ?, 'us', 'sms', ?, ?)`,
  ).bind(tenantId, now, now, `hindsight-${tenantId}`, now).run()
}

function telegramDescriptor(marker: string): ChannelMediaDescriptor {
  return {
    version: 1,
    provider: 'telegram',
    locatorKind: 'telegram_file_id',
    locator: `provider-file-id-${marker}`,
    replyTarget: `provider-chat-${marker}`,
    caption: `private-caption-${marker}`,
    occurredAt: Date.now(),
  }
}

async function reserve(marker: string, kek: CryptoKey) {
  return reserveChannelMediaJob({
    tenantId: TENANT_A,
    provider: 'telegram',
    eventIdentity: `provider-event-${marker}`,
    descriptor: telegramDescriptor(marker),
    kek,
  }, env)
}

beforeAll(async () => Promise.all([ensureTenant(TENANT_A), ensureTenant(TENANT_B)]))

describe('12.8 governed common channel media intake', () => {
  it('deduplicates provider redelivery and keeps locator, target, and caption only in a KEK envelope', async () => {
    const kek = await key()
    const marker = `privacy-${SUITE}`
    const first = await reserve(marker, kek)
    const duplicate = await reserve(marker, kek)
    expect(duplicate.id).toBe(first.id)

    const rows = await env.D1_US.prepare(
      'SELECT * FROM channel_media_jobs WHERE tenant_id = ? AND id = ?',
    ).bind(TENANT_A, first.id).all<Record<string, unknown>>()
    expect(rows.results).toHaveLength(1)
    const operational = JSON.stringify(rows.results)
    for (const prohibited of [
      `provider-file-id-${marker}`, `provider-chat-${marker}`, `private-caption-${marker}`,
    ]) expect(operational).not.toContain(prohibited)

    const handoffKey = await channelMediaHandoffKey(TENANT_A, first.id)
    const handoff = await env.R2_ARTIFACTS.get(handoffKey)
    const ciphertext = new Uint8Array(await handoff!.arrayBuffer())
    expect(new TextDecoder().decode(ciphertext).startsWith('KEK1:')).toBe(true)
    expect(new TextDecoder().decode(ciphertext)).not.toContain(marker)
    const plaintext = await unsealArtifactBytes(ciphertext, kek, 'kek')
    expect(JSON.parse(new TextDecoder().decode(plaintext))).toMatchObject({ provider: 'telegram' })
  })

  it('rejects oversized provider locators, reply targets, captions, and encrypted descriptors', async () => {
    const kek = await key()
    for (const descriptor of [
      { ...telegramDescriptor('limits'), locator: 'x'.repeat(513) },
      { ...telegramDescriptor('limits'), replyTarget: 'x'.repeat(129) },
      { ...telegramDescriptor('limits'), caption: 'x'.repeat(4097) },
      { ...telegramDescriptor('limits'), caption: '😀'.repeat(2048) },
    ]) {
      await expect(reserveChannelMediaJob({
        tenantId: TENANT_A, provider: 'telegram', eventIdentity: crypto.randomUUID(), descriptor, kek,
      }, env)).rejects.toMatchObject({ code: ARTIFACT_INTAKE_ERROR.PROVIDER_LOCATOR_INVALID })
    }
  })

  it('rejects oversized extraction before reserving an artifact upload', async () => {
    const kek = await key()
    const tmk = await key()
    const reserved = await reserve(`description-limit-${SUITE}`, kek)
    const job = await claimChannelMediaJob(TENANT_A, reserved.id, env)
    const before = await env.D1_US.prepare(
      'SELECT COUNT(*) AS count FROM artifact_intake_operations WHERE tenant_id = ?',
    ).bind(TENANT_A).first<{ count: number }>()
    await expect(prepareChannelMediaCapture({
      job: job!, acquired: { bytes: JPEG, detectedMimeType: 'image/jpeg' },
      description: 'x'.repeat(8193), tmk, env,
    })).rejects.toMatchObject({ code: ARTIFACT_INTAKE_ERROR.INVALID_STATE })
    const after = await env.D1_US.prepare(
      'SELECT COUNT(*) AS count FROM artifact_intake_operations WHERE tenant_id = ?',
    ).bind(TENANT_A).first<{ count: number }>()
    expect(Number(after?.count)).toBe(Number(before?.count))
    await markChannelMediaRetryable(
      TENANT_A, reserved.id, job!.leaseToken!, ARTIFACT_INTAKE_ERROR.INVALID_STATE, env,
    )
  })

  it('TMK-seals one original, finalizes one Telegram capture, verifies it, and replies exactly once', async () => {
    const kek = await key()
    const tmk = await key()
    const marker = `e2e-${SUITE}`
    const job = await reserve(marker, kek)
    const deliveries: string[] = []
    const dependencies = {
      acquire: async () => ({ bytes: JPEG, detectedMimeType: 'image/jpeg' }),
      describe: async () => `searchable-description-${marker}`,
      deliver: async (_descriptor: ChannelMediaDescriptor, message: string) => {
        deliveries.push(message)
        return 'delivered' as const
      },
    }
    expect(await processChannelMediaJob({ tenantId: TENANT_A, operationId: job.id, tmk, kek, env, dependencies }))
      .toBe('processed')
    expect(await processChannelMediaJob({ tenantId: TENANT_A, operationId: job.id, tmk, kek, env, dependencies }))
      .toBe('ignored')
    expect(deliveries).toEqual(['Captured that photo.'])

    const completed = await getChannelMediaJob(TENANT_A, job.id, env)
    expect(completed).toMatchObject({ status: 'delivered', deliveryStatus: 'delivered' })
    await expect(markChannelMediaFailed(
      TENANT_A, job.id, crypto.randomUUID(), 'invalid_state', env,
    )).rejects.toMatchObject({ code: ARTIFACT_INTAKE_ERROR.LEASE_LOST })
    expect(await getChannelMediaJob(TENANT_A, job.id, env)).toMatchObject({
      status: 'delivered', deliveryStatus: 'delivered', errorCode: null,
    })
    const operation = await getArtifactIntakeOperation(env, TENANT_A, completed!.artifactUploadId!)
    expect(operation?.status).toBe('finalized')
    expect(operation?.encryption_family).toBe('tmk')
    const stored = await env.R2_ARTIFACTS.get(operation!.r2_key)
    const ciphertext = new Uint8Array(await stored!.arrayBuffer())
    expect(new TextDecoder().decode(ciphertext).startsWith('TMK1:')).toBe(true)
    expect(ciphertext).not.toEqual(JPEG)
    expect(await unsealArtifactBytes(ciphertext, tmk, 'tmk')).toEqual(JPEG)

    const store = getCanonicalMemoryStore(env)
    const capture = await store.getCapture(TENANT_A, completed!.canonicalCaptureId!)
    const document = await store.getDocument(TENANT_A, completed!.canonicalDocumentId!)
    expect(capture).toMatchObject({
      source_system: 'telegram', author_kind: 'user', agent_identity: 'telegram-provider',
      provenance_note: 'telegram_photo',
    })
    const readable = await getCanonicalDocument(
      { tenantId: TENANT_A, documentId: completed!.canonicalDocumentId! },
      env, TENANT_A, { tmk },
    )
    expect(readable.body).toContain(`searchable-description-${marker}`)
    expect(document?.artifact_manifest).toHaveLength(1)
    expect(document?.artifact_manifest[0]).toMatchObject({ role: 'source', primary: true })
    expect(await env.R2_ARTIFACTS.get(await channelMediaHandoffKey(TENANT_A, job.id))).toBeNull()
    const duplicateAfterDelivery = await reserve(marker, kek)
    expect(duplicateAfterDelivery.id).toBe(job.id)
    expect(duplicateAfterDelivery.handoffStatus).toBe('deleted')
    expect(await env.R2_ARTIFACTS.get(await channelMediaHandoffKey(TENANT_A, job.id))).toBeNull()
  })

  it('retries safely before finalization without duplicating artifact, capture, or acknowledgement', async () => {
    const kek = await key()
    const tmk = await key()
    const job = await reserve(`retry-${SUITE}`, kek)
    let acquisitions = 0
    let deliveries = 0
    const dependencies = {
      acquire: async () => {
        acquisitions += 1
        if (acquisitions === 1) throw new ArtifactIntakeContractError(ARTIFACT_INTAKE_ERROR.DOWNLOAD_UNAVAILABLE)
        return { bytes: JPEG, detectedMimeType: 'image/jpeg' }
      },
      describe: async () => 'retry description',
      deliver: async () => { deliveries += 1; return 'delivered' as const },
    }
    await expect(processChannelMediaJob({ tenantId: TENANT_A, operationId: job.id, tmk, kek, env, dependencies }))
      .rejects.toMatchObject({ code: ARTIFACT_INTAKE_ERROR.DOWNLOAD_UNAVAILABLE })
    expect((await getChannelMediaJob(TENANT_A, job.id, env))?.status).toBe('retryable')
    await processChannelMediaJob({ tenantId: TENANT_A, operationId: job.id, tmk, kek, env, dependencies })
    expect(deliveries).toBe(1)
    const completed = await getChannelMediaJob(TENANT_A, job.id, env)
    const artifacts = await env.D1_US.prepare(
      'SELECT id FROM artifact_intake_operations WHERE tenant_id = ? AND canonical_capture_id = ?',
    ).bind(TENANT_A, completed!.canonicalCaptureId).all()
    expect(artifacts.results).toHaveLength(1)
  })

  it('recovers immediately after canonical finalization without rerunning vision or changing the manifest', async () => {
    const kek = await key()
    const tmk = await key()
    const job = await reserve(`post-canonical-${SUITE}`, kek)
    const describe = vi.fn(async () => `stable-extraction-${SUITE}`)
    const deliver = vi.fn(async () => 'delivered' as const)
    let injected = false
    let recoveryCiphertext = ''
    const outcome = await processChannelMediaJob({
      tenantId: TENANT_A, operationId: job.id, tmk, kek, env,
      dependencies: {
        acquire: async () => ({ bytes: JPEG, detectedMimeType: 'image/jpeg' }),
        describe,
        deliver,
        afterCanonicalFinalization: async () => {
          if (!injected) {
            injected = true
            const recovery = await env.R2_ARTIFACTS.get(await channelMediaRecoveryKey(TENANT_A, job.id))
            recoveryCiphertext = new TextDecoder().decode(await recovery!.arrayBuffer())
            throw new Error('injected_after_canonical_finalization')
          }
        },
      },
    })
    expect(outcome).toBe('processed')
    expect(describe).toHaveBeenCalledTimes(1)
    expect(deliver).toHaveBeenCalledTimes(1)
    expect(recoveryCiphertext.startsWith('TMK1:')).toBe(true)
    expect(recoveryCiphertext).not.toContain(`stable-extraction-${SUITE}`)
    const completed = await getChannelMediaJob(TENANT_A, job.id, env)
    expect(completed).toMatchObject({ status: 'delivered', deliveryStatus: 'delivered' })
    const finalizations = await env.D1_US.prepare(
      `SELECT manifest_sha256, status FROM artifact_intake_finalizations
       WHERE tenant_id = ? AND canonical_capture_id = ?`,
    ).bind(TENANT_A, completed!.canonicalCaptureId).all<{ manifest_sha256: string; status: string }>()
    expect(finalizations.results).toHaveLength(1)
    expect(finalizations.results[0]).toMatchObject({ status: 'finalized' })
    const d1State = await env.D1_US.prepare(
      'SELECT * FROM channel_media_jobs WHERE tenant_id = ? AND id = ?',
    ).bind(TENANT_A, job.id).all<Record<string, unknown>>()
    expect(JSON.stringify(d1State.results)).not.toContain(`stable-extraction-${SUITE}`)
    expect(await processChannelMediaJob({
      tenantId: TENANT_A, operationId: job.id, tmk, kek, env,
      dependencies: {
        acquire: async () => { throw new Error('must_not_refetch') },
        describe: async () => { throw new Error('must_not_redescribe') },
        deliver,
      },
    })).toBe('ignored')
    expect((await env.D1_US.prepare(
      'SELECT manifest_sha256 FROM artifact_intake_finalizations WHERE tenant_id = ? AND canonical_capture_id = ?',
    ).bind(TENANT_A, completed!.canonicalCaptureId).first<{ manifest_sha256: string }>())?.manifest_sha256)
      .toBe(finalizations.results[0]!.manifest_sha256)
  })

  it('rejects every stale-worker processing transition with an exact lease CAS', async () => {
    const kek = await key()
    const job = await reserve(`stale-lease-${SUITE}`, kek)
    const first = await claimChannelMediaJob(TENANT_A, job.id, env)
    expect(first?.leaseToken).toBeTruthy()
    await env.D1_US.prepare(
      'UPDATE channel_media_jobs SET lease_expires_at = ? WHERE tenant_id = ? AND id = ?',
    ).bind(Date.now() - 1, TENANT_A, job.id).run()
    const second = await claimChannelMediaJob(TENANT_A, job.id, env)
    expect(second?.leaseToken).toBeTruthy()
    expect(second!.leaseToken).not.toBe(first!.leaseToken)

    await expect(markChannelMediaRetryable(
      TENANT_A, job.id, first!.leaseToken!, 'download_unavailable', env,
    )).rejects.toMatchObject({ code: ARTIFACT_INTAKE_ERROR.LEASE_LOST })
    await expect(markChannelMediaFailed(
      TENANT_A, job.id, first!.leaseToken!, 'invalid_state', env,
    )).rejects.toMatchObject({ code: ARTIFACT_INTAKE_ERROR.LEASE_LOST })
    await expect(markChannelMediaFinalized({
      tenantId: TENANT_A, operationId: job.id, leaseToken: first!.leaseToken!,
      uploadId: crypto.randomUUID(), captureId: crypto.randomUUID(),
      documentId: crypto.randomUUID(), canonicalOperationId: crypto.randomUUID(),
    }, env)).rejects.toMatchObject({ code: ARTIFACT_INTAKE_ERROR.LEASE_LOST })
    expect(await getChannelMediaJob(TENANT_A, job.id, env)).toMatchObject({
      status: 'processing', leaseToken: second!.leaseToken,
    })
    await markChannelMediaRetryable(
      TENANT_A, job.id, second!.leaseToken!, 'download_unavailable', env,
    )
  })

  it('never repeats an acknowledgement after an ambiguous provider delivery result', async () => {
    const kek = await key()
    const tmk = await key()
    const job = await reserve(`delivery-unknown-${SUITE}`, kek)
    const deliver = vi.fn(async () => 'unknown' as const)
    const dependencies = {
      acquire: async () => ({ bytes: JPEG, detectedMimeType: 'image/jpeg' }),
      describe: async () => 'ambiguous delivery description',
      deliver,
    }
    await processChannelMediaJob({ tenantId: TENANT_A, operationId: job.id, tmk, kek, env, dependencies })
    await processChannelMediaJob({ tenantId: TENANT_A, operationId: job.id, tmk, kek, env, dependencies })
    expect(deliver).toHaveBeenCalledTimes(1)
    expect(await getChannelMediaJob(TENANT_A, job.id, env)).toMatchObject({
      status: 'delivery_unknown', deliveryStatus: 'unknown', errorCode: 'delivery_unknown',
    })
  })

  it('turns permanent validation failure into one truthful failure reply and no captured artifact', async () => {
    const kek = await key()
    const tmk = await key()
    const job = await reserve(`permanent-${SUITE}`, kek)
    const messages: string[] = []
    const outcome = await processChannelMediaJob({
      tenantId: TENANT_A, operationId: job.id, tmk, kek, env,
      dependencies: {
        acquire: async () => { throw new ArtifactIntakeContractError(ARTIFACT_INTAKE_ERROR.MIME_MISMATCH) },
        deliver: async (_descriptor, message) => { messages.push(message); return 'delivered' },
      },
    })
    expect(outcome).toBe('terminal_failed')
    expect(messages).toEqual(['I could not capture that photo. Please try sending it again.'])
    expect(messages[0]).not.toContain('Captured')
    expect(await getChannelMediaJob(TENANT_A, job.id, env)).toMatchObject({
      status: 'failed', deliveryStatus: 'delivered', errorCode: 'mime_mismatch',
    })
    expect((await getChannelMediaJob(TENANT_A, job.id, env))?.artifactUploadId).toBeNull()
  })

  it('fails closed for cross-tenant operation substitution and a wrong handoff key', async () => {
    const kek = await key()
    const job = await reserve(`isolation-${SUITE}`, kek)
    await expect(readChannelMediaHandoff({
      tenantId: TENANT_A, operationId: job.id, kek: await key(),
    }, env)).rejects.toMatchObject({ code: ARTIFACT_INTAKE_ERROR.CIPHERTEXT_INVALID })
    await expect(processChannelMediaJob({
      tenantId: TENANT_B, operationId: job.id, tmk: await key(), kek, env,
    })).rejects.toMatchObject({ code: ARTIFACT_INTAKE_ERROR.NOT_FOUND })
    expect(await getChannelMediaJob(TENANT_B, job.id, env)).toBeNull()
  })

  it('reaps an expired encrypted handoff and records a fixed terminal status', async () => {
    const kek = await key()
    const now = Date.now() - (25 * 60 * 60 * 1000)
    const job = await reserveChannelMediaJob({
      tenantId: TENANT_A, provider: 'telegram', eventIdentity: `expired-${SUITE}`,
      descriptor: telegramDescriptor(`expired-${SUITE}`), kek, now,
    }, env)
    expect(await env.R2_ARTIFACTS.get(await channelMediaHandoffKey(TENANT_A, job.id))).not.toBeNull()
    expect((await reapExpiredChannelMediaJobs(env, Date.now())).reaped).toBeGreaterThanOrEqual(1)
    expect(await env.R2_ARTIFACTS.get(await channelMediaHandoffKey(TENANT_A, job.id))).toBeNull()
    expect(await getChannelMediaJob(TENANT_A, job.id, env)).toMatchObject({
      status: 'failed', deliveryStatus: 'failed', errorCode: 'locator_expired',
    })
  })
})
