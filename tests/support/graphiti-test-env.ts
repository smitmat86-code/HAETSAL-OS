import { env } from 'cloudflare:test'

export type GraphitiRequestRecord = Record<string, unknown>

type GraphitiStubOptions = {
  response?: (body: GraphitiRequestRecord) => Response | Promise<Response>
  startFails?: string
}

type StartableFetchLike = {
  fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
  startAndWaitForPorts: (args: { ports: number | number[] }) => Promise<void>
}

export function buildCompletedGraphitiResponse(body: GraphitiRequestRecord) {
  return {
    status: 'completed' as const,
    targetRef: `graphiti://episodes/${body.captureId}`,
    episodeRefs: [`graphiti://episodes/${body.captureId}`],
    entityRefs: ((body.plan as { entities?: Array<Record<string, unknown>> })?.entities ?? [])
      .map((_, index) => `graphiti://entities/${body.captureId}-${index}`),
    edgeRefs: ((body.plan as { edges?: Array<Record<string, unknown>> })?.edges ?? [])
      .map((_, index) => `graphiti://edges/${body.captureId}-${index}`),
    mappings: [
      {
        canonicalKey: (body.plan as { episode: { canonicalKey: string } }).episode.canonicalKey,
        graphRef: `graphiti://episodes/${body.captureId}`,
        graphKind: 'episode',
      },
      ...(((body.plan as { entities?: Array<Record<string, unknown>> })?.entities ?? [])
        .map((entity, index) => ({
          canonicalKey: String(entity.canonicalKey),
          graphRef: `graphiti://entities/${body.captureId}-${index}`,
          graphKind: 'entity',
        }))),
      ...(((body.plan as { edges?: Array<Record<string, unknown>> })?.edges ?? [])
        .map((edge, index) => ({
          canonicalKey: String(edge.canonicalKey),
          graphRef: `graphiti://edges/${body.captureId}-${index}`,
          graphKind: 'edge',
        }))),
    ],
  }
}

function createGraphitiContainerBinding(
  requests: GraphitiRequestRecord[],
  options: GraphitiStubOptions = {},
): { getByName: (_name: string) => StartableFetchLike } {
  return {
    getByName: () => ({
      startAndWaitForPorts: async () => {
        if (options.startFails) throw new Error(options.startFails)
      },
      fetch: async (input, init) => {
        const request = input instanceof Request ? input : new Request(String(input), init)
        const url = new URL(request.url)
        if (url.pathname === '/health') return Response.json({ status: 'ok', ready: !options.startFails })
        if (url.pathname === '/ready') return Response.json({ status: options.startFails ? 'starting' : 'ready', ready: !options.startFails })
        const body = await request.clone().json() as GraphitiRequestRecord
        requests.push(body)
        return options.response ? await options.response(body) : Response.json(buildCompletedGraphitiResponse(body))
      },
    }),
  }
}

export function createGraphitiContainerTestEnv(
  options: GraphitiStubOptions = {},
): { testEnv: typeof env; requests: GraphitiRequestRecord[] } {
  const requests: GraphitiRequestRecord[] = []
  return {
    requests,
    testEnv: {
      ...env,
      GRAPHITI_RUNTIME_MODE: 'container',
      GRAPHITI: createGraphitiContainerBinding(requests, options),
    } as typeof env,
  }
}
