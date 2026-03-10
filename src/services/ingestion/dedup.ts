// src/services/ingestion/dedup.ts
// Content deduplication: SHA-256 of source + normalized content
// LESSON: INSERT OR IGNORE on ingestion_events.dedup_hash for at-least-once safety

import type { IngestionSource } from '../../types/ingestion'
import type { Env } from '../../types/env'

/**
 * Normalize content for dedup: collapse whitespace, lowercase
 */
function normalize(content: string): string {
  return content.replace(/\s+/g, ' ').trim().toLowerCase()
}

/**
 * Compute SHA-256 dedup hash from source + normalized content
 */
export async function computeDedupHash(
  source: IngestionSource,
  content: string,
): Promise<string> {
  const input = `${source}:${normalize(content)}`
  const data = new TextEncoder().encode(input)
  const hash = await crypto.subtle.digest('SHA-256', data)
  return Array.from(new Uint8Array(hash))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('')
}

/**
 * Check if content already exists for this tenant (dedup hit)
 * Returns true if duplicate exists — caller should skip
 */
export async function checkDedup(
  hash: string,
  tenantId: string,
  env: Env,
): Promise<boolean> {
  const result = await env.D1_US.prepare(
    `SELECT 1 FROM ingestion_events WHERE dedup_hash = ? AND tenant_id = ?`,
  ).bind(hash, tenantId).first()
  return result !== null
}
