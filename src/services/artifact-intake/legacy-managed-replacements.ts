import type {
  LegacyManagedPrimarySourceReplacement,
  LegacyManagedReplacementQueryRow,
} from './legacy-inventory-types'

export const LEGACY_MANAGED_REPLACEMENT_CANDIDATES_SQL = `
  WITH legacy_sources AS (
    SELECT r2_key AS key, tenant_id, capture_id,
           COUNT(*) OVER (PARTITION BY tenant_id, capture_id) AS eligible_legacy_source_count
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
  SELECT legacy.key, legacy.tenant_id, legacy.capture_id,
         legacy.eligible_legacy_source_count, managed.managed_primary_source_count
  FROM legacy_sources legacy
  JOIN managed_primary_sources managed
    ON managed.tenant_id = legacy.tenant_id AND managed.capture_id = legacy.capture_id`

export function exactManagedPrimarySourceReplacements(
  rows: LegacyManagedReplacementQueryRow[],
): LegacyManagedPrimarySourceReplacement[] {
  return rows.flatMap(row => (
    Number(row.eligible_legacy_source_count) === 1 &&
    Number(row.managed_primary_source_count) === 1
  ) ? [{ key: row.key, tenantId: row.tenant_id, captureId: row.capture_id }] : [])
}
