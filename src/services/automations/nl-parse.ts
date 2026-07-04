// src/services/automations/nl-parse.ts
// Chat-to-automation intent parsing ("every weekday at 8am, brief me on my
// day"). Conservative by design: requires an explicit recurrence marker AND
// a resolvable time-of-day; anything else returns null so the message falls
// through to the normal delegation/grounded-reply path. Pure module.

import { DEFAULT_TZ, type RecurrenceSpec } from './recurrence'

export interface ParsedAutomation {
  spec: RecurrenceSpec
  /** The task the automation runs each fire (user content — encrypt at rest). */
  task: string
}

const DAY_NAMES: Record<string, number> = {
  sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6,
  sun: 0, mon: 1, tue: 2, tues: 2, wed: 3, thu: 4, thur: 4, thurs: 4, fri: 5, sat: 6,
}

const NAMED_TIMES: Record<string, [number, number]> = {
  morning: [8, 0], noon: [12, 0], afternoon: [15, 0], evening: [18, 0], night: [21, 0],
}

/** "8", "8:30", "8am", "8:30 pm", "17:00" → [hour, minute] | null */
function parseTime(text: string): [number, number] | null {
  const named = /(morning|noon|afternoon|evening|night)/i.exec(text)
  if (named) return NAMED_TIMES[named[1].toLowerCase()]
  const m = /\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/i.exec(text)
  if (!m) return null
  let hour = Number(m[1])
  const minute = m[2] ? Number(m[2]) : 0
  const meridiem = m[3]?.toLowerCase()
  if (hour > 23 || minute > 59) return null
  if (meridiem === 'pm' && hour < 12) hour += 12
  if (meridiem === 'am' && hour === 12) hour = 0
  // A bare hour with no meridiem and no colon is ambiguous ("at 8") — treat
  // 1..7 as evening ambiguity and reject; 8..23 read naturally as clock time.
  if (!meridiem && !m[2] && hour >= 1 && hour <= 7) return null
  return [hour, minute]
}

/** Split "<cadence> at <time>, <task>" shapes into recurrence + task text. */
export function parseAutomationIntent(text: string, tz = DEFAULT_TZ): ParsedAutomation | null {
  const cadenceMatch = /\b(every\s+(week\s?day|day|morning|evening|night|(?:sun|mon|tues?|wed|thu(?:rs?)?|fri|sat)[a-z]*)|daily|each\s+(?:week\s?day|day|morning))\b/i.exec(text)
  if (!cadenceMatch) return null

  const cadenceRaw = (cadenceMatch[2] ?? cadenceMatch[1]).toLowerCase().replace(/\s+/g, '')
  let kind: RecurrenceSpec['kind']
  let dayOfWeek: number | undefined
  if (cadenceRaw.startsWith('weekday')) kind = 'weekdays'
  else if (cadenceRaw in DAY_NAMES || cadenceRaw.replace(/s$/, '') in DAY_NAMES) {
    kind = 'weekly'
    dayOfWeek = DAY_NAMES[cadenceRaw] ?? DAY_NAMES[cadenceRaw.replace(/s$/, '')]
  } else kind = 'daily'

  // Time: prefer an explicit "at <time>"; fall back to a named time inside
  // the cadence itself ("every morning").
  const atMatch = /\bat\s+([^,;]+)/i.exec(text)
  const time = (atMatch && parseTime(atMatch[1])) ?? parseTime(cadenceMatch[1])
  if (!time) return null

  // Task = the text minus the schedule clause; require something actionable.
  const task = text
    .replace(cadenceMatch[0], ' ')
    .replace(atMatch?.[0] ?? '', ' ')
    .replace(/^[\s,;:-]+|[\s,;:-]+$/g, '')
    .replace(/\s{2,}/g, ' ')
  if (task.split(/\s+/).filter(Boolean).length < 2) return null

  return { spec: { kind, hour: time[0], minute: time[1], ...(dayOfWeek !== undefined ? { dayOfWeek } : {}), tz }, task }
}

export type AutomationCommand =
  | { kind: 'list' }
  | { kind: 'toggle'; idPrefix: string; enabled: boolean }
  | { kind: 'delete'; idPrefix: string }

/** Management commands over chat: "list automations", "pause automation ab12". */
export function parseAutomationCommand(text: string): AutomationCommand | null {
  const t = text.trim().toLowerCase()
  if (/^(list|show)( my)? automations?$/.test(t)) return { kind: 'list' }
  const m = /^(pause|resume|enable|disable|delete|remove)\s+automation\s+([a-z0-9-]{4,})$/i.exec(t)
  if (!m) return null
  const idPrefix = m[2]
  if (m[1] === 'delete' || m[1] === 'remove') return { kind: 'delete', idPrefix }
  return { kind: 'toggle', idPrefix, enabled: m[1] === 'resume' || m[1] === 'enable' }
}
