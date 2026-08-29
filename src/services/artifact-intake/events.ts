import type { Env } from '../../types/env'

export type ArtifactIntakeEventType =
  | 'reserved' | 'sealed' | 'finalized' | 'failed' | 'expired' | 'reaped'

export interface ArtifactIntakeEventSubject {
  id: string
  tenant_id: string
  upload_id: string
}

export async function recordArtifactIntakeEvent(
  env: Env,
  subject: ArtifactIntakeEventSubject,
  eventType: ArtifactIntakeEventType,
  occurredAt = Date.now(),
  errorCode: string | null = null,
): Promise<void> {
  await env.D1_US.prepare(
    `INSERT OR IGNORE INTO artifact_intake_events
     (id, tenant_id, operation_id, upload_id, event_type, occurred_at, error_code)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    crypto.randomUUID(), subject.tenant_id, subject.id, subject.upload_id,
    eventType, occurredAt, eventType === 'failed' ? errorCode : null,
  ).run()
}

export async function recordArtifactIntakeEvents(
  env: Env,
  subjects: ArtifactIntakeEventSubject[],
  eventType: ArtifactIntakeEventType,
  occurredAt = Date.now(),
): Promise<void> {
  await Promise.all(subjects.map(subject =>
    recordArtifactIntakeEvent(env, subject, eventType, occurredAt).catch(() => undefined),
  ))
}
