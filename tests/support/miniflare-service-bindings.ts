export function buildMiniflareServiceBindings() {
  return {
    HINDSIGHT: (request: Request) => {
      const url = new URL(request.url)
      const requestPath = url.pathname

      if (/^\/v1\/default\/banks\/[^/]+\/memories$/.test(requestPath)) {
        return new Response(
          JSON.stringify({
            success: true,
            bank_id: requestPath.split('/')[4],
            items_count: 1,
            async: false,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        )
      }

      if (/^\/v1\/default\/banks\/[^/]+\/operations\/[^/]+$/.test(requestPath)) {
        return new Response(
          JSON.stringify({
            operation_id: requestPath.split('/')[6],
            status: 'completed',
            operation_type: 'retain',
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            completed_at: new Date().toISOString(),
            error_message: null,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        )
      }

      if (/^\/v1\/default\/banks\/[^/]+\/memories\/recall$/.test(requestPath)) {
        return new Response(
          JSON.stringify({
            results: [{
              id: crypto.randomUUID(),
              text: 'Stub memory result',
              type: 'experience',
              confidence: 0.8,
              relevance: 0.8,
            }],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        )
      }

      if (/^\/v1\/default\/banks\/[^/]+\/mental-models/.test(requestPath)) {
        return new Response(
          JSON.stringify({ content: 'Stub mental model' }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        )
      }

      if (/^\/v1\/default\/banks\/[^/]+\/webhooks$/.test(requestPath) && request.method === 'GET') {
        return new Response(
          JSON.stringify({ items: [] }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        )
      }

      if (/^\/v1\/default\/banks\/[^/]+\/reflect$/.test(requestPath)) {
        return new Response(
          JSON.stringify({ text: 'Stub reflect response' }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        )
      }

      return new Response(
        JSON.stringify({ status: 'ok' }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      )
    },
    GRAPHITI: async (request: Request) => {
      const url = new URL(request.url)
      if (url.pathname === '/health' || url.pathname === '/ready') {
        return new Response(
          JSON.stringify({ status: 'ok', ready: true }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        )
      }
      const body = await request.clone().json() as Record<string, any>
      const entities = body.plan?.entities ?? []
      const edges = body.plan?.edges ?? []
      return new Response(
        JSON.stringify({
          status: 'completed',
          targetRef: `graphiti://episodes/${body.captureId}`,
          episodeRefs: [`graphiti://episodes/${body.captureId}`],
          entityRefs: entities.map((_: unknown, index: number) => `graphiti://entities/${body.captureId}-${index}`),
          edgeRefs: edges.map((_: unknown, index: number) => `graphiti://edges/${body.captureId}-${index}`),
          mappings: [
            {
              canonicalKey: body.plan?.episode?.canonicalKey,
              graphRef: `graphiti://episodes/${body.captureId}`,
              graphKind: 'episode',
            },
            ...entities.map((entity: Record<string, unknown>, index: number) => ({
              canonicalKey: entity.canonicalKey,
              graphRef: `graphiti://entities/${body.captureId}-${index}`,
              graphKind: 'entity',
            })),
            ...edges.map((edge: Record<string, unknown>, index: number) => ({
              canonicalKey: edge.canonicalKey,
              graphRef: `graphiti://edges/${body.captureId}-${index}`,
              graphKind: 'edge',
            })),
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      )
    },
  }
}
