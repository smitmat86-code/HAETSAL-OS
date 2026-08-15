import { beforeAll, describe, expect, it, vi } from 'vitest'
import { env } from 'cloudflare:test'
import { ArtifactIntakeContractError, ARTIFACT_INTAKE_ERROR } from '../src/services/artifact-intake/contracts'
import { sha256Text, unsealArtifactBytes } from '../src/services/artifact-intake/crypto'
import { CHANNEL_MEDIA_FINALIZATION_STALE_MS } from '../src/services/artifact-intake/config'
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
import { claimChannelMediaJobForProcessing } from '../src/services/channel-media/claim-outcome'
import { claimChannelMediaDelivery } from '../src/services/channel-media/delivery-state'
import { deliverChannelMediaClaim } from '../src/services/channel-media/delivery'
import { processChannelMediaMessage } from '../src/workers/ingestion/channel-media-consumer'
import { acceptChannelMedia } from '../src/services/channel-media/intake'
import { prepareChannelMediaCapture } from '../src/services/channel-media/finalize-job'
import { reapExpiredChannelMediaJobs } from '../src/services/channel-media/reaper'
import { channelMediaRecoveryKey } from '../src/services/channel-media/recovery'
import { getArtifactIntakeOperation } from '../src/services/artifact-intake/operations'
import {
  getCanonicalMemoryStore,
  installCanonicalMemoryStore,
  installCanonicalMemoryTestStore,
} from '../src/services/canonical-postgres'
import type { CanonicalMemoryStore } from '../src/services/canonical-postgres-repository'
import { getCanonicalDocument } from '../src/services/canonical-memory-query'
import type { Env } from '../src/types/env'
import type { ChannelMediaDescriptor } from '../src/types/channel-media'
import type { IngestionQueueMessage } from '../src/types/ingestion'

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

async function installTenantKek(tenantId: string): Promise<CryptoKey> {
  const raw = crypto.getRandomValues(new Uint8Array(32))
  await env.KV_SESSION.put(`cron_kek:${tenantId}`, btoa(String.fromCharCode(...raw)))
  await env.D1_US.prepare(
    'UPDATE tenants SET cron_kek_expires_at = ? WHERE id = ?',
  ).bind(Date.now() + 60_000, tenantId).run()
  return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt'])
}

function queueMessage(operationId: string) {
  const ack = vi.fn()
  const retry = vi.fn()
  const message = {
    body: {
      type: 'channel_media', tenantId: TENANT_A, payload: { operationId }, enqueuedAt: Date.now(),
    } satisfies IngestionQueueMessage,
    ack,
    retry,
  } as unknown as Message<IngestionQueueMessage>
  return { message, ack, retry }
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

async function finalizeForDelivery(marker: string, kek: CryptoKey) {
  const reserved = await reserve(marker, kek)
  const claimed = await claimChannelMediaJob(TENANT_A, reserved.id, env)
  expect(claimed).toMatchObject({ status: 'processing' })
  await markChannelMediaFinalized({
    tenantId: TENANT_A,
    operationId: reserved.id,
    uploadId: crypto.randomUUID(),
    captureId: crypto.randomUUID(),
    documentId: crypto.randomUUID(),
    canonicalOperationId: crypto.randomUUID(),
    leaseToken: claimed!.leaseToken!,
  }, env)
  return (await getChannelMediaJob(TENANT_A, reserved.id, env))!
}

function claimRaceEnv(
  operationId: string,
  nextStatus: 'retryable' | 'finalized' | 'failed',
): Env {
  let injected = false
  const original = env.D1_US
  const wrap = (statement: D1PreparedStatement, sql: string): D1PreparedStatement => new Proxy(statement, {
    get(target, property) {
      if (property === 'bind') {
        return (...values: unknown[]) => wrap(target.bind(...values), sql)
      }
      if (property === 'run' && sql.includes("SET status = 'processing'")) {
        return async () => {
          if (injected && nextStatus === 'retryable') {
            return { success: true, meta: { changes: 0 }, results: [] } as unknown as D1Result
          }
          const result = await target.run()
          if (!injected) {
            injected = true
            await original.prepare(
              `UPDATE channel_media_jobs SET status = ?, delivery_status = 'pending',
               lease_token = NULL, lease_expires_at = NULL, updated_at = ?
               WHERE tenant_id = ? AND id = ?`,
            ).bind(nextStatus, Date.now(), TENANT_A, operationId).run()
          }
          return { ...result, meta: { ...result.meta, changes: 0 } }
        }
      }
      const value = Reflect.get(target, property)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
  const d1 = new Proxy(original, {
    get(target, property) {
      if (property === 'prepare') return (sql: string) => wrap(target.prepare(sql), sql)
      const value = Reflect.get(target, property)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
  return { ...env, D1_US: d1 } as unknown as Env
}

function delayedFinalizationInsertEnv(): {
  delayedEnv: Env
  insertStarted: Promise<void>
  releaseInsert: () => void
} {
  let signalStarted!: () => void
  let signalRelease!: () => void
  let delayed = false
  const insertStarted = new Promise<void>(resolve => { signalStarted = resolve })
  const release = new Promise<void>(resolve => { signalRelease = resolve })
  const original = env.D1_US
  const wrap = (statement: D1PreparedStatement, sql: string): D1PreparedStatement => new Proxy(statement, {
    get(target, property) {
      if (property === 'bind') return (...values: unknown[]) => wrap(target.bind(...values), sql)
      if (
        property === 'run' && !delayed &&
        sql.includes('INSERT OR IGNORE INTO artifact_intake_finalizations')
      ) {
        return async () => {
          delayed = true
          signalStarted()
          await release
          return target.run()
        }
      }
      const value = Reflect.get(target, property)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
  const d1 = new Proxy(original, {
    get(target, property) {
      if (property === 'prepare') return (sql: string) => wrap(target.prepare(sql), sql)
      const value = Reflect.get(target, property)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
  return {
    delayedEnv: { ...env, D1_US: d1 } as unknown as Env,
    insertStarted,
    releaseInsert: signalRelease,
  }
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

  it('rejects an invalid provider descriptor before any D1 row, handoff, or queue message exists', async () => {
    await installTenantKek(TENANT_A)
    const send = vi.fn()
    const testEnv = { ...env, QUEUE_HIGH: { send } } as unknown as Env
    const beforeRows = await env.D1_US.prepare(
      'SELECT COUNT(*) AS count FROM channel_media_jobs WHERE tenant_id = ?',
    ).bind(TENANT_A).first<{ count: number }>()
    const beforeHandoffs = await env.R2_ARTIFACTS.list({ prefix: 'artifact-intake/handoff/v1/' })
    const invalid = {
      ...telegramDescriptor(`pre-insert-${SUITE}`),
      locatorKind: 'sendblue_message_handle' as const,
    }

    await expect(acceptChannelMedia({
      tenantId: TENANT_A,
      provider: 'telegram',
      eventIdentity: `pre-insert-${SUITE}`,
      descriptor: invalid,
    }, testEnv)).rejects.toMatchObject({ code: ARTIFACT_INTAKE_ERROR.PROVIDER_LOCATOR_INVALID })

    const afterRows = await env.D1_US.prepare(
      'SELECT COUNT(*) AS count FROM channel_media_jobs WHERE tenant_id = ?',
    ).bind(TENANT_A).first<{ count: number }>()
    const afterHandoffs = await env.R2_ARTIFACTS.list({ prefix: 'artifact-intake/handoff/v1/' })
    expect(Number(afterRows?.count)).toBe(Number(beforeRows?.count))
    expect(afterHandoffs.objects).toHaveLength(beforeHandoffs.objects.length)
    expect(send).not.toHaveBeenCalled()
  })

  it('retries a queue delivery for the remaining active processing lease instead of acknowledging it', async () => {
    const kek = await installTenantKek(TENANT_A)
    const tmk = await key()
    const job = await reserve(`active-lease-${SUITE}`, kek)
    const claimed = await claimChannelMediaJob(TENANT_A, job.id, env)
    expect(claimed?.status).toBe('processing')
    const queued = queueMessage(job.id)

    await processChannelMediaMessage(queued.message, tmk, env)

    expect(queued.ack).not.toHaveBeenCalled()
    expect(queued.retry).toHaveBeenCalledTimes(1)
    const delay = queued.retry.mock.calls[0]?.[0]?.delaySeconds
    expect(delay).toBeGreaterThanOrEqual(1)
    expect(delay).toBeLessThanOrEqual(300)
  })

  it('delays a redelivery after an isolate dies with a delivery claim and cleans up at the ambiguity boundary', async () => {
    const kek = await installTenantKek(TENANT_A)
    const tmk = await key()
    const job = await finalizeForDelivery(`delivery-claim-death-${SUITE}`, kek)
    expect(await claimChannelMediaDelivery(TENANT_A, job.id, env)).toBeTruthy()
    const deliver = vi.fn(async () => 'delivered' as const)

    const whileClaimed = queueMessage(job.id)
    await processChannelMediaMessage(whileClaimed.message, tmk, env, { deliver })
    expect(whileClaimed.ack).not.toHaveBeenCalled()
    expect(whileClaimed.retry).toHaveBeenCalledTimes(1)
    expect(deliver).not.toHaveBeenCalled()

    await env.D1_US.prepare(
      `UPDATE channel_media_jobs SET lease_expires_at = ?, updated_at = ?
       WHERE tenant_id = ? AND id = ?`,
    ).bind(Date.now() - 2, Date.now() - 2, TENANT_A, job.id).run()
    const afterBoundary = queueMessage(job.id)
    await processChannelMediaMessage(afterBoundary.message, tmk, env, { deliver })
    expect(afterBoundary.ack).toHaveBeenCalledTimes(1)
    expect(afterBoundary.retry).not.toHaveBeenCalled()
    expect(deliver).not.toHaveBeenCalled()
    expect(await getChannelMediaJob(TENANT_A, job.id, env)).toMatchObject({
      status: 'delivery_unknown', deliveryStatus: 'unknown', errorCode: 'delivery_unknown',
      handoffStatus: 'deleted',
    })
    expect(await env.R2_ARTIFACTS.get(await channelMediaHandoffKey(TENANT_A, job.id))).toBeNull()
  })

  it('does not resend or ACK while a provider call is in flight and fences its stale completion after expiry', async () => {
    const kek = await installTenantKek(TENANT_A)
    const tmk = await key()
    const job = await finalizeForDelivery(`delivery-call-death-${SUITE}`, kek)
    let providerStarted!: () => void
    let releaseProvider!: (outcome: 'delivered') => void
    const started = new Promise<void>(resolve => { providerStarted = resolve })
    const providerOutcome = new Promise<'delivered'>(resolve => { releaseProvider = resolve })
    const deliver = vi.fn(async () => {
      providerStarted()
      return providerOutcome
    })
    const inFlight = deliverChannelMediaClaim({
      job,
      descriptor: telegramDescriptor(`delivery-call-death-${SUITE}`),
      message: 'Captured that photo.',
      env,
      deliver,
    })
    await started

    const whileClaimed = queueMessage(job.id)
    await processChannelMediaMessage(whileClaimed.message, tmk, env, { deliver })
    expect(whileClaimed.ack).not.toHaveBeenCalled()
    expect(whileClaimed.retry).toHaveBeenCalledTimes(1)
    expect(deliver).toHaveBeenCalledTimes(1)

    await env.D1_US.prepare(
      `UPDATE channel_media_jobs SET lease_expires_at = ?, updated_at = ?
       WHERE tenant_id = ? AND id = ?`,
    ).bind(Date.now() - 2, Date.now() - 2, TENANT_A, job.id).run()
    const afterBoundary = queueMessage(job.id)
    await processChannelMediaMessage(afterBoundary.message, tmk, env, { deliver })
    expect(afterBoundary.ack).toHaveBeenCalledTimes(1)
    expect(deliver).toHaveBeenCalledTimes(1)

    releaseProvider('delivered')
    await inFlight
    expect(await getChannelMediaJob(TENANT_A, job.id, env)).toMatchObject({
      status: 'delivery_unknown', deliveryStatus: 'unknown', handoffStatus: 'deleted',
    })
    expect(deliver).toHaveBeenCalledTimes(1)
  })

  it('classifies failed-claim races as actionable instead of a terminal ACK', async () => {
    const expected = [
      ['retryable', 'actionable_retryable'],
      ['finalized', 'finalized_delivery_pending'],
      ['failed', 'failed_delivery_pending'],
    ] as const
    for (const [nextStatus, expectedStatus] of expected) {
      const kek = await key()
      const job = await reserve(`claim-race-${nextStatus}-${SUITE}`, kek)
      const outcome = await claimChannelMediaJobForProcessing(
        TENANT_A, job.id, claimRaceEnv(job.id, nextStatus),
      )
      expect(outcome).toMatchObject({ status: expectedStatus })
    }
  })

  it('ACKs only stable delivered, delivery-unknown, and terminal delivery states', async () => {
    const kek = await installTenantKek(TENANT_A)
    const tmk = await key()
    const deliver = vi.fn(async () => 'delivered' as const)
    for (const [status, deliveryStatus] of [
      ['delivered', 'delivered'],
      ['delivery_unknown', 'unknown'],
      ['failed', 'failed'],
    ] as const) {
      const job = await reserve(`stable-ack-${status}-${SUITE}`, kek)
      await env.D1_US.prepare(
        `UPDATE channel_media_jobs SET status = ?, delivery_status = ?,
         lease_token = NULL, lease_expires_at = NULL, updated_at = ?
         WHERE tenant_id = ? AND id = ?`,
      ).bind(status, deliveryStatus, Date.now(), TENANT_A, job.id).run()
      const queued = queueMessage(job.id)
      await processChannelMediaMessage(queued.message, tmk, env, { deliver })
      expect(queued.ack).toHaveBeenCalledTimes(1)
      expect(queued.retry).not.toHaveBeenCalled()
    }
    expect(deliver).not.toHaveBeenCalled()
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

  it('recovers a real post-finalization process death without duplicate vision, artifacts, captures, documents, or replies', async () => {
    const kek = await installTenantKek(TENANT_A)
    const tmk = await key()
    const store = getCanonicalMemoryStore(env)
    const beforeStats = await store.getStats(TENANT_A)
    const job = await reserve(`process-death-${SUITE}`, kek)
    const acquire = vi.fn(async () => ({ bytes: JPEG, detectedMimeType: 'image/jpeg' }))
    const describe = vi.fn(async () => `process-death-description-${SUITE}`)
    const deliver = vi.fn(async () => 'delivered' as const)
    let canonicalReached!: () => void
    const canonicalCommitted = new Promise<void>(resolve => { canonicalReached = resolve })
    const abandonedForever = new Promise<void>(() => undefined)
    const dependencies = {
      acquire,
      describe,
      deliver,
      afterCanonicalFinalization: async () => {
        canonicalReached()
        await abandonedForever
      },
    }
    const first = queueMessage(job.id)

    void processChannelMediaMessage(first.message, tmk, env, dependencies)
    await canonicalCommitted
    expect(first.ack).not.toHaveBeenCalled()
    expect(first.retry).not.toHaveBeenCalled()

    const whileHeld = queueMessage(job.id)
    await processChannelMediaMessage(whileHeld.message, tmk, env, dependencies)
    expect(whileHeld.ack).not.toHaveBeenCalled()
    expect(whileHeld.retry).toHaveBeenCalledTimes(1)
    expect(acquire).toHaveBeenCalledTimes(1)
    expect(describe).toHaveBeenCalledTimes(1)
    expect(deliver).not.toHaveBeenCalled()

    await env.D1_US.prepare(
      'UPDATE channel_media_jobs SET lease_expires_at = ? WHERE tenant_id = ? AND id = ?',
    ).bind(Date.now() - 1, TENANT_A, job.id).run()
    const recovered = queueMessage(job.id)
    await processChannelMediaMessage(recovered.message, tmk, env, dependencies)
    expect(recovered.ack).toHaveBeenCalledTimes(1)
    expect(recovered.retry).not.toHaveBeenCalled()
    expect(acquire).toHaveBeenCalledTimes(1)
    expect(describe).toHaveBeenCalledTimes(1)
    expect(deliver).toHaveBeenCalledTimes(1)

    const completed = await getChannelMediaJob(TENANT_A, job.id, env)
    expect(completed).toMatchObject({ status: 'delivered', deliveryStatus: 'delivered' })
    const operations = await env.D1_US.prepare(
      'SELECT id FROM artifact_intake_operations WHERE tenant_id = ? AND canonical_capture_id = ?',
    ).bind(TENANT_A, completed!.canonicalCaptureId).all()
    const finalizations = await env.D1_US.prepare(
      'SELECT id FROM artifact_intake_finalizations WHERE tenant_id = ? AND canonical_capture_id = ?',
    ).bind(TENANT_A, completed!.canonicalCaptureId).all()
    expect(operations.results).toHaveLength(1)
    expect(finalizations.results).toHaveLength(1)
    const document = await store.getDocument(TENANT_A, completed!.canonicalDocumentId!)
    expect(document?.artifact_manifest).toHaveLength(1)
    const afterStats = await store.getStats(TENANT_A)
    expect(afterStats.captureCount).toBe(beforeStats.captureCount + 1)
    expect(afterStats.documentCount).toBe(beforeStats.documentCount + 1)

    const redelivery = queueMessage(job.id)
    await processChannelMediaMessage(redelivery.message, tmk, env, dependencies)
    expect(redelivery.ack).toHaveBeenCalledTimes(1)
    expect(deliver).toHaveBeenCalledTimes(1)
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

  it('recovers canonical success before the reaper cleans a failed pending-delivery job', async () => {
    const kek = await installTenantKek(TENANT_A)
    const tmk = await key()
    const job = await reserve(`reaper-canonical-${SUITE}`, kek)
    const acquire = vi.fn(async () => ({ bytes: JPEG, detectedMimeType: 'image/jpeg' }))
    const describe = vi.fn(async () => `reaper-canonical-description-${SUITE}`)
    const deliver = vi.fn(async () => 'delivered' as const)
    let canonicalReached!: () => void
    const canonicalCommitted = new Promise<void>(resolve => { canonicalReached = resolve })
    const dependencies = {
      acquire,
      describe,
      deliver,
      afterCanonicalFinalization: async () => {
        canonicalReached()
        await new Promise<void>(() => undefined)
      },
    }
    const abandoned = queueMessage(job.id)
    void processChannelMediaMessage(abandoned.message, tmk, env, dependencies)
    await canonicalCommitted
    await env.D1_US.prepare(
      `UPDATE channel_media_jobs SET status = 'failed', delivery_status = 'pending',
       error_code = ?, lease_token = NULL, lease_expires_at = NULL, expires_at = ?
       WHERE tenant_id = ? AND id = ?`,
    ).bind(ARTIFACT_INTAKE_ERROR.LOCATOR_EXPIRED, Date.now() - 1, TENANT_A, job.id).run()

    expect((await reapExpiredChannelMediaJobs(env, Date.now())).reaped).toBeGreaterThanOrEqual(1)
    expect(await getChannelMediaJob(TENANT_A, job.id, env)).toMatchObject({
      status: 'finalized', deliveryStatus: 'pending', errorCode: null,
    })
    expect(await env.R2_ARTIFACTS.get(await channelMediaHandoffKey(TENANT_A, job.id))).not.toBeNull()
    expect(await env.R2_ARTIFACTS.get(await channelMediaRecoveryKey(TENANT_A, job.id))).not.toBeNull()
    expect(acquire).toHaveBeenCalledTimes(1)
    expect(describe).toHaveBeenCalledTimes(1)
    expect(deliver).not.toHaveBeenCalled()

    const queued = queueMessage(job.id)
    await processChannelMediaMessage(queued.message, tmk, env, dependencies)
    expect(queued.ack).toHaveBeenCalledTimes(1)
    expect(deliver).toHaveBeenCalledTimes(1)
    expect(await getChannelMediaJob(TENANT_A, job.id, env)).toMatchObject({
      status: 'delivered', deliveryStatus: 'delivered', errorCode: null,
    })
  })

  it('fences a stale worker after its delayed finalization reservation loses the channel lease', async () => {
    const kek = await key()
    const tmk = await key()
    const store = getCanonicalMemoryStore(env)
    const beforeStats = await store.getStats(TENANT_A)
    const beforeOperations = await env.D1_US.prepare(
      'SELECT id FROM artifact_intake_operations WHERE tenant_id = ?',
    ).bind(TENANT_A).all()
    const beforeArtifacts = await env.R2_ARTIFACTS.list({ prefix: 'artifact-intake/v1/' })
    const marker = `delayed-finalization-fence-${SUITE}`
    const job = await reserve(marker, kek)
    const descriptor = await readChannelMediaHandoff({
      tenantId: TENANT_A, operationId: job.id, kek,
    }, env)
    const acquire = vi.fn(async () => ({ bytes: JPEG, detectedMimeType: 'image/jpeg' }))
    const describe = vi.fn(async () => `delayed-finalization-description-${SUITE}`)
    const providerMessages: string[] = []
    let deliveryStarted!: () => void
    let releaseDelivery!: () => void
    const startedDelivery = new Promise<void>(resolve => { deliveryStarted = resolve })
    const deliveryRelease = new Promise<void>(resolve => { releaseDelivery = resolve })
    const deliver = vi.fn(async (_descriptor: ChannelMediaDescriptor, message: string) => {
      providerMessages.push(message)
      deliveryStarted()
      await deliveryRelease
      return 'delivered' as const
    })
    const delayed = delayedFinalizationInsertEnv()
    const workerA = processChannelMediaJob({
      tenantId: TENANT_A, operationId: job.id, tmk, kek, env: delayed.delayedEnv,
      dependencies: { acquire, describe, deliver },
    })
    await delayed.insertStarted
    expect(await env.D1_US.prepare(
      'SELECT id FROM artifact_intake_finalizations WHERE tenant_id = ? AND idempotency_hash = ?',
    ).bind(TENANT_A, await sha256Text(`channel-media-finalize:${job.id}`)).first()).toBeNull()

    await env.D1_US.prepare(
      `UPDATE channel_media_jobs SET lease_expires_at = ?
       WHERE tenant_id = ? AND id = ? AND status = 'processing'`,
    ).bind(Date.now() - 1, TENANT_A, job.id).run()
    const workerB = await claimChannelMediaJob(TENANT_A, job.id, env)
    expect(workerB).toMatchObject({ status: 'processing' })
    await markChannelMediaFailed(
      TENANT_A, job.id, workerB!.leaseToken!, ARTIFACT_INTAKE_ERROR.MIME_MISMATCH, env,
    )
    const failed = await getChannelMediaJob(TENANT_A, job.id, env)
    expect(failed).toMatchObject({ status: 'failed', deliveryStatus: 'pending' })
    const failureDelivery = deliverChannelMediaClaim({
      job: failed!, descriptor,
      message: 'I could not capture that photo. Please try sending it again.',
      env, deliver,
    })
    await startedDelivery
    expect(await getChannelMediaJob(TENANT_A, job.id, env)).toMatchObject({
      status: 'failed', deliveryStatus: 'claimed',
    })

    delayed.releaseInsert()
    await expect(workerA).resolves.toMatchObject({
      status: 'deferred', reason: 'recovery_in_progress',
    })
    const whileClaimedStats = await store.getStats(TENANT_A)
    expect(whileClaimedStats.captureCount).toBe(beforeStats.captureCount)
    expect(whileClaimedStats.documentCount).toBe(beforeStats.documentCount)

    releaseDelivery()
    await expect(failureDelivery).resolves.toBe('done')
    await expect(processChannelMediaJob({
      tenantId: TENANT_A, operationId: job.id, tmk, kek, env,
      dependencies: { acquire, describe, deliver },
    })).resolves.toBe('ignored')

    const finalStats = await store.getStats(TENANT_A)
    const afterOperations = await env.D1_US.prepare(
      'SELECT id FROM artifact_intake_operations WHERE tenant_id = ?',
    ).bind(TENANT_A).all()
    const afterArtifacts = await env.R2_ARTIFACTS.list({ prefix: 'artifact-intake/v1/' })
    const finalizations = await env.D1_US.prepare(
      'SELECT status FROM artifact_intake_finalizations WHERE tenant_id = ? AND idempotency_hash = ?',
    ).bind(TENANT_A, await sha256Text(`channel-media-finalize:${job.id}`)).all<{ status: string }>()
    const canonicalSucceeded = finalStats.captureCount > beforeStats.captureCount
    const failureWasSent = providerMessages.some(message => message.includes('could not capture'))
    expect(canonicalSucceeded && failureWasSent).toBe(false)
    expect(finalStats.captureCount).toBe(beforeStats.captureCount)
    expect(finalStats.documentCount).toBe(beforeStats.documentCount)
    expect(afterOperations.results).toHaveLength(beforeOperations.results.length + 1)
    expect(afterArtifacts.objects).toHaveLength(beforeArtifacts.objects.length + 1)
    expect(finalizations.results).toHaveLength(1)
    expect(acquire).toHaveBeenCalledTimes(1)
    expect(describe).toHaveBeenCalledTimes(1)
    expect(deliver).toHaveBeenCalledTimes(1)
    expect(providerMessages).toEqual(['I could not capture that photo. Please try sending it again.'])
    expect(await getChannelMediaJob(TENANT_A, job.id, env)).toMatchObject({
      status: 'failed', deliveryStatus: 'delivered', errorCode: ARTIFACT_INTAKE_ERROR.MIME_MISMATCH,
    })
  })

  it('keeps a reserved canonical finalization recovery-pending across lease expiry, then repairs canonical success exactly once', async () => {
    const kek = await key()
    const tmk = await key()
    const store = getCanonicalMemoryStore(env)
    const beforeStats = await store.getStats(TENANT_A)
    const job = await reserve(`reserved-finalization-${SUITE}`, kek)
    const acquire = vi.fn(async () => ({ bytes: JPEG, detectedMimeType: 'image/jpeg' }))
    const describe = vi.fn(async () => `reserved-finalization-description-${SUITE}`)
    const deliver = vi.fn(async () => 'delivered' as const)
    let writeStarted!: () => void
    let releaseWrite!: () => void
    const started = new Promise<void>(resolve => { writeStarted = resolve })
    const release = new Promise<void>(resolve => { releaseWrite = resolve })
    const delayedStore = new Proxy(store, {
      get(target, property) {
        if (property === 'writeCapture') {
          return async (...args: Parameters<CanonicalMemoryStore['writeCapture']>) => {
            writeStarted()
            await release
            return target.writeCapture(...args)
          }
        }
        const value = Reflect.get(target, property)
        return typeof value === 'function' ? value.bind(target) : value
      },
    })
    installCanonicalMemoryStore(env, delayedStore)
    let firstRun: Promise<unknown> | undefined
    try {
      firstRun = processChannelMediaJob({
        tenantId: TENANT_A, operationId: job.id, tmk, kek, env,
        dependencies: { acquire, describe, deliver },
      })
      await started
      expect(await env.D1_US.prepare(
        `SELECT status FROM artifact_intake_finalizations
         WHERE tenant_id = ? AND idempotency_hash = ?`,
      ).bind(TENANT_A, await sha256Text(`channel-media-finalize:${job.id}`)).first<{ status: string }>())
        .toMatchObject({ status: 'reserved' })

      await env.D1_US.prepare(
        `UPDATE channel_media_jobs SET lease_expires_at = ?, expires_at = ?
         WHERE tenant_id = ? AND id = ?`,
      ).bind(Date.now() - 2, Date.now() - 1, TENANT_A, job.id).run()
      await reapExpiredChannelMediaJobs(env, Date.now())
      expect(await getChannelMediaJob(TENANT_A, job.id, env)).not.toMatchObject({ status: 'failed' })
      expect(await env.R2_ARTIFACTS.get(await channelMediaHandoffKey(TENANT_A, job.id))).not.toBeNull()
      expect(await env.R2_ARTIFACTS.get(await channelMediaRecoveryKey(TENANT_A, job.id))).not.toBeNull()

      releaseWrite()
      await expect(firstRun).resolves.toBe('processed')
    } finally {
      releaseWrite?.()
      await firstRun?.catch(() => undefined)
      installCanonicalMemoryStore(env, store)
    }

    const completed = await getChannelMediaJob(TENANT_A, job.id, env)
    expect(completed).toMatchObject({ status: 'delivered', deliveryStatus: 'delivered', errorCode: null })
    const operations = await env.D1_US.prepare(
      'SELECT id FROM artifact_intake_operations WHERE tenant_id = ? AND canonical_capture_id = ?',
    ).bind(TENANT_A, completed!.canonicalCaptureId).all()
    const finalizations = await env.D1_US.prepare(
      'SELECT id FROM artifact_intake_finalizations WHERE tenant_id = ? AND canonical_capture_id = ?',
    ).bind(TENANT_A, completed!.canonicalCaptureId).all()
    expect(operations.results).toHaveLength(1)
    expect(finalizations.results).toHaveLength(1)
    expect((await store.getDocument(TENANT_A, completed!.canonicalDocumentId!))?.artifact_manifest).toHaveLength(1)
    const afterStats = await store.getStats(TENANT_A)
    expect(afterStats.captureCount).toBe(beforeStats.captureCount + 1)
    expect(afterStats.documentCount).toBe(beforeStats.documentCount + 1)
    expect(acquire).toHaveBeenCalledTimes(1)
    expect(describe).toHaveBeenCalledTimes(1)
    expect(deliver).toHaveBeenCalledTimes(1)
  })

  it('fails a genuinely abandoned stale finalization reservation instead of retrying forever', async () => {
    const kek = await key()
    const old = Date.now() - CHANNEL_MEDIA_FINALIZATION_STALE_MS - 1
    const job = await reserveChannelMediaJob({
      tenantId: TENANT_A,
      provider: 'telegram',
      eventIdentity: `abandoned-finalization-${SUITE}`,
      descriptor: telegramDescriptor(`abandoned-finalization-${SUITE}`),
      kek,
      now: old,
    }, env)
    const claimed = await claimChannelMediaJob(TENANT_A, job.id, env)
    await env.D1_US.prepare(
      `INSERT INTO artifact_intake_finalizations
       (id, tenant_id, idempotency_hash, manifest_sha256, status, error_code,
        canonical_capture_id, canonical_document_id, canonical_operation_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'reserved', NULL, ?, ?, ?, ?, ?)`,
    ).bind(
      crypto.randomUUID(), TENANT_A, await sha256Text(`channel-media-finalize:${job.id}`),
      'a'.repeat(64), crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID(), old, old,
    ).run()
    await env.D1_US.prepare(
      `UPDATE channel_media_jobs SET lease_expires_at = ?, expires_at = ?
       WHERE tenant_id = ? AND id = ? AND lease_token = ?`,
    ).bind(Date.now() - 2, Date.now() - 1, TENANT_A, job.id, claimed!.leaseToken).run()

    await reapExpiredChannelMediaJobs(env, Date.now())
    expect(await getChannelMediaJob(TENANT_A, job.id, env)).toMatchObject({
      status: 'failed', deliveryStatus: 'failed', handoffStatus: 'deleted',
    })
    expect(await env.D1_US.prepare(
      `SELECT status FROM artifact_intake_finalizations
       WHERE tenant_id = ? AND idempotency_hash = ?`,
    ).bind(TENANT_A, await sha256Text(`channel-media-finalize:${job.id}`)).first<{ status: string }>())
      .toMatchObject({ status: 'failed' })
  })
})
