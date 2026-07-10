// src/services/google/gmail.ts
// Gmail thread extraction for ingestion pipeline
// Filter: 2+ replies only (single-message → skip)
// Extract: last 3 messages, concatenate, trim to 2000 chars
// Domain: work email domain → 'career', else 'general'

import type { GoogleThread, GoogleMessage } from '../../types/google'
import type { IngestionArtifact } from '../../types/ingestion'

const GMAIL_API = 'https://gmail.googleapis.com/gmail/v1/users/me'

function encodeBase64Url(value: string): string {
  const bytes = new TextEncoder().encode(value)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function safeHeader(value: string, name: string): string {
  if (/[\r\n]/.test(value)) throw new Error(`Invalid ${name} header`)
  return value.trim()
}

export async function sendGmailMessage(
  input: { recipient: string; subject?: string; message: string; threadId?: string },
  accessToken: string,
): Promise<{ messageId: string; threadId: string }> {
  const recipient = safeHeader(input.recipient, 'recipient')
  const subject = safeHeader(input.subject?.trim() || 'Message from HAETSAL', 'subject')
  const raw = encodeBase64Url([
    `To: ${recipient}`,
    `Subject: ${subject}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: 8bit',
    '',
    input.message,
  ].join('\r\n'))
  const res = await fetch(`${GMAIL_API}/messages/send`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ raw, threadId: input.threadId }),
  })
  if (!res.ok) throw new Error(`Gmail API send error: ${res.status}`)
  const sent = await res.json() as { id: string; threadId: string }
  return { messageId: sent.id, threadId: sent.threadId }
}

export async function fetchThread(
  threadId: string, accessToken: string,
): Promise<GoogleThread | null> {
  const res = await fetch(`${GMAIL_API}/threads/${threadId}?format=full`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  })
  if (!res.ok) return null
  return await res.json() as GoogleThread
}

export async function listRecentThreadIds(
  accessToken: string,
  maxResults: number = 10,
  newerThanDays: number = 7,
): Promise<string[]> {
  const days = Math.min(Math.max(Math.trunc(newerThanDays), 1), 365)
  const res = await fetch(
    `${GMAIL_API}/threads?maxResults=${maxResults}&q=${encodeURIComponent(`newer_than:${days}d`)}`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  )
  if (!res.ok) return []
  const data = await res.json() as { threads?: Array<{ id: string }> }
  return data.threads?.map((thread) => thread.id) ?? []
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

export function extractThreadArtifact(
  thread: GoogleThread,
  tenantId: string,
): IngestionArtifact | null {
  if (!thread.messages || thread.messages.length < 2) return null

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

/**
 * Fetch and extract a Gmail thread for ingestion
 * Returns null if thread has <2 messages (single-message = skip)
 */
export async function fetchAndExtractThread(
  threadId: string, accessToken: string, tenantId: string,
): Promise<IngestionArtifact | null> {
  const thread = await fetchThread(threadId, accessToken)
  return thread ? extractThreadArtifact(thread, tenantId) : null
}
