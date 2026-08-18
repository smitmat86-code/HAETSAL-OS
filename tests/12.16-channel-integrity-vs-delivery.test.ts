import { describe, expect, it } from 'vitest'
import { env } from 'cloudflare:test'
import { markChannelMediaIntegrityIncident } from '../src/services/channel-media/job-transitions'
import {
  claimChannelMediaDelivery,
  finishChannelMediaDelivery,
} from '../src/services/channel-media/delivery-state'
import { getChannelMediaJob } from '../src/services/channel-media/jobs'
import { reapExpiredChannelMediaJobs } from '../src/services/channel-media/reaper'

const SUITE_ID = crypto.randomUUID()
const TENANT = `test-tenant-integrity-delivery-${SUITE_ID}`

async function insertJob(args: {
  status: string
  deliveryStatus: string
  errorCode?: string | null
  expiresAt?: number
}): Promise<string> {
  const now = Date.now()
  await env.D1_US.prepare(
    `INSERT OR IGNORE INTO tenants
     (id, created_at, updated_at, data_region, primary_channel, hindsight_tenant_id, ai_cost_reset_at)
     VALUES (?, ?, ?, 'us', 'sms', ?, ?)`,
  ).bind(TENANT, now, now, `hindsight-${TENANT}`, now).run()
  const jobId = crypto.randomUUID()
  await env.D1_US.prepare(
    `INSERT INTO channel_media_jobs
     (id, tenant_id, provider, event_identity_hash, status, error_code, attempt_count,
      lease_token, lease_expires_at, delivery_status, handoff_status, artifact_upload_id,
      canonical_capture_id, canonical_document_id, canonical_operation_id,
      created_at, updated_at, expires_at)
     VALUES (?, ?, 'telegram', ?, ?, ?, 1, NULL, NULL, ?, 'pending', NULL,
             NULL, NULL, NULL, ?, ?, ?)`,
  ).bind(
    jobId, TENANT, crypto.randomUUID(), args.status, args.errorCode ?? null,
    args.deliveryStatus, now, now, args.expiresAt ?? now + 60_000,
  ).run()
  return jobId
}

describe('12.16 artifact integrity is separate from delivery truth', () => {
  it('preserves finalized delivered history through an integrity incident', async () => {
    const jobId = await insertJob({ status: 'delivered', deliveryStatus: 'delivered' })
    await markChannelMediaIntegrityIncident(TENANT, jobId, env)
    const job = await getChannelMediaJob(TENANT, jobId, env)
    // Provider delivery truth is untouched; the incident is content-free
    // state recorded alongside it.
    expect(job).toMatchObject({
      status: 'delivered', deliveryStatus: 'delivered', errorCode: null,
      integrityStatus: 'artifact_integrity_incident',
    })
  })

  it('preserves a finalized pending job and its error code through an incident', async () => {
    const jobId = await insertJob({ status: 'finalized', deliveryStatus: 'pending' })
    await markChannelMediaIntegrityIncident(TENANT, jobId, env)
    expect(await getChannelMediaJob(TENANT, jobId, env)).toMatchObject({
      status: 'finalized', deliveryStatus: 'pending', errorCode: null,
      integrityStatus: 'artifact_integrity_incident',
    })
  })

  it('still records genuine provider ambiguity as delivery_unknown', async () => {
    const jobId = await insertJob({ status: 'finalized', deliveryStatus: 'pending' })
    const claim = await claimChannelMediaDelivery(TENANT, jobId, env)
    expect(claim).not.toBeNull()
    // A provider call may have occurred, but its outcome is undeterminable.
    expect(await finishChannelMediaDelivery({
      tenantId: TENANT, operationId: jobId, leaseToken: claim!.leaseToken, outcome: 'unknown',
    }, env)).toBe('finished')
    expect(await getChannelMediaJob(TENANT, jobId, env)).toMatchObject({
      status: 'delivery_unknown', deliveryStatus: 'unknown', integrityStatus: null,
    })
  })

  it('never turns an incident-marked expired job into reap fuel', async () => {
    const jobId = await insertJob({
      status: 'finalized', deliveryStatus: 'pending', expiresAt: 1,
    })
    await markChannelMediaIntegrityIncident(TENANT, jobId, env)
    await reapExpiredChannelMediaJobs(env, Date.now(), 100)
    expect(await getChannelMediaJob(TENANT, jobId, env)).toMatchObject({
      status: 'finalized', deliveryStatus: 'pending', handoffStatus: 'pending',
      integrityStatus: 'artifact_integrity_incident',
    })
  })

  it('keeps incident state content-free', async () => {
    const jobId = await insertJob({ status: 'finalized', deliveryStatus: 'pending' })
    await markChannelMediaIntegrityIncident(TENANT, jobId, env)
    const row = await env.D1_US.prepare(
      `SELECT * FROM channel_media_jobs WHERE tenant_id = ? AND id = ?`,
    ).bind(TENANT, jobId).first<Record<string, unknown>>()
    const serialized = JSON.stringify(row)
    // No filenames, paths, URLs, message bodies, or extracted content may
    // appear in the persisted incident state.
    expect(serialized).not.toMatch(/https?:|file:|[A-Za-z]:\\|\.jpe?g|\.png|\.pdf|caption|body/i)
    expect(row?.integrity_status).toBe('artifact_integrity_incident')
  })
})
