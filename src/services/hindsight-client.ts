import type { Env } from '../types/env'
import type {
  HindsightDocumentSummary,
  HindsightMentalModelResponse,
  HindsightMentalModelListResponse,
  HindsightOperationStatusResponse,
  HindsightOperationsListResponse,
  HindsightRecallRequest,
  HindsightRecallResponse,
  HindsightReflectRequest,
  HindsightReflectResponse,
  HindsightRetainRequest,
  HindsightRetainResponse,
  HindsightWebhookListResponse,
} from '../types/hindsight'
import { jsonInit, requestBank, requestBankJson } from './hindsight-transport'

export class HindsightClient {
  constructor(
    private readonly bankRef: string,
    private readonly env: Env,
  ) {}

  retain(body: HindsightRetainRequest): Promise<HindsightRetainResponse> {
    return requestBankJson<HindsightRetainResponse>(this.bankRef, this.env, '/memories', jsonInit('POST', body))
  }

  recall(body: HindsightRecallRequest): Promise<HindsightRecallResponse> {
    return requestBankJson<HindsightRecallResponse>(this.bankRef, this.env, '/memories/recall', jsonInit('POST', body))
  }

  reflect<TStructured = unknown>(body: HindsightReflectRequest): Promise<HindsightReflectResponse<TStructured>> {
    return requestBankJson<HindsightReflectResponse<TStructured>>(this.bankRef, this.env, '/reflect', jsonInit('POST', body))
  }

  updateBank(body: Record<string, unknown>): Promise<Response> {
    return requestBank(this.bankRef, this.env, '', jsonInit('PUT', body))
  }

  createMentalModel(body: Record<string, unknown>): Promise<Response> {
    return requestBank(this.bankRef, this.env, '/mental-models', jsonInit('POST', body))
  }

  updateMentalModel(modelId: string, body: Record<string, unknown>): Promise<Response> {
    return requestBank(
      this.bankRef,
      this.env,
      `/mental-models/${encodeURIComponent(modelId)}`,
      jsonInit('PATCH', body),
    )
  }

  async fetchMentalModel(modelId: string): Promise<HindsightMentalModelResponse | null> {
    const res = await requestBank(this.bankRef, this.env, `/mental-models/${encodeURIComponent(modelId)}`)
    if (!res.ok) return null
    return await res.json() as HindsightMentalModelResponse
  }

  listMentalModels(): Promise<HindsightMentalModelListResponse> {
    return requestBankJson<HindsightMentalModelListResponse>(this.bankRef, this.env, '/mental-models')
  }

  listWebhooks(): Promise<HindsightWebhookListResponse> {
    return requestBankJson<HindsightWebhookListResponse>(this.bankRef, this.env, '/webhooks')
  }

  createWebhook(body: Record<string, unknown>): Promise<Response> {
    return requestBank(this.bankRef, this.env, '/webhooks', jsonInit('POST', body))
  }

  listOperations(search: URLSearchParams): Promise<HindsightOperationsListResponse> {
    const suffix = search.toString() ? `/operations?${search.toString()}` : '/operations'
    return requestBankJson<HindsightOperationsListResponse>(this.bankRef, this.env, suffix)
  }

  getOperationStatus(operationId: string): Promise<HindsightOperationStatusResponse> {
    return requestBankJson<HindsightOperationStatusResponse>(
      this.bankRef,
      this.env,
      `/operations/${encodeURIComponent(operationId)}`,
    )
  }

  listMemories<TItem = unknown>(search: URLSearchParams): Promise<{ memories: TItem[] }> {
    const suffix = search.toString() ? `/memories/list?${search.toString()}` : '/memories/list'
    return requestBankJson<{ memories: TItem[] }>(this.bankRef, this.env, suffix)
  }

  async fetchDocument(documentId: string): Promise<HindsightDocumentSummary | null> {
    const res = await requestBank(this.bankRef, this.env, `/documents/${encodeURIComponent(documentId)}`)
    if (res.status === 404) return null
    if (!res.ok) {
      const body = await res.text()
      throw new Error(`Hindsight document lookup failed (${res.status}) ${documentId}: ${body.slice(0, 300)}`)
    }
    return await res.json() as HindsightDocumentSummary
  }

  async fetchMemoryHistory<TEntry = unknown>(memoryId: string): Promise<{ history: TEntry[] } | null> {
    const res = await requestBank(this.bankRef, this.env, `/memories/${encodeURIComponent(memoryId)}/history`)
    if (!res.ok) return null
    return await res.json() as { history: TEntry[] }
  }

  async fetchGraph<TNode = unknown, TEdge = unknown>(limit: number): Promise<{ nodes: TNode[]; edges: TEdge[] } | null> {
    const res = await requestBank(this.bankRef, this.env, `/graph?limit=${limit}`)
    if (!res.ok) return null
    return await res.json() as { nodes: TNode[]; edges: TEdge[] }
  }
}

export function createHindsightClient(bankRef: string, env: Env): HindsightClient {
  return new HindsightClient(bankRef, env)
}
