import type { Env } from '../../types/env'

/**
 * Protocol marker recorded at reserve time. Attempt-key adoption is enabled
 * only on rows reserved with this marker, and such rows are only created once
 * ARTIFACT_UPLOAD_PROTOCOL_PHASE is "active" — a deploy that must follow a
 * verified drain of the pre-ownership Worker. The old Worker's mutations are
 * guarded only by status != 'finalized', so no D1 predicate can protect an
 * attempt-adopted row from it; the protocol therefore guarantees an old
 * writer can never hold a fenced row at all. See migration 1033 for the
 * executable expand / compatibility / drain / activate / enforce sequence.
 */
export const ARTIFACT_UPLOAD_PROTOCOL_FENCED = 'fenced_v2'

export type ArtifactUploadProtocolPhase = 'compat' | 'active'

/** Deployment phase. Defaults to "compat": fenced rows must be opted into. */
export function artifactUploadProtocolPhase(env: Env): ArtifactUploadProtocolPhase {
  return env.ARTIFACT_UPLOAD_PROTOCOL_PHASE === 'active' ? 'active' : 'compat'
}

/** The upload_protocol value a reserve performed under this env must record. */
export function reservedUploadProtocol(env: Env): string | null {
  return artifactUploadProtocolPhase(env) === 'active' ? ARTIFACT_UPLOAD_PROTOCOL_FENCED : null
}

/**
 * Upload handling always dispatches on the row's recorded protocol, never on
 * the running Worker's phase, so compat and active builds may overlap safely.
 */
export function isFencedUploadProtocol(value: string | null | undefined): boolean {
  return value === ARTIFACT_UPLOAD_PROTOCOL_FENCED
}
