// src/services/automations/recurrence.ts
// Timezone-correct next-occurrence math for user automations. Recurrence is
// deliberately a small model (daily / weekdays / weekly at HH:MM in a tz),
// scheduled as one-shot alarms that re-arm after each fire — fixed UTC cron
// expressions drift twice a year across DST; computing each occurrence in the
// tenant's zone does not. Pure module: no Date.now() — callers pass `nowMs`.

export type RecurrenceKind = 'daily' | 'weekdays' | 'weekly'

export interface RecurrenceSpec {
  kind: RecurrenceKind
  hour: number
  minute: number
  /** 0=Sunday..6=Saturday; required when kind === 'weekly'. */
  dayOfWeek?: number
  tz: string
}

export const DEFAULT_TZ = 'America/Los_Angeles'

interface WallClock { y: number; m: number; d: number; h: number; min: number; weekday: number }

const WEEKDAY_INDEX: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }

/** Read the wall clock an instant shows in a tz. */
export function wallClockInTz(epochMs: number, tz: string): WallClock {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23', weekday: 'short',
  }).formatToParts(new Date(epochMs))
  const get = (type: string): string => parts.find(p => p.type === type)?.value ?? '0'
  return {
    y: Number(get('year')), m: Number(get('month')), d: Number(get('day')),
    h: Number(get('hour')), min: Number(get('minute')),
    weekday: WEEKDAY_INDEX[get('weekday')] ?? 0,
  }
}

/** Convert a wall-clock time in a tz to a UTC epoch (two-pass DST-safe). */
export function zonedTimeToUtc(y: number, m: number, d: number, h: number, min: number, tz: string): number {
  const target = Date.UTC(y, m - 1, d, h, min)
  let epoch = target
  for (let pass = 0; pass < 2; pass++) {
    const shown = wallClockInTz(epoch, tz)
    const shownAsUtc = Date.UTC(shown.y, shown.m - 1, shown.d, shown.h, shown.min)
    epoch += target - shownAsUtc
  }
  return epoch
}

function matchesKind(spec: RecurrenceSpec, weekday: number): boolean {
  if (spec.kind === 'daily') return true
  if (spec.kind === 'weekdays') return weekday >= 1 && weekday <= 5
  return weekday === (spec.dayOfWeek ?? 1)
}

/** Next occurrence strictly after `nowMs`. Scans day candidates in the tz. */
export function nextOccurrence(spec: RecurrenceSpec, nowMs: number): number {
  const today = wallClockInTz(nowMs, spec.tz)
  for (let offset = 0; offset <= 8; offset++) {
    // Normalize the candidate date through Date.UTC (handles month rollover).
    const candidate = new Date(Date.UTC(today.y, today.m - 1, today.d + offset))
    const y = candidate.getUTCFullYear()
    const m = candidate.getUTCMonth() + 1
    const d = candidate.getUTCDate()
    const epoch = zonedTimeToUtc(y, m, d, spec.hour, spec.minute, spec.tz)
    if (epoch <= nowMs) continue
    if (!matchesKind(spec, wallClockInTz(epoch, spec.tz).weekday)) continue
    return epoch
  }
  throw new Error('nextOccurrence: no slot found in 8-day scan')
}

/** Human-readable schedule line for acks and the dashboard (content-free). */
export function describeRecurrence(spec: RecurrenceSpec): string {
  const hh = String(spec.hour).padStart(2, '0')
  const mm = String(spec.minute).padStart(2, '0')
  const names = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
  const cadence = spec.kind === 'daily' ? 'every day'
    : spec.kind === 'weekdays' ? 'every weekday'
      : `every ${names[spec.dayOfWeek ?? 1]}`
  return `${cadence} at ${hh}:${mm} (${spec.tz})`
}
