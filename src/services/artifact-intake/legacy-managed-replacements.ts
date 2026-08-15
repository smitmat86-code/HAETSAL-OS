import type {
  LegacyManagedPrimarySourceReplacement,
  LegacyManagedReplacementQueryRow,
} from './legacy-inventory-types'

// D1 predates explicit artifact roles. Preserve that uncertainty: only the
// capture+document primary pointer proves `source`; every other row yields
// NULL and is classified ambiguous.
export const LEGACY_D1_CANONICAL_REFERENCES_SQL = `
  SELECT artifact.r2_key, artifact.tenant_id, artifact.capture_id,
         CASE WHEN artifact.id = capture.artifact_id AND EXISTS (
           SELECT 1 FROM canonical_documents document
           WHERE document.tenant_id = artifact.tenant_id
             AND document.capture_id = artifact.capture_id
             AND document.artifact_id = artifact.id
         ) THEN 'source' ELSE NULL END AS role
  FROM canonical_artifacts artifact
  LEFT JOIN canonical_captures capture
    ON capture.tenant_id = artifact.tenant_id AND capture.id = artifact.capture_id
  WHERE artifact.r2_key LIKE 'telegram-media/%'
     OR artifact.r2_key LIKE 'sendblue-media/%'`

export const LEGACY_MANAGED_REPLACEMENT_CANDIDATES_SQL = `
  WITH legacy_artifacts AS (
    SELECT r2_key AS key, tenant_id, capture_id, role AS legacy_role,
           COUNT(*) OVER (PARTITION BY tenant_id, capture_id) AS legacy_artifact_count,
           COUNT(*) FILTER (WHERE role = 'source')
             OVER (PARTITION BY tenant_id, capture_id) AS eligible_legacy_source_count
    FROM haetsal_canonical.canonical_artifacts
    WHERE r2_key LIKE 'telegram-media/%' OR r2_key LIKE 'sendblue-media/%'
  ), managed_primary_sources AS (
    SELECT capture.tenant_id, capture.id AS capture_id,
           COUNT(*) OVER (PARTITION BY capture.tenant_id, capture.id) AS managed_primary_source_count
    FROM haetsal_canonical.canonical_captures capture
    JOIN haetsal_canonical.canonical_documents document
      ON document.capture_id = capture.id AND document.tenant_id = capture.tenant_id
    JOIN haetsal_canonical.canonical_artifacts managed
      ON managed.id = capture.artifact_id AND managed.id = document.artifact_id
     AND managed.tenant_id = capture.tenant_id
    WHERE managed.storage_kind = 'managed_r2'
      AND managed.r2_key LIKE 'artifact-intake/v1/%'
      AND managed.role = 'source'
  )
  SELECT legacy.key, legacy.tenant_id, legacy.capture_id, legacy.legacy_role,
         legacy.legacy_artifact_count, legacy.eligible_legacy_source_count,
         managed.managed_primary_source_count
  FROM legacy_artifacts legacy
  JOIN managed_primary_sources managed
    ON managed.tenant_id = legacy.tenant_id AND managed.capture_id = legacy.capture_id`

export function exactManagedPrimarySourceReplacements(
  rows: LegacyManagedReplacementQueryRow[],
): LegacyManagedPrimarySourceReplacement[] {
  return rows.flatMap(row => (
    row.legacy_role === 'source' &&
    Number(row.legacy_artifact_count) === 1 &&
    Number(row.eligible_legacy_source_count) === 1 &&
    Number(row.managed_primary_source_count) === 1
  ) ? [{ key: row.key, tenantId: row.tenant_id, captureId: row.capture_id, role: 'source' }] : [])
}
