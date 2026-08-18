import type { Env } from '../../types/env'

export interface ArtifactFinalizationOverlapAudit {
  affectedFinalizationCount: number
  zeroExpectedOperationCount: number
  missingManifestHashCount: number
  missingOperationBindingCount: number
}

/**
 * Durable audit upper boundary. A Worker deployment timestamp is NOT a drain
 * boundary: an isolate or request started before the route switch can commit
 * after that timestamp. Callers must either audit invariant-wide up to the
 * moment the audit runs, or supply a boundary they have directly verified no
 * old-version isolate could write past.
 */
export type ArtifactOverlapAuditBoundary =
  | { kind: 'audit_time'; auditedAt: number }
  | { kind: 'verified_drain'; drainVerifiedAt: number }

/**
 * Content-free audit for the migration-1032/Worker-deployment overlap. The
 * caller supplies the directly verified migration application time and an
 * explicit upper boundary; see ArtifactOverlapAuditBoundary.
 */
export const ARTIFACT_FINALIZATION_OVERLAP_AUDIT_SQL = `
  WITH interval_finalizations AS (
    SELECT id, tenant_id, canonical_capture_id, canonical_document_id, canonical_operation_id,
           expected_operation_count, artifact_manifest_sha256
    FROM artifact_intake_finalizations
    WHERE created_at >= ? AND created_at < ?
  ), missing_bindings AS (
    SELECT COUNT(*) AS count
    FROM artifact_intake_operations operation
    WHERE operation.updated_at >= ? AND operation.updated_at < ?
      AND operation.canonical_capture_id IS NOT NULL
      AND operation.canonical_document_id IS NOT NULL
      AND operation.canonical_operation_id IS NOT NULL
      AND operation.finalization_id IS NULL
  )
  SELECT
    SUM(CASE WHEN expected_operation_count = 0 THEN 1 ELSE 0 END) AS zero_expected_operation_count,
    SUM(CASE WHEN artifact_manifest_sha256 IS NULL THEN 1 ELSE 0 END) AS missing_manifest_hash_count,
    SUM(CASE WHEN expected_operation_count = 0 OR artifact_manifest_sha256 IS NULL THEN 1 ELSE 0 END)
      AS affected_finalization_count,
    (SELECT count FROM missing_bindings) AS missing_operation_binding_count
  FROM interval_finalizations`

export async function auditArtifactFinalizationMigrationOverlap(args: {
  migrationAppliedAt: number
  boundary: ArtifactOverlapAuditBoundary
}, env: Env): Promise<ArtifactFinalizationOverlapAudit> {
  const upperBound = args.boundary.kind === 'audit_time'
    ? args.boundary.auditedAt
    : args.boundary.drainVerifiedAt
  if (!Number.isFinite(upperBound) || upperBound <= args.migrationAppliedAt) {
    throw new Error('artifact finalization overlap audit boundary invalid')
  }
  const row = await env.D1_US.prepare(ARTIFACT_FINALIZATION_OVERLAP_AUDIT_SQL).bind(
    args.migrationAppliedAt, upperBound,
    args.migrationAppliedAt, upperBound,
  ).first<{
    affected_finalization_count: number | null
    zero_expected_operation_count: number | null
    missing_manifest_hash_count: number | null
    missing_operation_binding_count: number | null
  }>()
  if (!row) throw new Error('artifact finalization overlap audit unavailable')
  return {
    affectedFinalizationCount: Number(row.affected_finalization_count ?? 0),
    zeroExpectedOperationCount: Number(row.zero_expected_operation_count ?? 0),
    missingManifestHashCount: Number(row.missing_manifest_hash_count ?? 0),
    missingOperationBindingCount: Number(row.missing_operation_binding_count ?? 0),
  }
}
