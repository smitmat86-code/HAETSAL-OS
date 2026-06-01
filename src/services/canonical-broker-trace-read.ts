import type { Env } from '../types/env'
import type {
  CanonicalBrokerTraceInput,
  CanonicalBrokerTraceListInput,
  CanonicalBrokerTraceListResult,
  CanonicalBrokerTraceView,
} from '../types/canonical-memory-broker'
import { clampCanonicalLimit, type CanonicalMemoryReadOptions } from './canonical-memory-read-model'
import {
  BROKER_TRACE_SELECT,
  type CanonicalBrokerTraceRow,
  listItemFromView,
  readTraceView,
} from './canonical-broker-trace-view'

async function getBrokerTraceRow(
  env: Env,
  tenantId: string,
  queryId: string,
): Promise<CanonicalBrokerTraceRow> {
  const row = await env.D1_US.prepare(
    BROKER_TRACE_SELECT + `
     WHERE tenant_id = ? AND id = ?`,
  ).bind(tenantId, queryId).first<CanonicalBrokerTraceRow>()
  if (!row) throw new Error(`Broker trace not found: ${queryId}`)
  return row
}

export async function listRecentCanonicalBrokerTraces(
  input: CanonicalBrokerTraceListInput,
  env: Env,
  tenantId: string,
  options: CanonicalMemoryReadOptions = {},
): Promise<CanonicalBrokerTraceListResult> {
  const limit = clampCanonicalLimit(input.limit, 10, 25)
  const mode = input.mode ?? null
  const query = mode
    ? `${BROKER_TRACE_SELECT}
       WHERE tenant_id = ? AND primary_mode = ?
       ORDER BY created_at DESC
       LIMIT ?`
    : `${BROKER_TRACE_SELECT}
       WHERE tenant_id = ?
       ORDER BY created_at DESC
       LIMIT ?`
  const statement = mode
    ? env.D1_US.prepare(query).bind(tenantId, mode, limit)
    : env.D1_US.prepare(query).bind(tenantId, limit)
  const rows = await statement.all<CanonicalBrokerTraceRow>()
  const items = await Promise.all((rows.results ?? []).map(async (row) =>
    listItemFromView(await readTraceView(row, env, options))))
  return { items }
}

export async function getCanonicalBrokerTrace(
  input: CanonicalBrokerTraceInput,
  env: Env,
  tenantId: string,
  options: CanonicalMemoryReadOptions = {},
): Promise<CanonicalBrokerTraceView> {
  return readTraceView(await getBrokerTraceRow(env, tenantId, input.queryId), env, options)
}
