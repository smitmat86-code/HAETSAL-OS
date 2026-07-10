import type { Env } from '../types/env'
import { deriveTmk } from '../middleware/auth'
import { getCanonicalMemoryStore } from './canonical-postgres'
import { getGoogleToken } from './google/oauth'
import { parseGoogleSourceReadAttribution } from './google-source-read-contract'
import {
  captureCalendarEventTimeWindow,
  captureRecentGmailThreadWindow,
} from './google-source-read'

export interface GoogleSourceEvidenceItem {
  captureId: string
  documentId: string
  sourceSystem: string
  sourceRef: string | null
  googleSource: ReturnType<typeof parseGoogleSourceReadAttribution>
  title: string | null
  scope: string
  capturedAt: number
  chunkCount: number | null
}

export async function listGoogleSourceEvidence(
  env: Env,
  tenantId: string,
  limit = 20,
): Promise<GoogleSourceEvidenceItem[]> {
  const boundedLimit = Math.min(Math.max(Math.trunc(limit), 1), 50)
  const store = getCanonicalMemoryStore(env)
  const rows = await store.listRecentDocuments(tenantId, null, Math.max(boundedLimit * 4, 20))
  const sourceRows = rows
    .filter((row) => row.source_system === 'gmail' || row.source_system === 'calendar')
    .slice(0, boundedLimit)
  return Promise.all(sourceRows.map(async (row) => {
    const document = await store.getDocument(tenantId, row.document_id).catch(() => null)
    return {
      captureId: row.capture_id,
      documentId: row.document_id,
      sourceSystem: row.source_system,
      sourceRef: row.source_ref,
      googleSource: parseGoogleSourceReadAttribution({
        sourceSystem: row.source_system,
        sourceRef: row.source_ref,
      }),
      title: row.title,
      scope: row.scope,
      capturedAt: row.captured_at,
      chunkCount: document?.chunk_count ?? null,
    }
  }))
}

export async function runGoogleSourceEvidenceSync(args: {
  env: Env
  tenantId: string
  jwtSub: string
  ctx: ExecutionContext
}): Promise<{
  gmail: { connected: boolean; retained: number }
  calendar: { connected: boolean; retained: number }
  evidence: GoogleSourceEvidenceItem[]
}> {
  const tmk = await deriveTmk(args.jwtSub, args.env.CF_ACCESS_AUD)
  const [gmailToken, calendarToken] = await Promise.all([
    getGoogleToken(args.tenantId, 'gmail.readonly', tmk, args.env).catch(() => null),
    getGoogleToken(args.tenantId, 'calendar.readonly', tmk, args.env).catch(() => null),
  ])

  const now = Date.now()
  const [gmailRetained, calendarRetained] = await Promise.all([
    gmailToken
      ? captureRecentGmailThreadWindow({
        tenantId: args.tenantId,
        accessToken: gmailToken,
        tmk,
        env: args.env,
        ctx: args.ctx,
        maxThreads: 20,
        newerThanDays: 90,
      })
      : Promise.resolve(0),
    calendarToken
      ? captureCalendarEventTimeWindow({
        tenantId: args.tenantId,
        accessToken: calendarToken,
        tmk,
        env: args.env,
        ctx: args.ctx,
        timeMinMs: now - 180 * 24 * 60 * 60 * 1000,
        timeMaxMs: now + 60 * 24 * 60 * 60 * 1000,
        maxEvents: 20,
      })
      : Promise.resolve(0),
  ])

  return {
    gmail: { connected: Boolean(gmailToken), retained: gmailRetained },
    calendar: { connected: Boolean(calendarToken), retained: calendarRetained },
    evidence: await listGoogleSourceEvidence(args.env, args.tenantId, 20),
  }
}
