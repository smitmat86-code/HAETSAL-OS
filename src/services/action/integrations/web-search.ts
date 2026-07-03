// src/services/action/integrations/web-search.ts
// Real web search via the Brave Search API (first-party key in Secrets Store).
// READ capability class — no side effects, auto-GREEN. Results are metadata
// (titles, URLs, snippets); no page content is fetched or persisted here.

import type { Env } from '../../../types/env'

const BRAVE_ENDPOINT = 'https://api.search.brave.com/res/v1/web/search'

export interface WebSearchHit {
  title: string
  url: string
  description: string
}

export interface WebSearchResult {
  query: string
  hits: WebSearchHit[]
}

interface BraveResponse {
  web?: { results?: Array<{ title?: string; url?: string; description?: string }> }
}

/** Execute a Brave web search. Throws on transport/auth failure so the action
 *  layer records a real failure (never a silent empty result). */
export async function executeWebSearch(
  query: string,
  env: Env,
  options?: { maxResults?: number; domain?: string },
): Promise<WebSearchResult> {
  if (!env.BRAVE_API_KEY?.trim()) {
    throw new Error('web search unavailable: BRAVE_API_KEY not configured')
  }
  const count = Math.min(Math.max(options?.maxResults ?? 5, 1), 20)
  const q = options?.domain ? `site:${options.domain} ${query}` : query
  const url = `${BRAVE_ENDPOINT}?q=${encodeURIComponent(q)}&count=${count}`

  const res = await fetch(url, {
    headers: {
      Accept: 'application/json',
      'Accept-Encoding': 'gzip',
      'X-Subscription-Token': env.BRAVE_API_KEY,
    },
  })
  if (!res.ok) {
    throw new Error(`Brave search error: ${res.status}`)
  }
  const body = (await res.json()) as BraveResponse
  const hits: WebSearchHit[] = (body.web?.results ?? []).slice(0, count).map((r) => ({
    title: r.title ?? '',
    url: r.url ?? '',
    description: (r.description ?? '').replace(/<[^>]+>/g, ''),
  }))
  return { query: q, hits }
}
