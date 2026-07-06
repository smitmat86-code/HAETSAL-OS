// src/services/dream/extract.ts
// Dream-cycle signal extraction: one bounded MODEL_DEEP pass over the recent
// canonical window (previews only, hard char cap) producing new facts,
// contradictions, supersessions, promotion candidates, entity links, and
// gaps. G4: AI Gateway with collectLog:false — the prompt carries tenant
// content. Output parsing is defensive; a malformed model reply degrades to
// an empty findings set, never a crash.

import type { Env } from '../../types/env'
import { MODEL_DEEP } from '../../config/models'
import {
  DREAM_CONFIDENCE_FLOOR, type DreamFinding, type DreamFindingKind, type DreamFindings,
} from './types'

const MAX_WINDOW_CHARS = 9000
const MAX_FINDINGS_PER_KIND = 6

export interface DreamWindowItem {
  ref: string
  when: number
  text: string
}

export function buildWindowBlock(items: DreamWindowItem[]): string {
  const lines: string[] = []
  let used = 0
  for (const item of items) {
    const line = `[${item.ref} ${new Date(item.when).toISOString().slice(0, 16)}] ${item.text.replace(/\s+/g, ' ').slice(0, 400)}`
    if (used + line.length > MAX_WINDOW_CHARS) break
    lines.push(line)
    used += line.length
  }
  return lines.join('\n')
}

// Exported for the System panel registry (read-only display).
export const DREAM_EXTRACT_PROMPT = `You are the nightly consolidation pass of a personal memory system. Review the recent memory window and existing relationship summaries, then answer in STRICT JSON:
{"facts": ["stable new fact learned this window", ...],
 "contradictions": [{"statement": "...", "rationale": "...", "confidence": 0.0, "refs": ["id"]}],
 "supersessions": [{"statement": "newer info replaces older info X", "rationale": "...", "confidence": 0.0, "refs": []}],
 "promotions": [{"statement": "candidate durable preference/pattern", "rationale": "seen repeatedly", "confidence": 0.0, "refs": []}],
 "entity_links": [{"statement": "PERSON/PROJECT A relates to B (relation)", "rationale": "...", "confidence": 0.0, "refs": []}],
 "gaps": [{"statement": "missing knowledge the user likely wants captured", "rationale": "...", "confidence": 0.0, "refs": []}]}
Rules: max ${MAX_FINDINGS_PER_KIND} per list; empty lists are fine; confidence in [0,1]; be conservative — only findings grounded in the window. JSON only, no prose.`

export async function extractDreamFindings(
  env: Env,
  windowBlock: string,
  edgesBlock: string,
): Promise<DreamFindings> {
  const result = await (env.AI as { run: (m: string, i: unknown, o?: unknown) => Promise<unknown> }).run(
    MODEL_DEEP,
    {
      messages: [
        { role: 'system', content: DREAM_EXTRACT_PROMPT },
        { role: 'user', content: `Recent memory window:\n${windowBlock || '(empty)'}\n\nKnown relationships:\n${edgesBlock || '(none)'}` },
      ],
      max_tokens: 1600,
    },
    { gateway: { id: env.AI_GATEWAY_ID, collectLog: false } },
  )
  return parseFindings(result)
}

export function parseFindings(result: unknown): DreamFindings {
  const empty: DreamFindings = { facts: [], contradictions: [], supersessions: [], promotions: [], entityLinks: [], gaps: [] }
  const text = typeof result === 'string' ? result : (result as { response?: string })?.response ?? ''
  const jsonMatch = /\{[\s\S]*\}/.exec(text)
  if (!jsonMatch) return empty
  let parsed: Record<string, unknown>
  try { parsed = JSON.parse(jsonMatch[0]) as Record<string, unknown> } catch { return empty }
  return {
    facts: readStrings(parsed.facts),
    contradictions: readFindings(parsed.contradictions, 'contradiction'),
    supersessions: readFindings(parsed.supersessions, 'supersession'),
    promotions: readFindings(parsed.promotions, 'promotion'),
    entityLinks: readFindings(parsed.entity_links, 'entity_link'),
    gaps: readFindings(parsed.gaps, 'gap'),
  }
}

function readStrings(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((v): v is string => typeof v === 'string' && v.trim().length > 3)
    .map(v => v.trim().slice(0, 300)).slice(0, MAX_FINDINGS_PER_KIND)
}

function readFindings(value: unknown, kind: DreamFindingKind): DreamFinding[] {
  if (!Array.isArray(value)) return []
  const findings: DreamFinding[] = []
  for (const raw of value.slice(0, MAX_FINDINGS_PER_KIND)) {
    const record = raw as { statement?: unknown; rationale?: unknown; confidence?: unknown; refs?: unknown }
    const statement = typeof record?.statement === 'string' ? record.statement.trim().slice(0, 400) : ''
    if (statement.length < 4) continue
    const confidence = typeof record.confidence === 'number' ? Math.max(0, Math.min(1, record.confidence)) : 0
    if (confidence < DREAM_CONFIDENCE_FLOOR) continue
    findings.push({
      kind,
      statement,
      rationale: typeof record.rationale === 'string' ? record.rationale.trim().slice(0, 400) : '',
      confidence,
      refs: Array.isArray(record.refs) ? record.refs.filter((r): r is string => typeof r === 'string').slice(0, 6) : [],
    })
  }
  return findings
}
