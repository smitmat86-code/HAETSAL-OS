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
  } catch {
    // Pre-migration schemas have no gate table; a successful schema read
    // proving the table's absence is a deterministic "no gate configured"
    // state, not an unreadable gate. Any other failure refuses admission.
    try {
      const table = await env.D1_US.prepare(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'artifact_intake_admission' LIMIT 1`,
      ).first<{ name: string }>()
      if (!table) return
    } catch {
      // fall through to fail closed
    }
    throw new ArtifactIntakeContractError(ARTIFACT_INTAKE_ERROR.UPLOAD_ADMISSION_CLOSED)
  }
  if (state === 'closed') {
    throw new ArtifactIntakeContractError(ARTIFACT_INTAKE_ERROR.UPLOAD_ADMISSION_CLOSED)
  }
}
