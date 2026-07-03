// src/services/action/integrations/drafts.ts
// act_draft executor. note/plan drafts are retained as canonical captures
// (encrypted at rest, Law 2) with an operational pointer row in D1 that holds
// NO content. Gmail (email) drafts require Google OAuth (mission S5) and throw
// GmailNotConnectedError rather than a silent stub.

import type { Env } from '../../../types/env'
import type { IngestionArtifact } from '../../../types/ingestion'
import { retainContent } from '../../ingestion/retain'
import { GmailNotConnectedError } from './messaging'

export interface DraftResult {
  draftId: string
  captureId: string | null
  draftType: 'note' | 'plan'
}

export async function executeDraft(
  input: { title: string; content: string; draft_type?: string; action_id?: string },
  tenantId: string,
  tmk: CryptoKey,
  env: Env,
  ctx?: ExecutionContext,
): Promise<DraftResult> {
  if (input.draft_type === 'email') {
    // S5: Gmail draft needs Google OAuth. Fail honestly.
    throw new GmailNotConnectedError()
  }
  const draftType: 'note' | 'plan' = input.draft_type === 'plan' ? 'plan' : 'note'

  const artifact: IngestionArtifact = {
    tenantId,
    source: 'mcp_retain',
    content: `${input.title}\n\n${input.content}`,
    occurredAt: Date.now(),
    provenance: 'draft',
    memoryType: 'episodic',
    domain: 'general',
    metadata: { draft_type: draftType, draft_title: input.title },
    governance: { authorKind: 'user', legacyMemoryType: 'episodic', provenanceNote: 'draft' },
  }
  const retained = await retainContent(artifact, tmk, env, ctx)
  const captureId = retained?.canonicalCaptureId ?? null

  const draftId = crypto.randomUUID()
  const now = Date.now()
  await env.D1_US.prepare(
    `INSERT INTO action_drafts (id, tenant_id, action_id, capture_id, draft_type, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'draft', ?, ?)`,
  ).bind(draftId, tenantId, input.action_id ?? null, captureId, draftType, now, now).run()

  return { draftId, captureId, draftType }
}
