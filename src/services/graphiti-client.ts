import type { GraphitiProjectionSubmissionResult } from '../types/canonical-graph-projection'
import type { Env } from '../types/env'

type GraphitiRuntimeMode = 'container' | 'external'
type FetchLike = { fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> }
type StartableFetchLike = FetchLike & {
  start?: () => Promise<void>
  startAndWaitForPorts?: (args: { ports: number | number[] }) => Promise<void>
}

export interface InternalGraphitiProjectionRequest {
  tenantId: string
  projectionJobId: string
  captureId: string
  operationId: string
  documentId: string
  posture: string
  plan: Record<string, unknown>
  content: { body: string }
}

const GRAPHITI_CONTAINER_NAME = 'graphiti-runtime-shared-v1'
const GRAPHITI_ORIGIN = 'http://graphiti'
const GRAPHITI_PORT = 8000

function buildTargetRef(response: Partial<GraphitiProjectionSubmissionResult>): string {
  return response.targetRef?.trim()
    || response.operationRef?.trim()
    || response.episodeRefs?.[0]
    || response.mappings?.[0]?.graphRef
    || 'graphiti://episodes/pending'
}

function normalizeGraphitiResponse(
  response: Partial<GraphitiProjectionSubmissionResult>,
): GraphitiProjectionSubmissionResult {
  return {
    targetRef: buildTargetRef(response),
    status: response.status === 'queued' ? 'queued' : 'completed',
    operationRef: response.operationRef ?? null,
    episodeRefs: response.episodeRefs ?? [],
    entityRefs: response.entityRefs ?? [],
    edgeRefs: response.edgeRefs ?? [],
    mappings: response.mappings ?? [],
  }
}

export function resolveGraphitiRuntimeMode(
  env: Pick<Env, 'GRAPHITI_RUNTIME_MODE'>,
): GraphitiRuntimeMode {
  return env.GRAPHITI_RUNTIME_MODE?.trim().toLowerCase() === 'external'
    ? 'external'
    : 'container'
}

function getGraphitiContainerStub(env: Env): StartableFetchLike {
  const binding = env.GRAPHITI as unknown as
    | StartableFetchLike
    | FetchLike
    | DurableObjectNamespace
    | { getByName?: (name: string) => StartableFetchLike }
    | ((input: RequestInfo | URL, init?: RequestInit) => Promise<Response>)
  if (!binding) throw new Error('GRAPHITI service binding is required when GRAPHITI_RUNTIME_MODE=container')
  if (typeof binding === 'function') {
    return { fetch: binding }
  }
  if (typeof (binding as FetchLike).fetch === 'function') {
    return binding as StartableFetchLike
  }
  if (typeof (binding as { getByName?: (name: string) => StartableFetchLike }).getByName === 'function') {
    return (binding as { getByName: (name: string) => StartableFetchLike }).getByName(GRAPHITI_CONTAINER_NAME)
  }
  if (typeof (binding as DurableObjectNamespace).idFromName === 'function') {
    const namespace = binding as DurableObjectNamespace
    return namespace.get(namespace.idFromName(GRAPHITI_CONTAINER_NAME)) as unknown as StartableFetchLike
  }
  throw new Error('GRAPHITI binding is not fetchable')
}

async function requestGraphitiContainerJson<T>(
  path: string,
  init: RequestInit | undefined,
  env: Env,
): Promise<T> {
  const stub = getGraphitiContainerStub(env)
  if (typeof stub.startAndWaitForPorts === 'function') {
    await stub.startAndWaitForPorts({ ports: GRAPHITI_PORT })
  } else if (typeof stub.start === 'function') {
    await stub.start()
  }
  const response = await stub.fetch(new Request(`${GRAPHITI_ORIGIN}${path}`, init))
  if (!response.ok) throw new Error(`Graphiti container request failed (${response.status}) ${path}: ${await response.text()}`)
  return await response.json() as T
}

async function requestExternalGraphitiJson<T>(
  path: string,
  init: RequestInit | undefined,
  env: Env,
): Promise<T> {
  const baseUrl = env.GRAPHITI_API_URL?.trim()
  if (!baseUrl) throw new Error('GRAPHITI_API_URL is required when GRAPHITI_RUNTIME_MODE=external')
  const response = await fetch(`${baseUrl.replace(/\/$/, '')}${path}`, {
    ...init,
    headers: {
      ...(init?.headers ?? {}),
      Authorization: env.GRAPHITI_API_TOKEN?.trim()
        ? `Bearer ${env.GRAPHITI_API_TOKEN.trim()}`
        : '',
    },
  })
  if (!response.ok) throw new Error(`Graphiti external request failed (${response.status}) ${path}: ${await response.text()}`)
  return await response.json() as T
}

export async function submitCanonicalGraphitiProjection(
  payload: InternalGraphitiProjectionRequest,
  env: Env,
): Promise<GraphitiProjectionSubmissionResult> {
  const init = {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  }
  const response = resolveGraphitiRuntimeMode(env) === 'external'
    ? await requestExternalGraphitiJson<Partial<GraphitiProjectionSubmissionResult>>('/v1/canonical/projections', init, env)
    : await requestGraphitiContainerJson<Partial<GraphitiProjectionSubmissionResult>>('/v1/canonical/projections', init, env)
  return normalizeGraphitiResponse(response)
}

export async function healthcheckGraphitiRuntime(env: Env): Promise<{ status: string; ready?: boolean }> {
  return resolveGraphitiRuntimeMode(env) === 'external'
    ? await requestExternalGraphitiJson<{ status: string; ready?: boolean }>('/health', undefined, env)
    : await requestGraphitiContainerJson<{ status: string; ready?: boolean }>('/health', undefined, env)
}
