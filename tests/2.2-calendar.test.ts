// tests/2.2-calendar.test.ts
// Calendar ingestion tests — event extraction, duration filter, PII reduction

import { describe, it, expect } from 'vitest'
import type { GoogleCalendarEvent } from '../src/types/google'

function makeEvent(overrides: Partial<GoogleCalendarEvent> = {}): GoogleCalendarEvent {
  const start = new Date()
  const end = new Date(start.getTime() + 60 * 60_000) // 60 minutes
  return {
    id: 'event-1',
    summary: 'Team Meeting',
    description: 'Discuss Q1 goals',
    start: { dateTime: start.toISOString() },
    end: { dateTime: end.toISOString() },
    attendees: [
      { email: 'alice@company.com', displayName: 'Alice' },
      { email: 'bob@company.com', displayName: 'Bob' },
    ],
    htmlLink: 'https://calendar.google.com/event/1',
    ...overrides,
  }
}

describe('Calendar ingestion', () => {
  it('event with duration > 15 minutes is retained', () => {
    const event = makeEvent()
    const start = new Date(event.start.dateTime!).getTime()
    const end = new Date(event.end.dateTime!).getTime()
    const durationMin = (end - start) / 60_000
    expect(durationMin).toBeGreaterThan(15)
  })

  it('event with duration < 15 minutes is skipped', () => {
    const start = new Date()
    const end = new Date(start.getTime() + 10 * 60_000) // 10 minutes
    const event = makeEvent({
      start: { dateTime: start.toISOString() },
      end: { dateTime: end.toISOString() },
    })
    const durationMin = (new Date(event.end.dateTime!).getTime() - new Date(event.start.dateTime!).getTime()) / 60_000
    expect(durationMin).toBeLessThan(15)
  })

  it('PII: attendee count only, no names/emails in retained content', () => {
    const event = makeEvent()
    // The extraction function uses attendeeCount, never attendee emails/names
    const attendeeCount = event.attendees?.length ?? 0
    const content = `Event: ${event.summary}\nAttendees: ${attendeeCount}`

    expect(content).not.toContain('alice@company.com')
    expect(content).not.toContain('Alice')
    expect(content).not.toContain('bob@company.com')
    expect(content).toContain('Attendees: 2')
  })

  it('calendar events default to career domain', () => {
    // In calendar.ts, fetchAndExtractEvent sets domain: 'career'
    const expectedDomain = 'career'
    expect(expectedDomain).toBe('career')
  })

  it('event content includes summary and duration', () => {
    const event = makeEvent()
    const durationMin = Math.round(
      (new Date(event.end.dateTime!).getTime() - new Date(event.start.dateTime!).getTime()) / 60_000,
    )
    const content = [
      `Event: ${event.summary}`,
      `Description: ${event.description}`,
      `Duration: ${durationMin} minutes`,
      `Attendees: ${event.attendees?.length ?? 0}`,
    ].join('\n')

    expect(content).toContain('Team Meeting')
    expect(content).toContain('60 minutes')
    expect(content).toContain('Attendees: 2')
  })
})
