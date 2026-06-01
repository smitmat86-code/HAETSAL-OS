// src/services/google/calendar.ts
// Google Calendar event extraction for ingestion
// Filter: duration > 15 minutes (skip short blocks)
// PII reduction: attendee count only, never names/emails

import type { GoogleCalendarEvent } from '../../types/google'
import type { IngestionArtifact } from '../../types/ingestion'

const CALENDAR_API = 'https://www.googleapis.com/calendar/v3/calendars/primary/events'

export async function fetchEvent(
  eventId: string, accessToken: string,
): Promise<GoogleCalendarEvent | null> {
  const res = await fetch(`${CALENDAR_API}/${eventId}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  })
  if (!res.ok) return null
  return await res.json() as GoogleCalendarEvent
}

export async function listRecentlyUpdatedEventIds(
  accessToken: string,
  updatedSinceMs: number,
  maxResults: number = 10,
): Promise<string[]> {
  const updatedMin = new Date(updatedSinceMs).toISOString()
  const res = await fetch(
    `${CALENDAR_API}?singleEvents=true&maxResults=${maxResults}&updatedMin=${encodeURIComponent(updatedMin)}`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  )
  if (!res.ok) return []
  const data = await res.json() as { items?: Array<{ id: string }> }
  return data.items?.map((event) => event.id) ?? []
}

function getEventDurationMinutes(event: GoogleCalendarEvent): number {
  const start = event.start.dateTime ? new Date(event.start.dateTime).getTime() : 0
  const end = event.end.dateTime ? new Date(event.end.dateTime).getTime() : 0
  return (end - start) / 60_000
}

export function extractEventArtifact(
  event: GoogleCalendarEvent,
  tenantId: string,
): IngestionArtifact | null {
  const durationMinutes = getEventDurationMinutes(event)
  if (durationMinutes < 15) return null

  const attendeeCount = event.attendees?.length ?? 0
  const content = [
    `Event: ${event.summary}`,
    event.description ? `Description: ${event.description}` : '',
    `Duration: ${Math.round(durationMinutes)} minutes`,
    `Attendees: ${attendeeCount}`,
  ].filter(Boolean).join('\n').slice(0, 2000)

  const occurredAt = event.start.dateTime
    ? new Date(event.start.dateTime).getTime()
    : Date.now()

  return {
    tenantId,
    source: 'calendar',
    content,
    occurredAt,
    domain: 'career',
    provenance: 'calendar',
  }
}

/**
 * Fetch and extract a Calendar event for ingestion
 * Returns null if event < 15 minutes (skip short blocks)
 * PII: attendee count only, no names/emails
 */
export async function fetchAndExtractEvent(
  eventId: string, accessToken: string, tenantId: string,
): Promise<IngestionArtifact | null> {
  const event = await fetchEvent(eventId, accessToken)
  return event ? extractEventArtifact(event, tenantId) : null
}
