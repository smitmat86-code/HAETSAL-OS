import { describe, expect, it } from 'vitest'
import { env } from 'cloudflare:test'
import { handleBrainScheduled } from '../src/workers/mcpagent/runtime'
import {
  getArtifactIntakeOperation,
  reserveArtifactUpload,
} from '../src/services/artifact-intake/operations'
import { sha256Bytes } from '../src/services/artifact-intake/crypto'
import type { Env } from '../src/types/env'

const SUITE_ID = crypto.randomUUID()
const TENANT = `test-tenant-reaper-schedule-${SUITE_ID}`

async function ensureTenant(): Promise<void> {
  const now = Date.now()
  await env.D1_US.prepare(
    `INSERT OR IGNORE INTO tenants
     (id, created_at, updated_at, data_region, primary_channel, hindsight_tenant_id, ai_cost_reset_at)
     VALUES (?, ?, ?, 'us', 'sms', ?, ?)`,
  ).bind(TENANT, now, now, `hindsight-${TENANT}`, now).run()
}

function collectingContext() {
  const promises: Promise<unknown>[] = []
  const ctx = {
    waitUntil: (promise: Promise<unknown>) => { promises.push(promise) },
    passThroughOnException: () => undefined,
    props: {},
  } as unknown as ExecutionContext
  return { ctx, promises }
}

function scheduledEvent(cron: string): ScheduledEvent {
  return {
    cron,
    scheduledTime: Date.now(),
    type: 'scheduled',
    noRetry: () => undefined,
  } as unknown as ScheduledEvent
}

describe('12.22 artifact reaper production scheduling', () => {
  it('the 15-minute cron slot invokes the artifact reaper through ctx.waitUntil', async () => {
    await ensureTenant()
    const bytes = new TextEncoder().encode('scheduled-reap-secret')
    const reserved = await reserveArtifactUpload({
      tenantId: TENANT, idempotencyKey: `schedule-${SUITE_ID}`,
      byteLength: bytes.byteLength, plaintextSha256: await sha256Bytes(bytes),
      declaredMimeType: 'text/plain',
    }, env as Env)
    await env.D1_US.prepare(
      `UPDATE artifact_intake_operations SET expires_at = 1 WHERE tenant_id = ? AND upload_id = ?`,
    ).bind(TENANT, reserved.uploadId).run()

    const { ctx, promises } = collectingContext()
    // Unrelated cron work in the same slot must not be able to block or fail
    // the reaper, and vice versa: the handler itself must not reject.
    await handleBrainScheduled(scheduledEvent('*/15 * * * *'), env as Env, ctx)
      .catch(() => undefined)
    expect(promises.length).toBeGreaterThanOrEqual(2)
    await Promise.all(promises.map(promise => promise.catch(() => undefined)))

    const row = await getArtifactIntakeOperation(env, TENANT, reserved.uploadId)
    expect(row?.status).toBe('expired')
  })

  it('other cron slots do not run the artifact reaper', async () => {
    await ensureTenant()
    const bytes = new TextEncoder().encode('unscheduled-reap-secret')
    const reserved = await reserveArtifactUpload({
      tenantId: TENANT, idempotencyKey: `unscheduled-${SUITE_ID}`,
      byteLength: bytes.byteLength, plaintextSha256: await sha256Bytes(bytes),
      declaredMimeType: 'text/plain',
    }, env as Env)
    await env.D1_US.prepare(
      `UPDATE artifact_intake_operations SET expires_at = 1 WHERE tenant_id = ? AND upload_id = ?`,
    ).bind(TENANT, reserved.uploadId).run()

    const { ctx, promises } = collectingContext()
    await handleBrainScheduled(scheduledEvent('0 7 * * *'), env as Env, ctx)
      .catch(() => undefined)
    await Promise.all(promises.map(promise => promise.catch(() => undefined)))
    const row = await getArtifactIntakeOperation(env, TENANT, reserved.uploadId)
    expect(row?.status).toBe('reserved')
  })
})
