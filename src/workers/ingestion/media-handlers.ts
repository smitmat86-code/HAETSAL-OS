// src/workers/ingestion/media-handlers.ts
// Governed captures of chat-channel photo artifacts (Sendblue + Telegram).
// Same shape: R2 storageKey already written by the webhook, this handler
// only writes the governed capture row referencing it.

import type { Env } from '../../types/env'
import { retainContent } from '../../services/ingestion/retain'

interface ChannelMediaPayload {
  description: string
  caption: string | null
  storageKey: string
  mediaType: string
  byteLength: number | null
  occurredAt: number
}

function readMediaPayload(p: Record<string, unknown>): ChannelMediaPayload {
  return {
    description: p.description as string,
    caption: (p.caption as string | null) ?? null,
    storageKey: p.storageKey as string,
    mediaType: (p.mediaType as string) ?? 'image/jpeg',
    byteLength: (p.byteLength as number) ?? null,
    occurredAt: p.occurredAt as number,
  }
}

function buildBody(m: ChannelMediaPayload): string {
  return m.caption ? `${m.caption}\n\nPhoto: ${m.description}` : `Photo: ${m.description}`
}

export async function handleSendblueMedia(
  tenantId: string,
  payload: Record<string, unknown>,
  tmk: CryptoKey,
  env: Env,
  ctx: ExecutionContext,
): Promise<void> {
  const m = readMediaPayload(payload)
  const from = payload.from as string
  await retainContent(
    {
      tenantId, source: 'sendblue', content: buildBody(m),
      occurredAt: m.occurredAt, provenance: 'sendblue_photo',
      artifactRef: { mode: 'stored_r2', storageKey: m.storageKey, mediaType: m.mediaType, byteLength: m.byteLength },
      metadata: { from_phone: from, media_storage_key: m.storageKey },
      governance: { authorKind: 'user', legacyMemoryType: 'episodic', provenanceNote: 'sendblue_photo' },
    },
    tmk, env, ctx,
  )
}

export async function handleTelegramMedia(
  tenantId: string,
  payload: Record<string, unknown>,
  tmk: CryptoKey,
  env: Env,
  ctx: ExecutionContext,
): Promise<void> {
  const m = readMediaPayload(payload)
  const chatId = payload.chatId as number
  await retainContent(
    {
      tenantId, source: 'telegram', content: buildBody(m),
      occurredAt: m.occurredAt, provenance: 'telegram_photo',
      artifactRef: { mode: 'stored_r2', storageKey: m.storageKey, mediaType: m.mediaType, byteLength: m.byteLength },
      metadata: { telegram_chat_id: chatId, media_storage_key: m.storageKey },
      governance: { authorKind: 'user', legacyMemoryType: 'episodic', provenanceNote: 'telegram_photo' },
    },
    tmk, env, ctx,
  )
}
