import type { Env } from '../../types/env'
import { ArtifactIntakeContractError, ARTIFACT_INTAKE_ERROR } from './contracts'

/**
 * Operator-controlled upload admission gate (migration 1036). While the gate
 * is closed — the state during the rollout cutover's unsafe boundary — every
 * new artifact upload mutation is refused with the retryable
 * upload_admission_closed error before any D1 or R2 write. The gate FAILS
 * CLOSED: if its state cannot be read, admission is refused, because an
 * unreadable gate cannot prove the unsafe boundary is over. A missing row
 * (or a schema without the table yet) means "open" only when the read itself
 * succeeds/deterministically proves absence.
 */
export async function requireArtifactUploadAdmission(env: Env): Promise<void> {
  let state: string | null
  try {
    const row = await env.D1_US.prepare(
      `SELECT state FROM artifact_intake_admission WHERE id = 1 LIMIT 1`,
    ).first<{ state: string }>()
    state = row?.state ?? null
  } catch (error) {
    // Pre-migration schemas have no gate table; that is a deterministic
    // "no gate configured" state, not an unreadable gate.
    if (error instanceof Error && /no such table/i.test(error.message)) return
    throw new ArtifactIntakeContractError(ARTIFACT_INTAKE_ERROR.UPLOAD_ADMISSION_CLOSED)
  }
  if (state === 'closed') {
    throw new ArtifactIntakeContractError(ARTIFACT_INTAKE_ERROR.UPLOAD_ADMISSION_CLOSED)
  }
}
