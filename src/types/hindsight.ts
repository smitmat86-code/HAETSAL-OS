// src/types/hindsight.ts
// Typed contract for Hindsight memory engine API (v0.4.16 @ 58fdac4)
// Hindsight is accessed via service binding only (Law 1)

export interface HindsightRetainRequest {
  tenant_id: string
  content_encrypted: string   // base64 AES-256-GCM ciphertext
  memory_type: 'episodic' | 'semantic' | 'procedural' | 'world'
  domain: string
  provenance: string
  salience_tier: number
  occurred_at: number         // unix ms
  metadata?: Record<string, unknown>
}

export interface HindsightRetainResponse {
  memory_id: string           // Hindsight-generated UUID
  status: 'retained' | 'deferred'
}

export interface HindsightRecallRequest {
  tenant_id: string
  query_encrypted: string     // base64 encrypted query
  domain?: string
  mode?: 'default' | 'timeline'
  limit?: number
}

export interface HindsightRecallResponse {
  results: Array<{
    memory_id: string
    content_encrypted: string // base64 ciphertext — decrypt with TMK
    memory_type: string
    confidence: number
    relevance: number
  }>
}
