// src/workers/ingestion/handlers.ts
// Individual message type handlers — called by consumer.ts dispatch
// Each handler: fetch external data (if needed) → build artifact → retainContent()

import type { Env } from '../../types/env'
import type { IngestionArtifact } from '../../types/ingestion'
import { retainContent } from '../../services/ingestion/retain'
import { getGoogleToken } from '../../services/google/oauth'
import { fetchAndExtractThread } from '../../services/google/gmail'
import { fetchAndExtractEvent } from '../../services/google/calendar'
export async function handleSmsInbound(
  tenantId: string,
  payload: Record<string, unknown>,
  tmk: CryptoKey,
  env: Env,
  ctx: ExecutionContext,
): Promise<void> {
  const text = payload.text as string
  const occurredAt = payload.occurredAt as number
  const from = payload.from as string

  await retainContent(
    {
      tenantId,
      source: 'sms',
      content: text,
      occurredAt,
      provenance: 'sms',
      metadata: { from_phone: from },
    },
    tmk,
    env,
    ctx,
  )
}

export async function handleGmailThread(
  tenantId: string,
  payload: Record<string, unknown>,
  tmk: CryptoKey,
  env: Env,
  ctx: ExecutionContext,
): Promise<void> {
  const accessToken = await getGoogleToken(tenantId, 'gmail.readonly', tmk, env)
  if (!accessToken) return // No Google token — skip silently

  const threadId = payload.historyId as string
  const artifact = await fetchAndExtractThread(threadId, accessToken, tenantId)
  if (!artifact) return // Single-message thread or fetch failed

  await retainContent(artifact, tmk, env, ctx)
}

export async function handleCalendarEvent(
  tenantId: string,
  payload: Record<string, unknown>,
  tmk: CryptoKey,
  env: Env,
  ctx: ExecutionContext,
): Promise<void> {
  const accessToken = await getGoogleToken(tenantId, 'calendar.readonly', tmk, env)
  if (!accessToken) return

  const eventId = payload.resourceId as string
  const artifact = await fetchAndExtractEvent(eventId, accessToken, tenantId)
  if (!artifact) return // Event < 15 min or fetch failed

  await retainContent(artifact, tmk, env, ctx)
}

export async function handleObsidianNote(
  tenantId: string,
  payload: Record<string, unknown>,
  tmk: CryptoKey,
  env: Env,
  ctx: ExecutionContext,
): Promise<void> {
  const content = payload.content as string
  const fileName = payload.fileName as string
  const salienceTier = payload.salienceTier as number ?? 2
  const wikilinks = payload.wikilinks as string[] ?? []

  await retainContent(
    {
      tenantId,
      source: 'obsidian',
      content,
      occurredAt: Date.now(),
      provenance: 'obsidian',
      metadata: { file_name: fileName, wikilinks_json: JSON.stringify(wikilinks), salience_override: salienceTier },
    },
    tmk,
    env,
    ctx,
  )
}

// Re-export bootstrap handlers from separate module (postflight line limit)
export {
  handleBootstrapGmailThread,
  handleBootstrapCalendarEvent,
  handleBootstrapDriveFile,
} from './bootstrap-handlers'
