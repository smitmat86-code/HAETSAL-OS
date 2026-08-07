// src/types/ops-alert.ts
// M4 ops-alert ingress contracts (spec m4-ops-alert-ingress).

export type OpsAlertSeverity = 'page' | 'notice'

/** Registry row — adding a source is a D1 INSERT, never code. */
export interface OpsAlertSource {
  id: string
  tenant_id: string
  token_sha256: string
  default_severity: OpsAlertSeverity
  dedupe_window_s: number
  enabled: number
}

/** Wire payload. `text` is the minimal-sender shape (health canary). */
export interface OpsAlertPayload {
  source?: string
  severity?: string
  title?: string
  body?: string
  dedupe_key?: string
  text?: string
}

export interface NormalizedOpsAlert {
  severity: OpsAlertSeverity
  title: string
  body: string
  dedupeKey: string
}

export type OpsAlertOutcome = 'paged' | 'page_failed' | 'noticed' | 'duplicate'

export interface OpsAlertResult {
  outcome: OpsAlertOutcome
  alertId: string
  source: string
  severity: OpsAlertSeverity
}
