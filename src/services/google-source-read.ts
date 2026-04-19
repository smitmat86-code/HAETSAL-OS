import type { Env } from '../types/env'
import type { GoogleDriveFile } from '../types/google'
import type { RetainResult } from '../types/ingestion'
import type { GoogleSourceKind } from '../types/google-source-read'
import { retainContent } from './ingestion/retain'
import {
  buildGoogleSourceRef,
  googleSourceUrl,
  parseGoogleSourceReadAttribution,
} from './google-source-read-contract'
import { fetchEvent, extractEventArtifact, listRecentlyUpdatedEventIds } from './google/calendar'
import { downloadDriveDocument, extractWikilinks, parseObsidianFrontmatter } from './google/drive'
import { fetchAndExtractThread, listRecentThreadIds } from './google/gmail'

function trimOrNull(value?: string | null): string | null {
  const trimmed = value?.trim()
  return trimmed ? trimmed : null
}

async function retainGoogleSource(args: {
  tenantId: string
  kind: GoogleSourceKind
  sourceId: string
  content: string
  occurredAt: number
  scope: string
  tmk: CryptoKey
  env: Env
  ctx: ExecutionContext
  title?: string | null
  artifactRef?: { mode: 'stored_r2'; storageKey: string; filename?: string | null; mediaType?: string | null }
  metadata?: Record<string, unknown>
  explicitInclusion?: boolean
}): Promise<RetainResult | null> {
  const sourceRef = buildGoogleSourceRef({
    surface: 'brain-sources-read',
    kind: args.kind,
    sourceId: args.sourceId,
    explicitInclusion: args.explicitInclusion,
  })
  return retainContent({
    tenantId: args.tenantId,
    source: args.kind,
    sourceRef,
    content: args.content,
    occurredAt: args.occurredAt,
    domain: args.scope,
    provenance: 'source_ingested',
    artifactRef: args.artifactRef ?? null,
    metadata: {
      ...args.metadata,
      title: trimOrNull(args.title) ?? undefined,
      google_source: parseGoogleSourceReadAttribution({ sourceSystem: args.kind, sourceRef }),
    },
  }, args.tmk, args.env, args.ctx)
}

export async function captureGmailThreadSourceRead(args: {
  tenantId: string; threadId: string; accessToken: string; tmk: CryptoKey; env: Env; ctx: ExecutionContext
}): Promise<RetainResult | null> {
  const artifact = await fetchAndExtractThread(args.threadId, args.accessToken, args.tenantId)
  return artifact ? retainGoogleSource({ ...args, kind: 'gmail', sourceId: args.threadId, content: artifact.content, occurredAt: artifact.occurredAt, scope: artifact.domain ?? 'general' }) : null
}

export async function captureCalendarEventSourceRead(args: {
  tenantId: string; eventId: string; accessToken: string; tmk: CryptoKey; env: Env; ctx: ExecutionContext
}): Promise<RetainResult | null> {
  const event = await fetchEvent(args.eventId, args.accessToken)
  const artifact = event ? extractEventArtifact(event, args.tenantId) : null
  return artifact ? retainGoogleSource({ ...args, kind: 'calendar', sourceId: args.eventId, content: artifact.content, occurredAt: artifact.occurredAt, scope: artifact.domain ?? 'general', title: event?.summary ?? null }) : null
}

export async function captureDriveDocumentSourceRead(args: {
  tenantId: string; file: GoogleDriveFile; accessToken: string; inclusionReason: string; tmk: CryptoKey; env: Env; ctx: ExecutionContext
}): Promise<RetainResult | null> {
  if (!trimOrNull(args.inclusionReason)) return null
  const content = await downloadDriveDocument(args.file, args.accessToken)
  if (!content) return null
  const frontmatter = parseObsidianFrontmatter(content)
  if (frontmatter.generatedByBrain) return null
  return retainGoogleSource({
    ...args,
    kind: 'drive',
    sourceId: args.file.id,
    content: content.slice(0, 3000),
    occurredAt: new Date(args.file.modifiedTime).getTime(),
    scope: typeof frontmatter.metadata.domain === 'string' ? frontmatter.metadata.domain : 'general',
    title: typeof frontmatter.metadata.title === 'string' ? frontmatter.metadata.title : args.file.name,
    artifactRef: { mode: 'stored_r2', storageKey: googleSourceUrl('drive', args.file.id), filename: args.file.name, mediaType: args.file.mimeType },
    metadata: { inclusion_reason: args.inclusionReason, wikilinks_json: JSON.stringify(extractWikilinks(content)) },
    explicitInclusion: true,
  })
}

export async function captureRecentGmailThreadWindow(args: {
  tenantId: string; accessToken: string; tmk: CryptoKey; env: Env; ctx: ExecutionContext; maxThreads?: number
}): Promise<number> {
  const threadIds = await listRecentThreadIds(args.accessToken, args.maxThreads ?? 5)
  const retained = await Promise.all(threadIds.map((threadId) => captureGmailThreadSourceRead({ ...args, threadId })))
  return retained.filter(Boolean).length
}

export async function captureRecentCalendarEventWindow(args: {
  tenantId: string; accessToken: string; tmk: CryptoKey; env: Env; ctx: ExecutionContext; updatedSinceMs?: number; maxEvents?: number
}): Promise<number> {
  const eventIds = await listRecentlyUpdatedEventIds(args.accessToken, args.updatedSinceMs ?? (Date.now() - 6 * 60 * 60 * 1000), args.maxEvents ?? 5)
  const retained = await Promise.all(eventIds.map((eventId) => captureCalendarEventSourceRead({ ...args, eventId })))
  return retained.filter(Boolean).length
}
