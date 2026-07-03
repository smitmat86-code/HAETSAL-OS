import type { Env } from '../types/env'
import type {
  CanonicalBrokeredSearchResult,
  CanonicalBrokerTraceDetail,
} from '../types/canonical-memory-broker'
import type { CanonicalSearchInput } from '../types/canonical-memory-query'
import { overlapOf, runShadowWithTimeout, shadowModeFor, shadowQueryOf, summaryOf, traceOf } from './canonical-broker-shadow'
import { persistCanonicalBrokerTrace } from './canonical-broker-trace'
import { getCanonicalGovernanceStore } from './canonical-governance-postgres'
import { sha256Hex } from './canonical-memory-artifacts'
import { executeCanonicalMemoryMode } from './canonical-memory-dispatch'
import { decideCanonicalMemoryRoute } from './canonical-memory-router'
import { type CanonicalMemoryReadOptions } from './canonical-memory-read-model'
import { applyCanonicalRoute } from './canonical-source-attribution'

export async function searchCanonicalMemoryWithBroker(
  input: CanonicalSearchInput,
  env: Env,
  tenantId: string,
  options: CanonicalMemoryReadOptions = {},
): Promise<CanonicalBrokeredSearchResult> {
  const queryId = crypto.randomUUID()
  const route = decideCanonicalMemoryRoute(input.query, input.mode)
  const shadowMode = shadowModeFor(route.mode)
  const primaryInput = { ...input, mode: route.mode, query: route.dispatchQuery }
  const primaryStartedAt = Date.now()
  const primaryRaw = await executeCanonicalMemoryMode(primaryInput, env, tenantId, options)
  const primary = applyCanonicalRoute(primaryRaw, route)
  const primaryTrace = traceOf(route.mode, Date.now() - primaryStartedAt, primary)
  const broker = {
    queryId,
    primaryMode: route.mode,
    shadowMode,
    shadowDispatch: shadowMode ? 'scheduled' as const : 'skipped' as const,
  }

  const persist = async (): Promise<void> => {
    const shadowQuery = shadowMode
      ? shadowQueryOf(input.query, route.mode, route.dispatchQuery)
      : null
    const shadowInput = shadowMode
      ? { ...input, mode: shadowMode, query: shadowQuery ?? route.dispatchQuery }
      : null
    const shadowRun = shadowInput
      ? await runShadowWithTimeout(shadowInput, env, tenantId, options)
      : { result: null, latencyMs: null, status: 'skipped' as const, errorMessage: null }
    const shadowTrace = shadowInput
      ? traceOf(shadowMode, shadowRun.latencyMs, shadowRun.result, shadowRun.errorMessage, shadowRun.status)
      : traceOf(null, null, null, null, 'skipped')
    const detail: CanonicalBrokerTraceDetail = {
      queryId,
      tenantId,
      queryText: input.query,
      requestedMode: input.mode ?? null,
      route,
      primary: primaryTrace,
      shadow: shadowTrace,
      overlap: overlapOf(primary, shadowRun.result),
      surfaced: {
        mode: primary.mode,
        status: primary.status,
        summary: summaryOf(primary.items),
        itemCount: primary.items.length,
      },
      createdAt: Date.now(),
    }
    await persistCanonicalBrokerTrace(detail, env, options.tmk ?? null)
    // Canonical recall trace (Phase 2): query + result refs recorded in the
    // canonical ledger (Postgres is the authorized content surface).
    await getCanonicalGovernanceStore(env).insertRecallTrace({
      id: queryId,
      tenant_id: tenantId,
      query_mode: route.mode,
      query_hash: await sha256Hex(input.query),
      request_json: JSON.stringify({ query: input.query, requestedMode: input.mode ?? null, scope: input.scope ?? null }),
      result_refs_json: JSON.stringify(primary.items.map((item) => ({
        captureId: item.captureId,
        documentId: item.documentId,
        mode: item.mode,
        score: item.score ?? null,
      }))),
      created_at: Date.now(),
    }).catch((error) => {
      console.warn('CANONICAL_RECALL_TRACE_FAILED', {
        tenantId,
        queryId,
        error: error instanceof Error ? error.message : String(error),
      })
    })
  }

  if (options.executionContext?.waitUntil) {
    options.executionContext.waitUntil(persist().catch((error) => {
      console.warn('CANONICAL_BROKER_TRACE_PERSIST_FAILED', {
        tenantId,
        queryId,
        error: error instanceof Error ? error.message : String(error),
      })
    }))
  } else {
    void persist().catch((error) => {
      console.warn('CANONICAL_BROKER_TRACE_PERSIST_FAILED', {
        tenantId,
        queryId,
        error: error instanceof Error ? error.message : String(error),
      })
    })
  }

  return { result: { ...primary, broker }, broker }
}
