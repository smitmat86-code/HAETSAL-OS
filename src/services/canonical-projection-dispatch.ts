import type { Env } from '../types/env'
import type { CanonicalProjectionDispatchMessage } from '../types/canonical-capture-pipeline'
import {
  buildCanonicalCaptureFailedAuditBatch,
  buildCanonicalProjectionQueuedAuditBatch,
} from './canonical-memory-audit'
import { getCanonicalMemoryStore } from './canonical-postgres'

export async function enqueueCanonicalProjectionDispatch(
  message: CanonicalProjectionDispatchMessage,
  env: Env,
): Promise<void> {
  await env.QUEUE_BULK.send(message)
  const queuedAt = Date.now()

  await getCanonicalMemoryStore(env).recordDispatchState({
    tenantId: message.tenantId,
    operationId: message.payload.operationId,
    status: 'queued',
    updatedAt: queuedAt,
  })
  await env.D1_US.batch(buildCanonicalProjectionQueuedAuditBatch(env.D1_US, {
      tenantId: message.tenantId,
      operationId: message.payload.operationId,
      projectionKinds: message.payload.projectionKinds,
      createdAt: queuedAt,
    }))
}

export async function markCanonicalProjectionDispatchFailed(
  message: CanonicalProjectionDispatchMessage,
  env: Env,
  error: unknown,
): Promise<void> {
  const failedAt = Date.now()
  const detail = error instanceof Error ? error.message : String(error)

  await getCanonicalMemoryStore(env).recordDispatchState({
    tenantId: message.tenantId,
    operationId: message.payload.operationId,
    status: 'failed',
    updatedAt: failedAt,
    errorMessage: detail,
  })
  await env.D1_US.batch(buildCanonicalCaptureFailedAuditBatch(env.D1_US, {
      tenantId: message.tenantId,
      operationId: message.payload.operationId,
      createdAt: failedAt,
    }))
}
