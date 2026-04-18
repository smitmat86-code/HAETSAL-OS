import type { Env } from '../types/env'

type FetchLike = {
  fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
}

type StartableFetchLike = FetchLike & {
  start?: () => Promise<void>
  startAndWaitForPorts?: (args: { ports: number | number[] }) => Promise<void>
}
const HINDSIGHT_CONTAINER_NAME = 'hindsight-api-shared-v4'
const HINDSIGHT_WORKER_PREFIX = 'hindsight-worker-v4'
const HINDSIGHT_ORIGIN = 'http://hindsight'
const HINDSIGHT_PORT = 8888
const HINDSIGHT_WORKER_PORT = 8889

function buildBankPath(bankId: string, suffix = ''): string {
  return `/v1/default/banks/${encodeURIComponent(bankId)}${suffix}`
}

export function jsonInit(method: string, body?: unknown): RequestInit {
  return {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  }
}

export function getHindsightStub(_scopeId: string, env: Env): StartableFetchLike {
  const binding = env.HINDSIGHT as DurableObjectNamespace | (FetchLike & {
    getByName?: (name: string) => StartableFetchLike
  })
  return getNamedContainerStub(binding, HINDSIGHT_CONTAINER_NAME)
}

function getNamedContainerStub(binding: DurableObjectNamespace | (FetchLike & {
  getByName?: (name: string) => StartableFetchLike
}), name: string): StartableFetchLike {
  if ('getByName' in binding && typeof binding.getByName === 'function') {
    return binding.getByName(name)
  }
  if ('idFromName' in binding && typeof binding.idFromName === 'function') {
    const id = binding.idFromName(name)
    return binding.get(id) as unknown as StartableFetchLike
  }
  return binding as StartableFetchLike
}

async function requestJson<T>(
  scopeId: string,
  env: Env,
  path: string,
  init?: RequestInit,
): Promise<T> {
  const stub = getHindsightStub(scopeId, env)
  if (typeof stub.startAndWaitForPorts === 'function') {
    await stub.startAndWaitForPorts({ ports: HINDSIGHT_PORT })
  } else if (typeof stub.start === 'function') {
    await stub.start()
  }
  const request = new Request(`${HINDSIGHT_ORIGIN}${path}`, init)
  const res = await stub.fetch(request)
  if (!res.ok) {
    const body = await res.text()
    throw new Error(`Hindsight request failed (${res.status}) ${path}: ${body.slice(0, 300)}`)
  }
  return await res.json() as T
}

async function request(
  scopeId: string,
  env: Env,
  path: string,
  init?: RequestInit,
): Promise<Response> {
  const stub = getHindsightStub(scopeId, env)
  if (typeof stub.startAndWaitForPorts === 'function') {
    await stub.startAndWaitForPorts({ ports: HINDSIGHT_PORT })
  } else if (typeof stub.start === 'function') {
    await stub.start()
  }
  const req = new Request(`${HINDSIGHT_ORIGIN}${path}`, init)
  return stub.fetch(req)
}

export async function resolveHindsightBankId(scopeId: string, env: Env): Promise<string> {
  const d1 = (env as Partial<Env>).D1_US
  if (!d1 || typeof d1.prepare !== 'function') return scopeId
  try {
    const row = await d1.prepare(
      'SELECT hindsight_tenant_id FROM tenants WHERE id = ?',
    ).bind(scopeId).first<{ hindsight_tenant_id: string | null }>()
    return row?.hindsight_tenant_id ?? scopeId
  } catch {
    return scopeId
  }
}

export async function requestBank(
  bankRef: string,
  env: Env,
  suffix: string,
  init?: RequestInit,
): Promise<Response> {
  const bankId = await resolveHindsightBankId(bankRef, env)
  return request(bankId, env, buildBankPath(bankId, suffix), init)
}

export async function requestBankJson<T>(
  bankRef: string,
  env: Env,
  suffix: string,
  init?: RequestInit,
): Promise<T> {
  const bankId = await resolveHindsightBankId(bankRef, env)
  return requestJson<T>(bankId, env, buildBankPath(bankId, suffix), init)
}

export async function prewarmHindsight(scopeId: string, env: Env): Promise<void> {
  const stub = getHindsightStub(scopeId, env)
  if (typeof stub.startAndWaitForPorts === 'function') {
    await stub.startAndWaitForPorts({ ports: HINDSIGHT_PORT })
  }
}

export async function ensureHindsightWorkersRunning(env: Env): Promise<void> {
  if (env.HINDSIGHT_DEDICATED_WORKERS_ENABLED?.trim().toLowerCase() !== 'true') return
  const count = Number.parseInt(env.HINDSIGHT_DEDICATED_WORKER_COUNT?.trim() ?? '0', 10)
  if (!Number.isFinite(count) || count <= 0) return
  const workerBinding = env.HINDSIGHT_WORKER as DurableObjectNamespace | (FetchLike & {
    getByName?: (name: string) => StartableFetchLike
  })

  const starts = Array.from({ length: count }, (_, index) => {
    const workerName = `${HINDSIGHT_WORKER_PREFIX}-${index + 1}`
    const stub = getNamedContainerStub(workerBinding, workerName)
    if (typeof stub.startAndWaitForPorts !== 'function') {
      return Promise.resolve()
    }
    return stub.startAndWaitForPorts({ ports: HINDSIGHT_WORKER_PORT })
  })

  const results = await Promise.allSettled(starts)
  const failures = results.filter((result) => result.status === 'rejected')
  if (failures.length === results.length) throw new Error('Failed to start all dedicated Hindsight workers')
}
