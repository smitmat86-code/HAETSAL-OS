import type { GraphProjectionEntity, GraphProjectionEntityKind } from '../types/canonical-graph-projection'

export type BodyRelationCandidate = {
  from: { label: string; kind: GraphProjectionEntityKind }
  to: { label: string; kind: GraphProjectionEntityKind }
  relation: 'leads' | 'partnered_with' | 'met_with' | 'depends_on'
  validAt: number | null
}

type RelationPattern = {
  relation: BodyRelationCandidate['relation']
  regex: RegExp
  resolveKinds: (left: string, right: string) => {
    leftKind: GraphProjectionEntityKind
    rightKind: GraphProjectionEntityKind
  } | null
}

const PERSON_STOPWORDS = new Set(['Assistant', 'I', 'It', 'Monday', 'The', 'They', 'Thursday', 'Today', 'Tomorrow', 'Tuesday', 'User', 'Wednesday', 'We', 'Yesterday'])
const ORG_HINTS = ['agency', 'company', 'corp', 'corporation', 'foundation', 'group', 'inc', 'labs', 'llc', 'partners', 'school', 'studio', 'systems', 'team', 'university']
const PROJECT_HINTS = ['api', 'checklist', 'initiative', 'launch', 'migration', 'milestone', 'plan', 'platform', 'program', 'project', 'roadmap', 'rollout', 'service', 'system']
const DATE_FRAGMENT = '(?:\\d{4}-\\d{2}-\\d{2}|(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\\s+\\d{1,2},\\s+\\d{4})'
const ENTITY_FRAGMENT = '[A-Z][A-Za-z0-9&.-]*(?:\\s+[A-Z][A-Za-z0-9&.-]*){0,5}'

function slugify(value: string | null | undefined): string | null {
  const normalized = value?.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
  return normalized || null
}

function normalizeEntityLabel(value: string | null | undefined): string | null {
  return value?.trim().replace(/^[("'`]+|[)"'`.,;:!?]+$/g, '').replace(/\s+/g, ' ') || null
}

function titleCase(value: string): string {
  return value.replace(/\b([a-z])/g, (_, letter: string) => letter.toUpperCase())
}

function looksLikePersonName(value: string): boolean {
  const label = normalizeEntityLabel(value)
  if (!label || PERSON_STOPWORDS.has(label)) return false
  const parts = label.split(' ')
  return parts.length <= 3
    && !parts.some(part => ORG_HINTS.includes(part.toLowerCase()) || PROJECT_HINTS.includes(part.toLowerCase()))
    && parts.every(part => /^[A-Z][A-Za-z0-9.-]*$/.test(part))
}

function inferWorkEntityKind(label: string, fallback: 'organization' | 'project'): GraphProjectionEntityKind {
  const parts = label.toLowerCase().split(/[^a-z0-9]+/)
  if (ORG_HINTS.some(hint => parts.includes(hint))) return 'organization'
  if (PROJECT_HINTS.some(hint => parts.includes(hint))) return 'project'
  return fallback
}

const RELATION_PATTERNS: RelationPattern[] = [
  { relation: 'leads', regex: new RegExp(`(?<left>${ENTITY_FRAGMENT})\\s+leads\\s+(?<right>${ENTITY_FRAGMENT})(?:\\s+on\\s+(?<date>${DATE_FRAGMENT}))?`, 'g'), resolveKinds: (_left, right) => ({ leftKind: 'person', rightKind: inferWorkEntityKind(right, 'project') }) },
  { relation: 'partnered_with', regex: new RegExp(`(?<left>${ENTITY_FRAGMENT})\\s+partnered\\s+with\\s+(?<right>${ENTITY_FRAGMENT})(?:\\s+on\\s+(?<date>${DATE_FRAGMENT}))?`, 'g'), resolveKinds: (left, right) => ({ leftKind: inferWorkEntityKind(left, 'organization'), rightKind: inferWorkEntityKind(right, 'organization') }) },
  { relation: 'met_with', regex: new RegExp(`(?<left>${ENTITY_FRAGMENT})\\s+met\\s+(?:with\\s+)?(?<right>${ENTITY_FRAGMENT})(?:\\s+on\\s+(?<date>${DATE_FRAGMENT}))?`, 'g'), resolveKinds: (left, right) => looksLikePersonName(left) && looksLikePersonName(right) ? { leftKind: 'person', rightKind: 'person' } : null },
  { relation: 'depends_on', regex: new RegExp(`(?<left>${ENTITY_FRAGMENT})\\s+depends\\s+on\\s+(?<right>${ENTITY_FRAGMENT})(?:\\s+on\\s+(?<date>${DATE_FRAGMENT}))?`, 'g'), resolveKinds: (left, right) => ({ leftKind: inferWorkEntityKind(left, 'project'), rightKind: inferWorkEntityKind(right, 'project') }) },
]

export function buildCanonicalGraphEntityKey(kind: GraphProjectionEntityKind, label: string): string {
  const path = kind === 'person' ? 'people' : kind === 'organization' ? 'organizations' : kind === 'project' ? 'projects' : kind === 'topic' ? 'topics' : `${kind}s`
  return `canonical://${path}/${slugify(label) ?? encodeURIComponent(label)}`
}

export function buildCanonicalGraphEdgeKey(fromCanonicalKey: string, relation: string, toCanonicalKey: string, validAt?: number | null): string {
  return `canonical://edges/${encodeURIComponent(fromCanonicalKey)}:${relation}:${encodeURIComponent(toCanonicalKey)}${validAt ? `@${validAt}` : ''}`
}

export function buildBodyGraphEntity(label: string, kind: GraphProjectionEntityKind): GraphProjectionEntity {
  return { canonicalKey: buildCanonicalGraphEntityKey(kind, label), kind, label: kind === 'person' ? titleCase(label) : label, identityStrategy: 'content_extracted', source: 'content_candidate' }
}

function parseExplicitDate(value: string | null | undefined): number | null {
  const raw = value?.trim()
  if (!raw) return null
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    const [year, month, day] = raw.split('-').map(Number)
    return Date.UTC(year, month - 1, day)
  }
  const parsed = Date.parse(`${raw} UTC`)
  return Number.isNaN(parsed) ? null : parsed
}

export function extractBodyRelationCandidates(body: string | null | undefined, capturedAt: number | null | undefined): BodyRelationCandidate[] {
  if (!body?.trim()) return []
  const cleaned = body.split(/\r?\n+/).map(line => line.replace(/^\s*(User|Assistant):\s*/i, '').trim()).filter(Boolean).join('. ')
  const candidates: BodyRelationCandidate[] = []
  for (const pattern of RELATION_PATTERNS) {
    for (const match of cleaned.matchAll(pattern.regex)) {
      const leftLabel = normalizeEntityLabel(match.groups?.left)
      const rightLabel = normalizeEntityLabel(match.groups?.right)
      if (!leftLabel || !rightLabel || leftLabel === rightLabel) continue
      const kinds = pattern.resolveKinds(leftLabel, rightLabel)
      if (!kinds) continue
      candidates.push({ from: { label: leftLabel, kind: kinds.leftKind }, to: { label: rightLabel, kind: kinds.rightKind }, relation: pattern.relation, validAt: parseExplicitDate(match.groups?.date) ?? capturedAt ?? null })
    }
  }
  return candidates
}
