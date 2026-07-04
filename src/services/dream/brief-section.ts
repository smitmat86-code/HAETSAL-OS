// src/services/dream/brief-section.ts
// Morning-brief section for the previous night's dream cycle (demo clause 9).
// Reads the run row from D1 (content-free) and the report body from canonical
// through the document read path (tenant key required — same discipline as
// every other content-bearing brief section).

import type { Env } from '../../types/env'
import { getCanonicalDocument } from '../canonical-memory-query'
import { latestDreamRun } from './report'

const MAX_SECTION_CHARS = 900
const FRESH_WINDOW_MS = 26 * 3600_000

export async function fetchDreamSection(tenantId: string, kek: CryptoKey, env: Env): Promise<string> {
  const run = await latestDreamRun(env, tenantId).catch(() => null)
  if (!run || !run.completed_at || Date.now() - run.completed_at > FRESH_WINDOW_MS) return ''
  if (!run.report_document_id) {
    return `  Dream cycle ran (${run.events_seen} memories reviewed, ${run.proposals_written} proposals filed) — report unavailable.`
  }
  try {
    const doc = await getCanonicalDocument(
      { tenantId, documentId: run.report_document_id }, env, tenantId, { tmk: kek },
    )
    const body = doc.body.split('\n').slice(1).join('\n').trim() // drop the title line
    const clipped = body.length > MAX_SECTION_CHARS
      ? body.slice(0, MAX_SECTION_CHARS).replace(/\n[^\n]*$/, '') + '\n  …(full report in the dashboard)'
      : body
    return clipped.split('\n').map(line => `  ${line}`).join('\n')
  } catch {
    return `  Dream cycle ran (${run.proposals_written} proposals filed to the review inbox).`
  }
}
