import { slugifyStableSegment } from './compiled-synthesis-utils'
import type {
  CanonicalCompiledChangeEvent,
  CanonicalCompiledChangeType,
  CanonicalCompiledSubjectHint,
} from './compiled-synthesis-trigger-types'

interface BuildCanonicalCompiledChangeEventInput {
  tenantId: string
  changeType: CanonicalCompiledChangeType
  scope: string
  sourceSystem: string
  sourceRef?: string | null
  title?: string | null
  body: string
  captureId?: string | null
  documentId?: string | null
  artifactId?: string | null
  operationId?: string | null
}

function trimOrNull(value?: string | null): string | null {
  const trimmed = value?.trim()
  return trimmed ? trimmed : null
}

function titleCaseSlug(value: string): string {
  return value
    .split('-')
    .filter(Boolean)
    .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
    .join(' ')
}

function sourceRefProjectSlug(sourceRef: string | null): string | null {
  if (!sourceRef || sourceRef.includes('brain-memory:')) return null
  const firstSegment = sourceRef.split('/')[0]?.trim() ?? ''
  if (!firstSegment || !/[a-z0-9]/i.test(firstSegment)) return null
  const slug = slugifyStableSegment(firstSegment)
  return slug || null
}

function titleProjectName(title: string | null): string | null {
  if (!title) return null
  const normalized = title
    .replace(/\b(operating note|staffing note|launch packet note|note|update|summary|brief|memo)\b.*$/i, '')
    .trim()
  return normalized || null
}

function bodyProjectName(body: string): string | null {
  const lines = body.split('\n').map((line) => line.trim()).filter(Boolean)
  const cues = ['Why It Matters:', 'Current State:']
  for (const cue of cues) {
    const line = lines.find((item) => item.startsWith(cue))
    if (!line) continue
    const remainder = line.slice(cue.length).trim()
    const match = remainder.match(/^([A-Z][A-Za-z0-9]+(?: [A-Z][A-Za-z0-9]+){0,3})/)
    if (match?.[1]) return match[1].trim()
  }
  return null
}

function dedupeHints(hints: CanonicalCompiledSubjectHint[]): CanonicalCompiledSubjectHint[] {
  const seen = new Set<string>()
  return hints.filter((hint) => {
    const key = `${hint.subjectKind}:${hint.stableKey}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function projectHintFrom(input: BuildCanonicalCompiledChangeEventInput): CanonicalCompiledSubjectHint | null {
  if (input.scope !== 'projects') return null

  const sourceSlug = sourceRefProjectSlug(trimOrNull(input.sourceRef))
  const titleName = titleProjectName(trimOrNull(input.title))
  const bodyName = bodyProjectName(input.body)
  const name = trimOrNull(titleName ?? bodyName ?? (sourceSlug ? titleCaseSlug(sourceSlug) : null))
  const stableSegment = slugifyStableSegment(sourceSlug ?? name ?? '')
  if (!name || !stableSegment) return null

  const evidence = sourceSlug ? 'source_ref' : titleName ? 'title' : 'body'
  const keywordSet = new Set<string>()
  keywordSet.add(name)
  if (titleName && titleName !== name) keywordSet.add(titleName)
  if (bodyName && bodyName !== name) keywordSet.add(bodyName)

  return {
    subjectKind: 'project',
    stableKey: `entity:project:${stableSegment}`,
    name,
    scope: input.scope,
    keywords: [...keywordSet],
    evidence,
  }
}

export function buildCanonicalCompiledChangeEvent(
  input: BuildCanonicalCompiledChangeEventInput,
): CanonicalCompiledChangeEvent {
  return {
    tenantId: input.tenantId,
    changeType: input.changeType,
    scope: input.scope,
    sourceSystem: input.sourceSystem,
    sourceRef: trimOrNull(input.sourceRef),
    title: trimOrNull(input.title),
    changedRecords: {
      captureId: input.captureId ?? null,
      documentId: input.documentId ?? null,
      artifactId: input.artifactId ?? null,
      operationId: input.operationId ?? null,
    },
    subjectHints: dedupeHints([
      projectHintFrom(input),
    ].filter((hint): hint is CanonicalCompiledSubjectHint => Boolean(hint))),
  }
}
