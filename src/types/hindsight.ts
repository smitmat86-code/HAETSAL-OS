export interface HindsightRetainItem {
  content: string
  context?: string
  document_id?: string
  timestamp?: string
  tags?: string[]
  metadata?: Record<string, string>
}

export interface HindsightRetainRequest {
  async?: boolean
  items: HindsightRetainItem[]
}

export interface HindsightRetainResponse {
  success?: boolean
  bank_id?: string | null
  items_count?: number
  async?: boolean
  operation_id?: string | null
}

export interface HindsightRecallRequest {
  query: string
  budget?: 'low' | 'mid' | 'high' | string
  max_tokens?: number
  query_timestamp?: string
  tags?: string[]
  tags_match?: 'all_strict' | 'any' | string
}

export interface HindsightRecallResult {
  id?: string
  memory_id?: string
  document_id?: string
  source_document_id?: string
  target_ref?: string
  text?: string
  content?: string
  content_preview?: string
  summary?: string
  score?: number
  relevance?: number
  confidence?: number
  metadata?: Record<string, unknown>
}

export interface HindsightRecallResponse {
  text?: string
  results?: HindsightRecallResult[]
  items?: HindsightRecallResult[]
  memories?: HindsightRecallResult[]
}

export interface HindsightReflectRequest {
  query: string
  response_schema?: Record<string, unknown>
  budget?: 'low' | 'mid' | 'high' | string
  max_tokens?: number
  tags?: string[]
  tags_match?: 'all_strict' | 'any' | string
}

export interface HindsightReflectResponse<TStructured = unknown> {
  text?: string
  data?: TStructured
}

export interface HindsightMentalModelResponse {
  id?: string
  [key: string]: unknown
}

export interface HindsightMentalModelListResponse {
  items?: HindsightMentalModelResponse[]
}

export interface HindsightWebhookListResponse {
  items?: Array<Record<string, unknown>>
}

export interface HindsightOperationsListResponse {
  items?: Array<Record<string, unknown>>
}

export interface HindsightOperationStatusResponse {
  operation_id?: string
  status?: string
  operation_type?: string
  created_at?: string
  updated_at?: string
  completed_at?: string | null
  error_message?: string | null
}

export interface HindsightDocumentSummary {
  id?: string
  bank_id?: string
  memory_unit_count?: number
  created_at?: string
  updated_at?: string
}
