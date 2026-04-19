import { env } from 'cloudflare:test'

export type HindsightOperationStatus = 'pending' | 'completed' | 'failed'
export type HindsightRecallRow = Record<string, unknown>

export type HindsightCaptureState = {
  retainCount: number
  operationIds: string[]
}

type CreateHindsightTestEnvOptions = {
  capture?: HindsightCaptureState
  failRecall?: boolean
  failRetain?: boolean
  operationStatus?: HindsightOperationStatus
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
    recallResults = [],
  } = options

  return {
    ...env,
    HINDSIGHT_DEDICATED_WORKERS_ENABLED: 'false',
    WORKER_DOMAIN: 'brain.workers.dev',
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
          return json({
            operation_id: operationId,
            status: operationStatus,
            operation_type: 'retain',
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            completed_at: operationStatus === 'completed' || operationStatus === 'failed'
              ? new Date().toISOString()
              : null,
            error_message: operationStatus === 'failed' ? 'adapter submission failed' : null,
          })
        }

        if (/^\/v1\/default\/banks\/[^/]+\/memories$/.test(url.pathname)) {
          if (failRetain) return json({ detail: 'retain failed' }, { status: 500 })
          const request = input instanceof Request ? input : new Request(input.toString(), init)
          const body = await request.clone().json() as { items: Array<{ document_id: string }> }
          const operationId = `op-${body.items[0]!.document_id}`
          if (capture) {
            capture.retainCount += 1
            capture.operationIds.push(operationId)
          }
          return json({
            success: true,
            bank_id: bankId,
            items_count: 1,
            async: true,
            operation_id: operationId,
          })
        }

        if (/^\/v1\/default\/banks\/[^/]+\/memories\/recall$/.test(url.pathname)) {
          if (failRecall) return json({ detail: 'semantic recall unavailable' }, { status: 503 })
          return json({
            results: recallResults,
            text: `Found ${recallResults.length} semantic memories.`,
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
