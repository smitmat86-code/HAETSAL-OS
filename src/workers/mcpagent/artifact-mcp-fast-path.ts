import type { Env } from '../../types/env'
import { deriveTmk } from '../../middleware/auth'
import type { ArtifactIntakeToolContext } from '../../tools/artifact-intake-tool-contracts'
import { handleChatGptArtifactFile } from '../../tools/artifact-intake-chatgpt'

interface JsonRpcRequest {
  jsonrpc?: unknown
  id?: unknown
  method?: unknown
  params?: { name?: unknown; arguments?: unknown }
}

interface ArtifactMcpIdentity {
  tenantId: string
  jwtSub: string
  clientName: string | null
  agentIdentity: string | null
  actorKind: 'human' | 'service'
}

function singleRequest(value: unknown): { request: JsonRpcRequest; batched: boolean } | null {
  if (Array.isArray(value)) {
    if (value.length !== 1 || !value[0] || typeof value[0] !== 'object') return null
    return { request: value[0] as JsonRpcRequest, batched: true }
  }
  if (!value || typeof value !== 'object') return null
  return { request: value as JsonRpcRequest, batched: false }
}

function containsCaptureCall(value: unknown): boolean {
  const values = Array.isArray(value) ? value : [value]
  return values.some(candidate => {
    if (!candidate || typeof candidate !== 'object') return false
    const request = candidate as JsonRpcRequest
    return request.method === 'tools/call' && request.params?.name === 'capture_artifact_file'
  })
}

function invalidRequestResponse(): Response {
  return new Response(JSON.stringify({
    jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' },
  }), {
    status: 200,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  })
}

/**
 * Keeps hosted file descriptors in the original POST body. The Agents SDK
 * otherwise forwards tool arguments to its Durable Object in cf-mcp-message,
 * which makes temporary URLs and provider IDs visible to platform request logs.
 */
export async function tryHandleArtifactMcpFastPath(
  request: Request,
  env: Env,
  identity: ArtifactMcpIdentity,
  overrides: Pick<ArtifactIntakeToolContext, 'downloadHostedFile'> = {},
): Promise<Response | null> {
  if (request.method !== 'POST') return null
  let parsed: unknown
  try {
    parsed = await request.clone().json()
  } catch {
    return invalidRequestResponse()
  }
  const candidate = singleRequest(parsed)
  if (
    !candidate
    || candidate.request.method !== 'tools/call'
    || candidate.request.params?.name !== 'capture_artifact_file'
  ) return containsCaptureCall(parsed) ? invalidRequestResponse() : null
  if (candidate.request.id === undefined) return invalidRequestResponse()

  const tmk = await deriveTmk(identity.jwtSub, env.CF_ACCESS_AUD)
  const clientName = identity.clientName ?? (identity.actorKind === 'human' ? 'ChatGPT' : null)
  const agentIdentity = identity.agentIdentity ?? (identity.actorKind === 'human' ? 'chatgpt-developer-mode' : null)
  const result = await handleChatGptArtifactFile(candidate.request.params?.arguments, {
    getEnv: () => env,
    getTenantId: () => identity.tenantId,
    getTmk: () => tmk,
    getClientIdentity: () => ({ clientName, agentIdentity }),
    ...overrides,
  })
  const response = {
    jsonrpc: '2.0',
    id: candidate.request.id,
    result,
  }
  return new Response(JSON.stringify(candidate.batched ? [response] : response), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    },
  })
}
