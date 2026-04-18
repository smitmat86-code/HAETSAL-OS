import type { Env } from '../types/env'
import type { HindsightDocumentSummary, HindsightMentalModelListResponse, HindsightMentalModelResponse, HindsightOperationStatusResponse, HindsightOperationsListResponse, HindsightRecallRequest, HindsightRecallResponse, HindsightReflectRequest, HindsightReflectResponse, HindsightRetainRequest, HindsightRetainResponse, HindsightWebhookListResponse } from '../types/hindsight'
import { createHindsightClient } from './hindsight-client'
import {
  ensureHindsightWorkersRunning,
  getHindsightStub,
  prewarmHindsight,
} from './hindsight-transport'

export { buildHindsightDocumentId, buildHindsightTags, buildRetainContext } from './hindsight-formatters'
export { createHindsightClient } from './hindsight-client'
export { ensureHindsightWorkersRunning, getHindsightStub, prewarmHindsight } from './hindsight-transport'

export async function retainMemory(
  bankId: string,
  body: HindsightRetainRequest,
  env: Env,
): Promise<HindsightRetainResponse> {
  return createHindsightClient(bankId, env).retain(body)
}

export async function recallMemory(
  bankId: string,
  body: HindsightRecallRequest,
  env: Env,
): Promise<HindsightRecallResponse> {
  return createHindsightClient(bankId, env).recall(body)
}

export async function updateBankConfiguration(
  bankId: string,
  body: Record<string, unknown>,
  env: Env,
): Promise<Response> {
  return createHindsightClient(bankId, env).updateBank(body)
}

export async function createMentalModel(
  bankId: string,
  body: Record<string, unknown>,
  env: Env,
): Promise<Response> {
  return createHindsightClient(bankId, env).createMentalModel(body)
}

export async function updateMentalModel(
  bankId: string,
  modelId: string,
  body: Record<string, unknown>,
  env: Env,
): Promise<Response> {
  return createHindsightClient(bankId, env).updateMentalModel(modelId, body)
}

export async function listMentalModels(
  bankId: string,
  env: Env,
): Promise<HindsightMentalModelListResponse> {
  return createHindsightClient(bankId, env).listMentalModels()
}

export async function fetchMentalModel(
  bankId: string,
  modelId: string,
  env: Env,
): Promise<HindsightMentalModelResponse | null> {
  return createHindsightClient(bankId, env).fetchMentalModel(modelId)
}

export async function listWebhooks(
  bankId: string,
  env: Env,
): Promise<HindsightWebhookListResponse> {
  return createHindsightClient(bankId, env).listWebhooks()
}

export async function createWebhook(
  bankId: string,
  body: Record<string, unknown>,
  env: Env,
): Promise<Response> {
  return createHindsightClient(bankId, env).createWebhook(body)
}

export async function reflectMemory<TStructured = unknown>(
  bankId: string,
  body: HindsightReflectRequest,
  env: Env,
): Promise<HindsightReflectResponse<TStructured>> {
  return createHindsightClient(bankId, env).reflect<TStructured>(body)
}

export async function listOperations(
  bankId: string,
  search: URLSearchParams,
  env: Env,
): Promise<HindsightOperationsListResponse> {
  return createHindsightClient(bankId, env).listOperations(search)
}

export async function getOperationStatus(
  bankId: string,
  operationId: string,
  env: Env,
): Promise<HindsightOperationStatusResponse> {
  return createHindsightClient(bankId, env).getOperationStatus(operationId)
}

export async function listMemories<TItem = unknown>(
  bankId: string,
  search: URLSearchParams,
  env: Env,
): Promise<{ memories: TItem[] }> {
  return createHindsightClient(bankId, env).listMemories<TItem>(search)
}

export async function fetchDocument(
  bankId: string,
  documentId: string,
  env: Env,
): Promise<HindsightDocumentSummary | null> {
  return createHindsightClient(bankId, env).fetchDocument(documentId)
}

export async function fetchMemoryHistory<TEntry = unknown>(
  bankId: string,
  memoryId: string,
  env: Env,
): Promise<{ history: TEntry[] } | null> {
  return createHindsightClient(bankId, env).fetchMemoryHistory<TEntry>(memoryId)
}

export async function fetchGraph<TNode = unknown, TEdge = unknown>(
  bankId: string,
  limit: number,
  env: Env,
): Promise<{ nodes: TNode[]; edges: TEdge[] } | null> {
  return createHindsightClient(bankId, env).fetchGraph<TNode, TEdge>(limit)
}
