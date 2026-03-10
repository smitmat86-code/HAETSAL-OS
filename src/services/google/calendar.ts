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

function getEventDurationMinutes(event: GoogleCalendarEvent): number {
  const start = event.start.dateTime ? new Date(event.start.dateTime).getTime() : 0
  const end = event.end.dateTime ? new Date(event.end.dateTime).getTime() : 0
  return (end - start) / 60_000
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
  if (!event) return null

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
    domain: 'career', // Calendar events default to career domain
    provenance: 'calendar',
  }
}
