// src/workers/ingestion/handlers.ts
// Individual message type handlers â€” called by consumer.ts dispatch
// Each handler: fetch external data (if needed) â†’ build artifact â†’ retainContent()

import type { Env } from '../../types/env'
import { retainContent } from '../../services/ingestion/retain'
import { getGoogleToken } from '../../services/google/oauth'
import {
  captureRecentCalendarEventWindow,
  captureRecentGmailThreadWindow,
} from '../../services/google-source-read'

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
  if (!accessToken) return
  await captureRecentGmailThreadWindow({
    tenantId,
    accessToken,
    tmk,
    env,
    ctx,
    maxThreads: typeof payload.maxThreads === 'number' ? payload.maxThreads : 5,
  })
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
  await captureRecentCalendarEventWindow({
    tenantId,
    accessToken,
    tmk,
    env,
    ctx,
    updatedSinceMs: typeof payload.updatedSinceMs === 'number' ? payload.updatedSinceMs : undefined,
    maxEvents: typeof payload.maxEvents === 'number' ? payload.maxEvents : 5,
  })
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

export {
  handleBootstrapGmailThread,
  handleBootstrapCalendarEvent,
  handleBootstrapDriveFile,
} from './bootstrap-handlers'
