// src/services/action/integrations/calendar.ts
// Google Calendar API — create, modify, delete (undo)
// Uses OAuth tokens from services/google/oauth.ts (Phase 2.2)

import type { z } from 'zod'
import type { createEventSchema } from '../../../tools/act/create-event'
import type { modifyEventSchema } from '../../../tools/act/modify-event'
import type { Env } from '../../../types/env'
import { getGoogleToken } from '../../google/oauth'

const CALENDAR_API = 'https://www.googleapis.com/calendar/v3/calendars/primary/events'

export interface CalendarResult {
  eventId: string
  htmlLink: string
}

/**
 * Create a Google Calendar event
 * Returns the created event ID and link for undo tracking
 */
export async function executeCreateEvent(
  input: z.infer<typeof createEventSchema>,
  tenantId: string,
  tmk: CryptoKey,
  env: Env,
): Promise<CalendarResult> {
  const accessToken = await getGoogleToken(tenantId, 'calendar', tmk, env)
  if (!accessToken) throw new Error('No Google Calendar token — OAuth required')

  const res = await fetch(CALENDAR_API, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      summary: input.title,
      description: input.description,
      start: { dateTime: input.start_time },
      end: { dateTime: input.end_time },
      attendees: input.attendees?.map(email => ({ email })),
    }),
  })
  if (!res.ok) throw new Error(`Calendar API create error: ${res.status}`)
  const event = (await res.json()) as { id: string; htmlLink: string }
  return { eventId: event.id, htmlLink: event.htmlLink }
}

/**
 * Modify an existing Google Calendar event (PATCH)
 */
export async function executeModifyEvent(
  input: z.infer<typeof modifyEventSchema>,
  tenantId: string,
  tmk: CryptoKey,
  env: Env,
): Promise<CalendarResult> {
  const accessToken = await getGoogleToken(tenantId, 'calendar', tmk, env)
  if (!accessToken) throw new Error('No Google Calendar token — OAuth required')

  const body: Record<string, unknown> = {}
  if (input.title) body.summary = input.title
  if (input.description) body.description = input.description
  if (input.start_time) body.start = { dateTime: input.start_time }
  if (input.end_time) body.end = { dateTime: input.end_time }

  const res = await fetch(`${CALENDAR_API}/${input.event_id}`, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`Calendar API modify error: ${res.status}`)
  const event = (await res.json()) as { id: string; htmlLink: string }
  return { eventId: event.id, htmlLink: event.htmlLink }
}

/**
 * Delete a Google Calendar event (undo for create)
 */
export async function executeDeleteEvent(
  eventId: string,
  tenantId: string,
  tmk: CryptoKey,
  env: Env,
): Promise<void> {
  const accessToken = await getGoogleToken(tenantId, 'calendar', tmk, env)
  if (!accessToken) throw new Error('No Google Calendar token — OAuth required')

  const res = await fetch(`${CALENDAR_API}/${eventId}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${accessToken}` },
  })
  if (!res.ok && res.status !== 410) {
    throw new Error(`Calendar API delete error: ${res.status}`)
  }
}
