// src/workers/ingestion/bootstrap-handlers.ts
// Bootstrap import queue handlers — provenance: 'bootstrap_import'
// QUEUE_BULK consumers for historical Gmail/Calendar/Drive import

import type { Env } from '../../types/env'
import { retainContent } from '../../services/ingestion/retain'
import { getGoogleToken } from '../../services/google/oauth'
import { fetchAndExtractThread } from '../../services/google/gmail'
import { fetchAndExtractEvent } from '../../services/google/calendar'
import { downloadDriveFile } from '../../services/google/drive'

export async function handleBootstrapGmailThread(
  tenantId: string,
  payload: Record<string, unknown>,
  tmk: CryptoKey,
  env: Env,
  ctx: ExecutionContext,
): Promise<void> {
  const accessToken = await getGoogleToken(tenantId, 'gmail.readonly', tmk, env)
  if (!accessToken) return

  const threadId = payload.threadId as string
  const artifact = await fetchAndExtractThread(threadId, accessToken, tenantId)
  if (!artifact) return

  artifact.provenance = 'bootstrap_import'
  if (payload.salienceMultiplier) {
    artifact.metadata = { ...artifact.metadata, salience_multiplier: payload.salienceMultiplier }
  }
  await retainContent(artifact, tmk, env, ctx)
  await incrementBootstrapCount(tenantId, env)
}

export async function handleBootstrapCalendarEvent(
  tenantId: string,
  payload: Record<string, unknown>,
  tmk: CryptoKey,
  env: Env,
  ctx: ExecutionContext,
): Promise<void> {
  const accessToken = await getGoogleToken(tenantId, 'calendar.readonly', tmk, env)
  if (!accessToken) return

  const eventId = payload.eventId as string
  const artifact = await fetchAndExtractEvent(eventId, accessToken, tenantId)
  if (!artifact) return

  artifact.provenance = 'bootstrap_import'
  if (payload.salienceMultiplier) {
    artifact.metadata = { ...artifact.metadata, salience_multiplier: payload.salienceMultiplier }
  }
  await retainContent(artifact, tmk, env, ctx)
  await incrementBootstrapCount(tenantId, env)
}

export async function handleBootstrapDriveFile(
  tenantId: string,
  payload: Record<string, unknown>,
  tmk: CryptoKey,
  env: Env,
  ctx: ExecutionContext,
): Promise<void> {
  const accessToken = await getGoogleToken(tenantId, 'drive.readonly', tmk, env)
  if (!accessToken) return

  const fileId = payload.fileId as string
  const content = await downloadDriveFile(fileId, accessToken)
  if (!content) return

  await retainContent(
    {
      tenantId,
      source: 'file',
      content: content.slice(0, 3000),
      occurredAt: Date.now(),
      provenance: 'bootstrap_import',
      metadata: { file_id: fileId, salience_multiplier: payload.salienceMultiplier },
    },
    tmk,
    env,
    ctx,
  )
  await incrementBootstrapCount(tenantId, env)
}

async function incrementBootstrapCount(tenantId: string, env: Env): Promise<void> {
  await env.D1_US.prepare(
    'UPDATE tenants SET bootstrap_items_imported = bootstrap_items_imported + 1 WHERE id = ?',
  ).bind(tenantId).run()
}
