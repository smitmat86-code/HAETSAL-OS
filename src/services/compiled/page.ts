// src/services/compiled/page.ts
// Phase 10 compiled pages: named person/project/topic views regenerable from
// canonical truth. Rebuild runs the existing compiled-synthesis compiler
// (dossier + context pack + what-changed persisted in canonical Postgres);
// the PAGE endpoint re-renders markdown from those persisted views, so a page
// is always reproducible from canonical state. Frontmatter carries canonical
// ids, source count, freshness, and review status. The D1 registry row is
// content-free (kind + caller-chosen slug + stable key + counts).

import type { Env } from '../../types/env'
import { compileProjectSynthesisFromCanonicalTruth } from '../compiled-synthesis-compile'
import { stableSubjectSegment } from '../compiled-synthesis-utils'
import { readCompiledChangeView, readCompiledContextPack, readCompiledDossier } from '../compiled-synthesis-read'
import { getCanonicalGovernanceStore } from '../canonical-governance-postgres'

export type CompiledPageKind = 'person' | 'project' | 'topic'

export interface CompiledPageRef {
  kind: CompiledPageKind
  key: string
  stableKey: string
  sourceCount: number
  updatedAt: number
}

const REGISTRY_DDL = `CREATE TABLE IF NOT EXISTS compiled_pages (
  tenant_id TEXT NOT NULL, kind TEXT NOT NULL, page_key TEXT NOT NULL,
  stable_key TEXT NOT NULL, segment TEXT NOT NULL DEFAULT '',
  source_count INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL, PRIMARY KEY (tenant_id, kind, page_key))`

export async function ensurePageRegistry(env: Env): Promise<void> {
  await env.D1_US.prepare(REGISTRY_DDL).run()
}

/** The compiler persists documents under family keys derived from the subject
 *  segment; 'project' here is the compiler's FIXED persistence namespace
 *  (assemble.ts hardcodes it for every kind) — if a kind-aware compiler ever
 *  changes that prefix, update this lookup in the same commit. */
export function familyKeys(segment: string): { dossier: string; pack: string; changes: string } {
  return {
    dossier: `dossier:project:${segment}`,
    pack: `context-pack:project:${segment}`,
    changes: `what-changed:project:${segment}`,
  }
}

export function pageStableKey(kind: CompiledPageKind, key: string): string {
  return `${kind}:${key}`
}

export async function rebuildCompiledPage(
  env: Env, tmk: CryptoKey, tenantId: string,
  input: { kind: CompiledPageKind; key: string; name: string; keywords?: string[] },
): Promise<CompiledPageRef> {
  const stableKey = pageStableKey(input.kind, input.key)
  // Kind-embedded subject key: person:alice vs project:alice never collide.
  const subjectKey = `${input.kind}-${input.key}`
  const result = await compileProjectSynthesisFromCanonicalTruth({
    tenantId,
    subject: { stableKey: subjectKey, name: input.name, scope: 'general', keywords: input.keywords, kind: input.kind },
    tmk,
  }, env)
  const segment = stableSubjectSegment(subjectKey, input.name)
  const sourceCount = result.sourceCount
  await ensurePageRegistry(env)
  const updatedAt = Date.now()
  await env.D1_US.prepare(
    `INSERT INTO compiled_pages (tenant_id, kind, page_key, stable_key, segment, source_count, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(tenant_id, kind, page_key) DO UPDATE SET segment = ?, source_count = ?, updated_at = ?`,
  ).bind(tenantId, input.kind, input.key, stableKey, segment, sourceCount, updatedAt, segment, sourceCount, updatedAt).run()
  return { kind: input.kind, key: input.key, stableKey, sourceCount, updatedAt }
}

export async function listCompiledPages(env: Env, tenantId: string): Promise<CompiledPageRef[]> {
  await ensurePageRegistry(env)
  const rows = await env.D1_US.prepare(
    `SELECT kind, page_key, stable_key, source_count, updated_at FROM compiled_pages
     WHERE tenant_id = ? ORDER BY updated_at DESC`,
  ).bind(tenantId).all<{ kind: CompiledPageKind; page_key: string; stable_key: string; source_count: number; updated_at: number }>()
  return (rows.results ?? []).map(r => ({
    kind: r.kind, key: r.page_key, stableKey: r.stable_key, sourceCount: r.source_count, updatedAt: r.updated_at,
  }))
}

/** Delete = deregister the page. The underlying compiled records stay in
 *  canonical (harmless; a rebuild overwrites them) — full row deletion is a
 *  Phase 13 store-surgery item. */
export async function deleteCompiledPage(env: Env, tenantId: string, kind: string, key: string): Promise<boolean> {
  await ensurePageRegistry(env)
  const result = await env.D1_US.prepare(
    'DELETE FROM compiled_pages WHERE tenant_id = ? AND kind = ? AND page_key = ?',
  ).bind(tenantId, kind, key).run()
  return (result.meta.changes ?? 0) > 0
}

/** Render the page markdown from PERSISTED canonical views (regenerable). */
export async function renderCompiledPage(
  env: Env, tenantId: string, kind: CompiledPageKind, key: string,
): Promise<string | null> {
  const stableKey = pageStableKey(kind, key)
  await ensurePageRegistry(env)
  const registered = await env.D1_US.prepare(
    'SELECT segment FROM compiled_pages WHERE tenant_id = ? AND kind = ? AND page_key = ?',
  ).bind(tenantId, kind, key).first<{ segment: string }>()
  if (!registered) return null
  const keys = familyKeys(registered.segment)
  const [dossier, pack, changes] = await Promise.all([
    readCompiledDossier(tenantId, keys.dossier, env),
    readCompiledContextPack(tenantId, keys.pack, env),
    readCompiledChangeView(tenantId, keys.changes, env),
  ])
  if (!dossier) return null
  const d = dossier.dossier
  const sources = dossier.sources ?? []
  const pendingReviews = await getCanonicalGovernanceStore(env)
    .listReviews(tenantId, 'pending', 100)
    .then(rows => rows.length).catch(() => 0)

  const lines: string[] = [
    '---',
    `title: ${d.subjectName}`,
    `kind: ${kind}`,
    `stable_key: ${stableKey}`,
    `compiled_document_id: ${dossier.document.id}`,
    `source_count: ${sources.length}`,
    `sources: [${sources.slice(0, 20).map(s => s.canonical_capture_id ?? s.canonical_document_id ?? '').filter(Boolean).join(', ')}]`,
    `freshness: ${new Date(dossier.document.updated_at ?? Date.now()).toISOString()}`,
    `review_status: ${pendingReviews > 0 ? `pending_reviews:${pendingReviews}` : 'clear'}`,
    'generated_by: the-brain',
    'regenerable: true',
    '---', '',
    `# ${d.subjectName}`,
  ]
  if (d.whyItMatters) lines.push('', '## Why it matters', d.whyItMatters)
  if (d.currentState) lines.push('', '## Current state', d.currentState)
  if (d.keyFacts?.length) lines.push('', '## Key facts', ...d.keyFacts.map(f => `- ${f.label}: ${f.summary}`))
  if (d.keyRelationships?.length) lines.push('', '## Relationships', ...d.keyRelationships.map(r => `- ${r.label}: ${r.summary}`))
  if (d.openQuestions?.length) lines.push('', '## Open questions', ...d.openQuestions.map(q => `- ${q.question}`))
  if (pack?.contextPack?.situation) lines.push('', '## Situation', pack.contextPack.situation)
  if (changes?.changeView?.changes?.length) {
    lines.push('', '## What changed recently',
      ...changes.changeView.changes.slice(0, 8).map(c => `- ${c.summary}`))
  }
  if (sources.length) {
    lines.push('', '## Sources',
      ...sources.slice(0, 15).map(s => `- ${s.canonical_capture_id ?? s.canonical_document_id ?? 'canonical'} (${s.source_role})`))
  }
  return lines.join('\n')
}
