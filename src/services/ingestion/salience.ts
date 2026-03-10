// src/services/ingestion/salience.ts
// Salience scoring: classify content into Tier 1/2/3 for queue routing
// Tier 3: explicit retain, self-SMS, decision language + date, surprise >0.7
// Tier 2: named person + context, meetings, financial, known contact SMS
// Tier 1: routine/no entities/no decisions

import type { IngestionArtifact, SalienceResult } from '../../types/ingestion'

// Tier 3 patterns — high-value signals
const TIER_3_PATTERNS = [
  /\b(decided?|committed?|resolved?|will\s+not|must|promise[ds]?)\b/i,
  /\b(remember|don't\s+forget|important)\b/i,
  /\b\d{1,2}[/-]\d{1,2}[/-]\d{2,4}\b/,             // dates
  /\b(deadline|due\s+date|by\s+end\s+of)\b/i,
]

// Tier 2 patterns — moderate-value signals
const TIER_2_PATTERNS = [
  /\b[A-Z][a-z]+\s+[A-Z][a-z]+\b/,                 // named person (First Last)
  /\b(meeting|call|appointment|interview)\b/i,
  /\$\d+|\b\d+\s*(?:dollars?|usd|eur|gbp)\b/i,     // financial
  /\b(contract|agreement|offer|salary|raise)\b/i,
]

/**
 * Score content salience for queue routing
 * Surprise score stub: always 0.5 (Phase 3 refines with anomaly detection)
 */
export function scoreSalience(artifact: IngestionArtifact): SalienceResult {
  const { content, source, provenance } = artifact
  const reasons: string[] = []
  const surpriseScore = 0.5 // Stub — Phase 3 refines

  // Tier 3: explicit retain via MCP tool
  if (source === 'mcp_retain') {
    reasons.push('explicit_retain')
    return { tier: 3, surpriseScore, queue: 'QUEUE_HIGH', reasons }
  }

  // Tier 3: self-SMS (user texting themselves)
  if (source === 'sms' && provenance === 'self_sms') {
    reasons.push('self_sms')
    return { tier: 3, surpriseScore, queue: 'QUEUE_HIGH', reasons }
  }

  // Tier 3: decision language + date patterns
  let tier3Hits = 0
  for (const pattern of TIER_3_PATTERNS) {
    if (pattern.test(content)) {
      tier3Hits++
      reasons.push(`tier3_pattern:${pattern.source.slice(0, 30)}`)
    }
  }
  if (tier3Hits >= 2) {
    return { tier: 3, surpriseScore, queue: 'QUEUE_HIGH', reasons }
  }

  // Tier 2: named person + context, meetings, financial
  let tier2Hits = 0
  for (const pattern of TIER_2_PATTERNS) {
    if (pattern.test(content)) {
      tier2Hits++
      reasons.push(`tier2_pattern:${pattern.source.slice(0, 30)}`)
    }
  }
  if (tier2Hits >= 1) {
    return { tier: 2, surpriseScore, queue: 'QUEUE_HIGH', reasons }
  }

  // Tier 2: known contact SMS (any SMS from registered number)
  if (source === 'sms') {
    reasons.push('known_contact_sms')
    return { tier: 2, surpriseScore, queue: 'QUEUE_HIGH', reasons }
  }

  // Tier 1: routine / no entities / no decisions
  reasons.push('routine')
  return { tier: 1, surpriseScore, queue: 'QUEUE_NORMAL', reasons }
}
