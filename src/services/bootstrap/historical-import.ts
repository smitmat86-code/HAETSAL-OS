// src/services/bootstrap/historical-import.ts
// Historical Gmail/Calendar/Drive batch import via QUEUE_BULK
// CRITICAL: QUEUE_BULK only — never QUEUE_HIGH or QUEUE_NORMAL
// Date-weighted salience: older content → lower multiplier (min 0.5)

import type { Env } from '../../types/env'
import type { IngestionQueueMessage } from '../../types/ingestion'

const GMAIL_API = 'https://gmail.googleapis.com/gmail/v1/users/me'
const CALENDAR_API = 'https://www.googleapis.com/calendar/v3/calendars/primary/events'
const DRIVE_API = 'https://www.googleapis.com/drive/v3/files'
const BATCH_SIZE = 50

/**
 * Date-weighted salience multiplier
 * Decay: 1.0 → 0.5 over maxMonths
 * Older content still has value — minimum 0.5
 */
export function historicalSalienceMultiplier(occurredAt: number, maxMonths: number): number {
  const ageMs = Date.now() - occurredAt
  const ageMonths = ageMs / (1000 * 60 * 60 * 24 * 30)
  return Math.max(0.5, 1.0 - (ageMonths / maxMonths) * 0.5)
}

export async function importGmailHistory(
  tenantId: string, monthsBack: number, accessToken: string, env: Env,
): Promise<number> {
  const sinceMs = Date.now() - monthsBack * 30 * 24 * 60 * 60 * 1000
  const sinceEpoch = Math.floor(sinceMs / 1000)
  let imported = 0
  let pageToken: string | undefined

  do {
    const url = `${GMAIL_API}/threads?q=after:${sinceEpoch}&maxResults=100${pageToken ? `&pageToken=${pageToken}` : ''}`
    const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } })
    if (!res.ok) break
    const data = await res.json() as { threads?: Array<{ id: string; historyId: string }>; nextPageToken?: string }
    if (!data.threads?.length) break

    const batch: IngestionQueueMessage[] = data.threads.map(t => ({
      type: 'bootstrap_gmail_thread' as const,
      tenantId,
      payload: {
        threadId: t.id,
        salienceMultiplier: historicalSalienceMultiplier(Date.now() - (monthsBack * 15 * 24 * 60 * 60 * 1000), monthsBack),
      },
      enqueuedAt: Date.now(),
    }))

    for (let i = 0; i < batch.length; i += BATCH_SIZE) {
      await env.QUEUE_BULK.sendBatch(batch.slice(i, i + BATCH_SIZE).map(msg => ({ body: msg })))
    }

    imported += batch.length
    pageToken = data.nextPageToken
  } while (pageToken)

  return imported
}

export async function importCalendarHistory(
  tenantId: string, monthsBack: number, accessToken: string, env: Env,
): Promise<number> {
  const sinceMs = Date.now() - monthsBack * 30 * 24 * 60 * 60 * 1000
  const timeMin = new Date(sinceMs).toISOString()
  let imported = 0
  let pageToken: string | undefined

  do {
    const url = `${CALENDAR_API}?timeMin=${timeMin}&maxResults=250&singleEvents=true&orderBy=startTime${pageToken ? `&pageToken=${pageToken}` : ''}`
    const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } })
    if (!res.ok) break
    const data = await res.json() as { items?: Array<{ id: string; start?: { dateTime?: string } }>; nextPageToken?: string }
    if (!data.items?.length) break

    const batch: IngestionQueueMessage[] = data.items.map(e => {
      const occurredAt = e.start?.dateTime ? new Date(e.start.dateTime).getTime() : Date.now()
      return {
        type: 'bootstrap_calendar_event' as const,
        tenantId,
        payload: {
          eventId: e.id,
          salienceMultiplier: historicalSalienceMultiplier(occurredAt, monthsBack),
        },
        enqueuedAt: Date.now(),
      }
    })

    for (let i = 0; i < batch.length; i += BATCH_SIZE) {
      await env.QUEUE_BULK.sendBatch(batch.slice(i, i + BATCH_SIZE).map(msg => ({ body: msg })))
    }

    imported += batch.length
    pageToken = data.nextPageToken
  } while (pageToken)

  return imported
}

export async function importDriveHistory(
  tenantId: string, monthsBack: number, accessToken: string, env: Env,
): Promise<number> {
  const sinceMs = Date.now() - monthsBack * 30 * 24 * 60 * 60 * 1000
  const modifiedAfter = new Date(sinceMs).toISOString()
  const query = `modifiedTime > '${modifiedAfter}' and trashed = false and (mimeType = 'application/vnd.google-apps.document' or mimeType = 'text/plain' or mimeType = 'text/markdown')`
  let imported = 0
  let pageToken: string | undefined
  const MAX_DRIVE_FILES = 500

  do {
    const url = `${DRIVE_API}?q=${encodeURIComponent(query)}&fields=files(id,name,mimeType,modifiedTime)&pageSize=100&orderBy=modifiedTime desc${pageToken ? `&pageToken=${pageToken}` : ''}`
    const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } })
    if (!res.ok) break
    const data = await res.json() as { files?: Array<{ id: string; modifiedTime: string }>; nextPageToken?: string }
    if (!data.files?.length) break

    const remaining = MAX_DRIVE_FILES - imported
    const files = data.files.slice(0, remaining)

    const batch: IngestionQueueMessage[] = files.map(f => ({
      type: 'bootstrap_drive_file' as const,
      tenantId,
      payload: {
        fileId: f.id,
        salienceMultiplier: historicalSalienceMultiplier(new Date(f.modifiedTime).getTime(), monthsBack),
      },
      enqueuedAt: Date.now(),
    }))

    for (let i = 0; i < batch.length; i += BATCH_SIZE) {
      await env.QUEUE_BULK.sendBatch(batch.slice(i, i + BATCH_SIZE).map(msg => ({ body: msg })))
    }

    imported += files.length
    pageToken = imported < MAX_DRIVE_FILES ? data.nextPageToken : undefined
  } while (pageToken)

  return imported
}
