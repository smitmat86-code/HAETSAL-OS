// src/services/google/gmail.ts
// Gmail thread extraction for ingestion pipeline
// Filter: 2+ replies only (single-message → skip)
// Extract: last 3 messages, concatenate, trim to 2000 chars
// Domain: work email domain → 'career', else 'general'

import type { GoogleThread, GoogleMessage } from '../../types/google'
import type { IngestionArtifact } from '../../types/ingestion'

const GMAIL_API = 'https://gmail.googleapis.com/gmail/v1/users/me'

export async function fetchThread(
  threadId: string, accessToken: string,
): Promise<GoogleThread | null> {
  const res = await fetch(`${GMAIL_API}/threads/${threadId}?format=full`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  })
  if (!res.ok) return null
  return await res.json() as GoogleThread
}

function extractMessageText(msg: GoogleMessage): string {
  // Try plain text body
  if (msg.payload.body?.data) {
    return atob(msg.payload.body.data.replace(/-/g, '+').replace(/_/g, '/'))
  }
  // Try text/plain part
  const textPart = msg.payload.parts?.find(p => p.mimeType === 'text/plain')
  if (textPart?.body?.data) {
    return atob(textPart.body.data.replace(/-/g, '+').replace(/_/g, '/'))
  }
  return ''
}

function getHeader(msg: GoogleMessage, name: string): string {
  return msg.payload.headers.find(h => h.name.toLowerCase() === name.toLowerCase())?.value ?? ''
}

function inferEmailDomain(messages: GoogleMessage[]): string {
  // Check if any sender is from a corporate domain
  for (const msg of messages) {
    const from = getHeader(msg, 'From')
    const domain = from.match(/@([\w.-]+)/)?.[1]?.toLowerCase()
    if (domain && !domain.includes('gmail') && !domain.includes('yahoo') &&
        !domain.includes('hotmail') && !domain.includes('outlook')) {
      return 'career'
    }
  }
  return 'general'
}

/**
 * Fetch and extract a Gmail thread for ingestion
 * Returns null if thread has <2 messages (single-message = skip)
 */
export async function fetchAndExtractThread(
  threadId: string, accessToken: string, tenantId: string,
): Promise<IngestionArtifact | null> {
  const thread = await fetchThread(threadId, accessToken)
  if (!thread || !thread.messages || thread.messages.length < 2) return null

  // Take last 3 messages, extract text, concatenate
  const lastMessages = thread.messages.slice(-3)
  const parts = lastMessages.map(msg => {
    const from = getHeader(msg, 'From')
    const subject = getHeader(msg, 'Subject')
    const text = extractMessageText(msg)
    return `From: ${from}\nSubject: ${subject}\n${text}`
  })

  const content = parts.join('\n---\n').slice(0, 2000)
  const occurredAt = parseInt(thread.messages[0].internalDate, 10)
  const domain = inferEmailDomain(thread.messages)

  return {
    tenantId,
    source: 'gmail',
    content,
    occurredAt,
    domain,
    provenance: 'email',
  }
}
