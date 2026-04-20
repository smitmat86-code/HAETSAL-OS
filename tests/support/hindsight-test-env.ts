import { env } from 'cloudflare:test'

export type HindsightOperationStatus = 'pending' | 'completed' | 'failed'
export type HindsightRecallRow = Record<string, unknown>

export type HindsightCaptureState = {
  retainCount: number
  operationIds: string[]
}

type HindsightOperationStatusSequence = HindsightOperationStatus[]

type CreateHindsightTestEnvOptions = {
  capture?: HindsightCaptureState
  failRecall?: boolean
  failRetain?: boolean
  operationStatus?: HindsightOperationStatus
  operationStatuses?: HindsightOperationStatusSequence
  recallResults?: HindsightRecallRow[]
}

function json(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    status: init?.status ?? 200,
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  })
}

export function createHindsightTestEnv(options: CreateHindsightTestEnvOptions = {}): typeof env {
  const {
    capture,
    failRecall = false,
    failRetain = false,
    operationStatus = 'completed',
    operationStatuses,
    recallResults = [],
  } = options
  const operationStatusById = new Map<string, { index: number }>()
  const documentTags = new Map<string, string[]>()

  function readOperationStatus(operationId: string): HindsightOperationStatus {
    if (!operationStatuses?.length) return operationStatus
    const state = operationStatusById.get(operationId) ?? { index: 0 }
    const next = operationStatuses[Math.min(state.index, operationStatuses.length - 1)] ?? operationStatus
    operationStatusById.set(operationId, { index: state.index + 1 })
    return next
  }

  return {
    ...env,
    HINDSIGHT_DEDICATED_WORKERS_ENABLED: 'false',
    WORKER_DOMAIN: 'haetsalos.specialdarksystems.com',
    HINDSIGHT_WEBHOOK_SECRET: 'test-secret',
    HINDSIGHT: {
      fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = input instanceof Request ? new URL(input.url) : new URL(input.toString())
        const method = input instanceof Request ? input.method : (init?.method ?? 'GET')
        const bankId = url.pathname.split('/')[4]

        if (/^\/v1\/default\/banks\/[^/]+$/.test(url.pathname)) {
          return json({ id: bankId, status: 'ok' })
        }

        if (/^\/v1\/default\/banks\/[^/]+\/mental-models$/.test(url.pathname)) {
          return method === 'GET' ? json({ items: [] }) : json({ status: 'ok' })
        }

        if (/^\/v1\/default\/banks\/[^/]+\/mental-models\/[^/]+$/.test(url.pathname)) {
          return json({ status: 'ok' })
        }

        if (/^\/v1\/default\/banks\/[^/]+\/webhooks$/.test(url.pathname)) {
          return method === 'GET' ? json({ items: [] }) : json({ status: 'ok' })
        }

        if (/^\/v1\/default\/banks\/[^/]+\/documents\/[^/]+$/.test(url.pathname)) {
          return json({
            id: url.pathname.split('/').at(-1),
            bank_id: bankId,
            memory_unit_count: 2,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          })
        }

        if (/^\/v1\/default\/banks\/[^/]+\/operations\/[^/]+$/.test(url.pathname)) {
          const operationId = url.pathname.split('/').at(-1)
          const status = readOperationStatus(String(operationId))
          return json({
            operation_id: operationId,
            status,
            operation_type: 'retain',
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            completed_at: status === 'completed' || status === 'failed'
              ? new Date().toISOString()
              : null,
            error_message: status === 'failed' ? 'adapter submission failed' : null,
          })
        }

        if (/^\/v1\/default\/banks\/[^/]+\/memories$/.test(url.pathname)) {
          if (failRetain) return json({ detail: 'retain failed' }, { status: 500 })
          const request = input instanceof Request ? input : new Request(input.toString(), init)
          const body = await request.clone().json() as {
            async?: boolean
            items: Array<{ document_id: string; tags?: string[] }>
          }
          const operationId = `op-${crypto.randomUUID()}`
          if (capture) {
            capture.retainCount += 1
            if (body.async) capture.operationIds.push(operationId)
          }
          for (const item of body.items ?? []) {
            if (item.document_id) documentTags.set(item.document_id, item.tags ?? [])
          }
          return json({
            success: true,
            bank_id: bankId,
            items_count: 1,
            async: body.async ?? false,
            operation_id: body.async ? operationId : undefined,
          })
        }

        if (/^\/v1\/default\/banks\/[^/]+\/memories\/recall$/.test(url.pathname)) {
          if (failRecall) return json({ detail: 'semantic recall unavailable' }, { status: 503 })
          const request = input instanceof Request ? input : new Request(input.toString(), init)
          const body = await request.clone().json() as {
            tags?: string[]
            tags_match?: 'all_strict' | 'any' | string
          }
          const requestedTags = body.tags ?? []
          const filteredResults = recallResults.filter(raw => {
            if (!requestedTags.length) return true
            const rowTags = Array.isArray(raw.tags)
              ? raw.tags.filter((tag): tag is string => typeof tag === 'string')
              : documentTags.get(String(raw.document_id ?? raw.source_document_id ?? '')) ?? []
            if (!rowTags.length) return false
            if (body.tags_match === 'all_strict') {
              return rowTags.length === requestedTags.length
                && requestedTags.every(tag => rowTags.includes(tag))
            }
            if (body.tags_match === 'any') {
              return requestedTags.some(tag => rowTags.includes(tag))
            }
            return requestedTags.every(tag => rowTags.includes(tag))
          })
          return json({
            results: filteredResults,
            text: `Found ${filteredResults.length} semantic memories.`,
          })
        }

        if (/^\/v1\/default\/banks\/[^/]+\/reflect$/.test(url.pathname)) {
          return json({ text: 'Stub reflect response' })
        }

        return json({ status: 'ok' })
      },
    },
  } as typeof env
}
