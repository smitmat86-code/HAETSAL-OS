// src/cron/passes/pass4-gaps.ts
// Gap identification — uses Hindsight /reflect with response_schema
// Gaps are D1 metadata (what to ask), not content (what we know)
// No encryption needed — structural only

import type { Env } from '../../types/env'

interface GapResult { question: string; domain: string; priority: 'high' | 'medium' | 'low' }

export async function runPass4(
  bankId: string, tenantId: string, runId: string, env: Env,
): Promise<number> {
  const reflectRes = await env.HINDSIGHT.fetch(
    `http://hindsight/v1/default/banks/${bankId}/reflect`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query: `What important questions about this person remain unanswered?
          What decisions are pending or deferred? What areas seem underexplored
          given what we know?`,
        budget: 'mid',
        response_schema: {
          type: 'object',
          required: ['gaps'],
          properties: {
            gaps: {
              type: 'array',
              items: {
                type: 'object',
                required: ['question', 'domain', 'priority'],
                properties: {
                  question: { type: 'string' },
                  domain: { type: 'string' },
                  priority: { type: 'string', enum: ['high', 'medium', 'low'] },
                },
              },
            },
          },
        },
        tags: [`tenant:${tenantId}`],
      }),
    },
  )
  if (!reflectRes.ok) return 0

  const data = await reflectRes.json() as { structured_output?: { gaps: GapResult[] } }
  const gaps = data.structured_output?.gaps ?? []

  // Write top 3 gaps to consolidation_gaps D1 table
  let count = 0
  for (const gap of gaps.slice(0, 3)) {
    await env.D1_US.prepare(
      `INSERT OR IGNORE INTO consolidation_gaps
       (id, tenant_id, run_id, question, domain, priority, surfaced, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 0, ?)`,
    ).bind(crypto.randomUUID(), tenantId, runId, gap.question, gap.domain, gap.priority, Date.now()).run()
    count++
  }
  return count
}
