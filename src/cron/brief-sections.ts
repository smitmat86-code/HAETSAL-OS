// src/cron/brief-sections.ts
// Morning brief section fetchers — each returns string, '' = omit section
// Extracted from morning-brief.ts for postflight line limit

import type { Env } from '../types/env'
import { recallViaService } from '../tools/recall'
import { getGoogleToken } from '../services/google/oauth'

const CALENDAR_API = 'https://www.googleapis.com/calendar/v3/calendars/primary/events'

export async function fetchCalendar(tenantId: string, kek: CryptoKey, env: Env): Promise<string> {
  const token = await getGoogleToken(tenantId, 'calendar', kek, env)
  if (!token) return '_No calendar connected_'
  const today = new Date(); today.setHours(0, 0, 0, 0)
  const tomorrow = new Date(today.getTime() + 86_400_000)
  const url = `${CALENDAR_API}?timeMin=${today.toISOString()}&timeMax=${tomorrow.toISOString()}&singleEvents=true&orderBy=startTime`
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } })
  if (!res.ok) return '_Calendar unavailable_'
  const data = await res.json() as { items?: Array<{ summary: string; start: { dateTime?: string; date?: string } }> }
  if (!data.items?.length) return '_No events today_'
  return data.items.map(e => {
    const time = e.start.dateTime
      ? new Date(e.start.dateTime).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
      : 'All day'
    return `  ${time} — ${e.summary}`
  }).join('\n')
}

export async function fetchPending(tenantId: string, env: Env): Promise<string> {
  const rows = await env.D1_US.prepare(
    `SELECT action_type, integration, proposed_at FROM pending_actions
     WHERE tenant_id = ? AND state = 'awaiting_approval'
     ORDER BY proposed_at ASC LIMIT 4`,
  ).bind(tenantId).all()
  if (!rows.results?.length) return ''
  const lines = rows.results.slice(0, 3).map(a => {
    const h = Math.floor((Date.now() - (a.proposed_at as number)) / 3_600_000)
    return `  ${a.action_type} via ${a.integration} (${h < 1 ? 'just now' : h + 'h ago'})`
  })
  if (rows.results.length > 3) lines.push(`  +${rows.results.length - 3} more`)
  return lines.join('\n')
}

export async function fetchHighlights(tenantId: string, kek: CryptoKey, env: Env): Promise<string> {
  const result = await recallViaService(
    { query: 'important recent notable events decisions' }, tenantId, kek, env,
  )
  if (!result.results.length) return ''
  return result.results.slice(0, 3).map(r => `  ${r.content.slice(0, 100)}`).join('\n')
}

export async function fetchOpenLoop(tenantId: string, env: Env): Promise<string> {
  const gap = await env.D1_US.prepare(
    `SELECT question FROM consolidation_gaps
     WHERE tenant_id = ? AND surfaced = 0 AND priority = 'high'
     ORDER BY created_at ASC LIMIT 1`,
  ).bind(tenantId).first<{ question: string }>()
  return gap?.question ?? ''
}

export async function fetchGift(tenantId: string, kek: CryptoKey, env: Env): Promise<string> {
  const result = await recallViaService(
    { query: 'connection bridge insight across domains' }, tenantId, kek, env,
  )
  const bridge = result.results.find(r =>
    r.content.includes('bridge') || r.content.includes('connection'),
  )
  return bridge ? bridge.content.slice(0, 150) : ''
}

export async function fetchNews(env: Env): Promise<string> {
  const res = await fetch(
    `https://api.search.brave.com/res/v1/news/search?q=${encodeURIComponent('technology business')}&count=5&freshness=pd`,
    { headers: { 'X-Subscription-Token': env.BRAVE_API_KEY } },
  )
  if (!res.ok) return '_News unavailable_'
  const data = await res.json() as { results?: Array<{ title: string }> }
  return data.results?.slice(0, 5).map(r => `  ${r.title}`).join('\n') || '_News unavailable_'
}

export async function fetchVerse(env: Env): Promise<string> {
  const cached = await env.KV_SESSION.get('bible_verse:today')
  if (cached) return cached
  const res = await fetch('https://bible-api.com/?random=verse&translation=kjv')
  if (!res.ok) return ''
  const data = await res.json() as { reference: string; text: string }
  const verse = `${data.reference}: "${data.text.trim()}"`
  const ttl = Math.max(Math.floor((86_400_000 - (Date.now() % 86_400_000)) / 1000), 60)
  await env.KV_SESSION.put('bible_verse:today', verse, { expirationTtl: ttl })
  return verse
}
