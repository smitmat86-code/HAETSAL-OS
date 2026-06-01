import type { Env } from '../types/env'
import type { CanonicalBrokerTraceDetail } from '../types/canonical-memory-broker'
import { sha256Hex } from './canonical-memory-artifacts'
import { encryptContentForArchive } from './ingestion/encryption'

function brokerTraceR2Key(tenantId: string, queryId: string): string {
  return `broker-traces/${tenantId}/${queryId}.json.enc`
}

function intOrNull(value: number | null): number | null {
  return value === null ? null : Math.max(0, Math.trunc(value))
}

export async function persistCanonicalBrokerTrace(
  detail: CanonicalBrokerTraceDetail,
  env: Env,
  tmk: CryptoKey | null,
): Promise<void> {
  const plaintext = JSON.stringify(detail)
  const detailR2Key = tmk ? brokerTraceR2Key(detail.tenantId, detail.queryId) : null
  const detailSha256 = tmk ? await sha256Hex(plaintext) : null
  if (detailR2Key && tmk) {
    await env.R2_OBSERVABILITY.put(
      detailR2Key,
      await encryptContentForArchive(plaintext, tmk),
      { httpMetadata: { contentType: 'application/json' } },
    )
  }

  await env.D1_US.prepare(
    `INSERT OR REPLACE INTO canonical_broker_traces
     (id, tenant_id, query_text_sha256, requested_mode, primary_mode, primary_reason, primary_explicit,
      primary_status, primary_latency_ms, primary_projection_kind, primary_projection_ref, primary_capture_id,
      shadow_mode, shadow_status, shadow_latency_ms, shadow_projection_kind, shadow_projection_ref,
      shadow_capture_id, overlap, detail_r2_key, detail_sha256, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    detail.queryId,
    detail.tenantId,
    await sha256Hex(detail.queryText),
    detail.requestedMode ?? null,
    detail.route.mode,
    detail.route.reason,
    detail.route.explicit ? 1 : 0,
    detail.primary.status,
    intOrNull(detail.primary.latencyMs),
    detail.primary.projectionKind,
    detail.primary.projectionRef,
    detail.primary.captureId,
    detail.shadow.mode,
    detail.shadow.status,
    intOrNull(detail.shadow.latencyMs),
    detail.shadow.projectionKind,
    detail.shadow.projectionRef,
    detail.shadow.captureId,
    detail.overlap,
    detailR2Key,
    detailSha256,
    detail.createdAt,
    Date.now(),
  ).run()
}
