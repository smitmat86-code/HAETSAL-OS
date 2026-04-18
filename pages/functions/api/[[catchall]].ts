export const onRequest: PagesFunction<{ WORKER_URL: string }> = async (context) => {
  try {
    const workerUrl = context.env.WORKER_URL
    if (!workerUrl) {
      return new Response(JSON.stringify({ error: 'WORKER_URL not set' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      })
    }

    const target = new URL(context.request.url)
    const parsed = new URL(workerUrl.trim())
    target.protocol = parsed.protocol
    target.host = parsed.host

    // Forward ALL headers except hop-by-hop ones
    const headers = new Headers()
    const skip = new Set(['host', 'connection', 'keep-alive', 'transfer-encoding', 'te', 'upgrade'])
    for (const [key, value] of context.request.headers.entries()) {
      if (!skip.has(key.toLowerCase())) {
        headers.set(key, value)
      }
    }

    // CF Access on the Worker domain strips CF-Access-Jwt-Assertion on bypass routes.
    // Copy it to a custom header the Worker can read as a fallback.
    const jwt = context.request.headers.get('cf-access-jwt-assertion')
    if (jwt) {
      headers.set('X-Forwarded-Access-Jwt', jwt)
    }

    const init: RequestInit = {
      method: context.request.method,
      headers,
      redirect: 'manual',
    }
    if (!['GET', 'HEAD'].includes(context.request.method)) {
      init.body = context.request.body
    }

    const resp = await fetch(target.toString(), init)

    return new Response(resp.body, {
      status: resp.status,
      headers: {
        'content-type': resp.headers.get('content-type') || 'application/json',
        'access-control-allow-origin': '*',
      },
    })
  } catch (err: unknown) {
    const message = err instanceof Error ? `${err.message}\n${err.stack}` : String(err)
    return new Response(JSON.stringify({ error: 'Proxy error', detail: message }), {
      status: 502,
      headers: { 'Content-Type': 'application/json' },
    })
  }
}


