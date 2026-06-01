import type { Env } from '../types/env'
import { sha256Hex } from './canonical-memory-artifacts'
import { readCanonicalDocumentBody } from './canonical-memory-read-model'
import { getCanonicalMemoryStore } from './canonical-postgres'
import type {
  CanonicalCompilationSelection,
  CompileProjectSynthesisFromCanonicalTruthInput,
  ProjectCompilationSubject,
  SelectedCanonicalCompilationSource,
} from './compiled-synthesis-compiler-types'

function clampSourceLimit(value: number | undefined): number {
  if (!Number.isFinite(value)) return 6
  return Math.min(Math.max(Math.trunc(value ?? 6), 2), 12)
}

function scoreTermMatches(text: string, terms: string[]): number {
  const haystack = text.toLowerCase()
  return terms.reduce((score, term) => {
    const needle = term.trim().toLowerCase()
    if (!needle) return score
    if (!haystack.includes(needle)) return score
    return score + (needle.length >= 5 ? 3 : 1)
  }, 0)
}

function scoreSourceDocument(
  subject: ProjectCompilationSubject,
  row: {
    title: string | null
    sourceRef: string | null
    body: string
    scope: string
  },
): number {
  const terms = [subject.name, ...(subject.keywords ?? [])]
  return scoreTermMatches(
    [row.title ?? '', row.sourceRef ?? '', row.body, row.scope].join('\n'),
    terms,
  )
}

function compareSources(
  left: SelectedCanonicalCompilationSource,
  right: SelectedCanonicalCompilationSource,
): number {
  return right.score - left.score
    || right.capturedAt - left.capturedAt
    || right.documentId.localeCompare(left.documentId)
}

export async function selectProjectCompilationSources(
  input: CompileProjectSynthesisFromCanonicalTruthInput,
  env: Env,
): Promise<CanonicalCompilationSelection> {
  const store = getCanonicalMemoryStore(env)
  const limit = clampSourceLimit(input.sourceLimit)
  const candidates = await store.listRecentDocuments(input.tenantId, input.subject.scope, Math.max(limit * 3, 12))

  const hydrated = await Promise.all(candidates.map(async (candidate) => {
    const detail = await store.getDocument(input.tenantId, candidate.document_id)
    if (!detail) return null
    const body = await readCanonicalDocumentBody(env, detail.body_r2_key, input.tmk)
    const source: SelectedCanonicalCompilationSource = {
      captureId: detail.capture_id,
      documentId: detail.document_id,
      title: detail.title,
      sourceSystem: detail.source_system,
      sourceRef: detail.source_ref,
      scope: detail.scope,
      capturedAt: detail.captured_at,
      body,
      bodyR2Key: detail.body_r2_key,
      artifactId: detail.artifact_id,
      artifactR2Key: detail.r2_key,
      artifactMediaType: detail.media_type,
      score: scoreSourceDocument(input.subject, {
        title: detail.title,
        sourceRef: detail.source_ref,
        body,
        scope: detail.scope,
      }),
    }
    return source
  }))

  const scored = hydrated.filter((row): row is SelectedCanonicalCompilationSource => Boolean(row))
    .sort(compareSources)
  const selected = (scored.some((row) => row.score > 0)
    ? scored.filter((row) => row.score > 0)
    : scored).slice(0, limit)

  if (selected.length === 0) {
    throw new Error(`No canonical sources available for ${input.subject.name} in scope ${input.subject.scope}`)
  }

  const sourceFingerprint = await sha256Hex(JSON.stringify(
    selected.map((row) => ({
      captureId: row.captureId,
      documentId: row.documentId,
      artifactId: row.artifactId,
      capturedAt: row.capturedAt,
    })),
  ))

  return {
    tenantId: input.tenantId,
    subject: input.subject,
    documents: selected,
    sourceFingerprint,
    artifactVersion: `source-${sourceFingerprint.slice(0, 12)}`,
    sourceLinks: selected.map((row) => ({
      sourceRole: row.score > 0 ? 'primary' : 'supporting',
      canonicalCaptureId: row.captureId,
      canonicalDocumentId: row.documentId,
      canonicalArtifactId: row.artifactId,
    })),
    sourceRefs: selected.map((row) => ({
      label: row.title ?? row.sourceRef ?? row.documentId,
      sourceRole: row.score > 0 ? 'primary' : 'supporting',
      canonicalCaptureId: row.captureId,
      canonicalDocumentId: row.documentId,
      canonicalArtifactId: row.artifactId,
      r2Key: row.bodyR2Key,
    })),
  }
}
