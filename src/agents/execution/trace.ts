// src/agents/execution/trace.ts
// Phase 9 structured reasoning traces for execution runs. The full trace
// (task, tool usage, result) is AES-GCM encrypted with the tenant key before
// it touches R2 (Law 2) — same discipline as the legacy BaseAgent traces.
// Fire-and-forget: trace persistence must never fail a run.

import type { Env } from '../../types/env'
import { encryptForR2 } from '../helpers'
import type { ExecutionLoopResult } from './types'

export interface ExecutionTrace {
  runId: string
  tenantId: string
  profile: string
  task: string
  status: ExecutionLoopResult['status'] | 'error'
  turns: number
  toolCalls: number
  toolsUsed: string[]
  resultText?: string
  startedAt: number
  endedAt: number
}

export async function persistExecutionTrace(
  env: Env,
  tmk: CryptoKey,
  trace: ExecutionTrace,
): Promise<void> {
  try {
    const encrypted = await encryptForR2(JSON.stringify(trace), tmk)
    await env.R2_OBSERVABILITY.put(`traces/${trace.tenantId}/exec-${trace.runId}`, encrypted)
  } catch { /* observability is best-effort */ }
}
