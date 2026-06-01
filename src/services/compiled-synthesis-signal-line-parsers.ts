import type { ParsedSelectionSignals } from './compiled-synthesis-signal-types'
import {
  type ParsedActionSignal,
  type ParsedChangeSignal,
  type ParsedContradictionSignal,
  type ParsedDecisionSignal,
  type ParsedFactSignal,
  type ParsedQuestionSignal,
  type ParsedRelationshipSignal,
} from './compiled-synthesis-signal-types'
import { slugifyStableSegment } from './compiled-synthesis-utils'

type SectionKind =
  | 'why'
  | 'state'
  | 'facts'
  | 'relationships'
  | 'changes'
  | 'decisions'
  | 'questions'
  | 'actions'
  | 'contradictions'
  | null

export function normalizeLine(line: string): string {
  return line
    .replace(/^\s{0,3}(?:[-*+]\s+|\d+\.\s+)/, '')
    .replace(/^#+\s*/, '')
    .trim()
}

export function maybeSection(value: string): SectionKind {
  const normalized = value.trim().toLowerCase().replace(/:$/, '')
  if (normalized === 'why it matters') return 'why'
  if (normalized === 'current state') return 'state'
  if (normalized === 'facts' || normalized === 'key facts') return 'facts'
  if (normalized === 'relationships' || normalized === 'key relationships') return 'relationships'
  if (normalized === 'changes' || normalized === 'recent changes' || normalized === 'recent updates') return 'changes'
  if (normalized === 'decisions') return 'decisions'
  if (normalized === 'open questions' || normalized === 'questions') return 'questions'
  if (normalized === 'actions' || normalized === 'recommended actions' || normalized === 'next actions') return 'actions'
  if (normalized === 'contradictions' || normalized === 'tensions') return 'contradictions'
  return null
}

function splitStructuredParts(value: string): string[] {
  return value.split('|').map(part => part.trim()).filter(Boolean)
}

function parseFactSignal(value: string): ParsedFactSignal {
  const parts = splitStructuredParts(value)
  return parts.length >= 2
    ? { kind: slugifyStableSegment(parts[0]), label: parts[0], summary: parts.slice(1).join(' | ') }
    : { kind: slugifyStableSegment(value.slice(0, 40)) || 'fact', label: 'Fact', summary: value }
}

function parseRelationshipSignal(value: string): ParsedRelationshipSignal {
  const parts = splitStructuredParts(value)
  return parts.length >= 3
    ? { relationshipType: slugifyStableSegment(parts[0]) || 'related_to', counterpartName: parts[1], summary: parts.slice(2).join(' | ') }
    : { relationshipType: 'related_to', counterpartName: null, summary: value }
}

function parseChangeSignal(value: string, changedAt: number): ParsedChangeSignal {
  const parts = splitStructuredParts(value)
  return parts.length >= 2
    ? { changeKind: slugifyStableSegment(parts[0]) || 'update', summary: parts.slice(1).join(' | '), changedAt }
    : { changeKind: 'update', summary: value, changedAt }
}

function parseDecisionSignal(value: string): ParsedDecisionSignal {
  const parts = splitStructuredParts(value)
  return parts.length >= 2
    ? { decisionKey: slugifyStableSegment(parts[0]) || 'decision', summary: parts.slice(1).join(' | ') }
    : { decisionKey: slugifyStableSegment(value.slice(0, 40)) || 'decision', summary: value }
}

function parseQuestionSignal(value: string): ParsedQuestionSignal {
  const parts = splitStructuredParts(value)
  return parts.length >= 2 ? { question: parts[0], owner: parts[1] ?? null } : { question: value, owner: null }
}

function parseActionSignal(value: string): ParsedActionSignal {
  const parts = splitStructuredParts(value)
  return parts.length >= 2
    ? { owner: parts[0] ?? null, summary: parts.slice(1).join(' | ') }
    : { owner: null, summary: value }
}

function parseContradictionSignal(value: string): ParsedContradictionSignal {
  const parts = splitStructuredParts(value)
  return parts.length >= 2
    ? { contradictionKind: slugifyStableSegment(parts[0]) || 'claim_conflict', summary: parts.slice(1).join(' | ') }
    : { contradictionKind: 'claim_conflict', summary: value }
}

export function pushStructuredSignal(
  target: ParsedSelectionSignals,
  section: Exclude<SectionKind, null>,
  value: string,
  capturedAt: number,
): void {
  if (!value.trim()) return
  if (section === 'why') target.whyItMatters.push(value)
  if (section === 'state') target.currentState.push(value)
  if (section === 'facts') target.facts.push(parseFactSignal(value))
  if (section === 'relationships') target.relationships.push(parseRelationshipSignal(value))
  if (section === 'changes') target.changes.push(parseChangeSignal(value, capturedAt))
  if (section === 'decisions') target.decisions.push(parseDecisionSignal(value))
  if (section === 'questions') target.questions.push(parseQuestionSignal(value))
  if (section === 'actions') target.actions.push(parseActionSignal(value))
  if (section === 'contradictions') target.contradictions.push(parseContradictionSignal(value))
}
