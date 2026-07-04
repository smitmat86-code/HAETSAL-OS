// src/services/dream/types.ts
// Phase 8 dream-cycle shapes. Findings are REVIEWABLE PROPOSALS — the cycle
// never mutates entities/claims/facts directly (report-only mode); promotion
// happens later through the existing review/promotion path.

export type DreamFindingKind =
  | 'contradiction'
  | 'supersession'
  | 'promotion'
  | 'entity_link'
  | 'gap'

export interface DreamFinding {
  kind: DreamFindingKind
  /** One-line statement of the finding (content — lives in canonical only). */
  statement: string
  /** Short model rationale (content — canonical only). */
  rationale: string
  /** 0..1 model confidence; proposals below the floor are dropped. */
  confidence: number
  /** Optional canonical references (event/capture ids) backing the finding. */
  refs: string[]
}

export interface DreamFindings {
  facts: string[]
  contradictions: DreamFinding[]
  supersessions: DreamFinding[]
  promotions: DreamFinding[]
  entityLinks: DreamFinding[]
  gaps: DreamFinding[]
}

export interface DreamCounts {
  eventsSeen: number
  proposalsWritten: number
  contradictions: number
  supersessions: number
  promotions: number
  gaps: number
}

export interface DreamRunRow {
  id: string
  tenant_id: string
  run_date: string
  started_at: number
  completed_at: number | null
  status: string
  trigger: string
  events_seen: number
  proposals_written: number
  contradictions: number
  supersessions: number
  promotions: number
  gaps: number
  report_capture_id: string | null
  report_document_id: string | null
  error_message: string | null
}

export const DREAM_CONFIDENCE_FLOOR = 0.5
export const DREAM_WINDOW_EVENT_LIMIT = 40
export const DREAM_REPORT_SCOPE = 'dream_report'
