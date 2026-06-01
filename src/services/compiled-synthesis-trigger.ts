import type { Env } from '../types/env'
import { buildCanonicalCompiledChangeEvent } from './compiled-synthesis-trigger-extract'
import { dispatchTargetedCompiledRefresh } from './compiled-synthesis-trigger-dispatch'
import { planTargetedCompiledRefresh } from './compiled-synthesis-trigger-plan'
import type { DispatchTargetedCompiledRefreshResult } from './compiled-synthesis-trigger-types'

interface TriggerCompiledRefreshFromCanonicalWriteInput {
  tenantId: string
  scope: string
  sourceSystem: string
  sourceRef?: string | null
  title?: string | null
  body: string
  captureId?: string | null
  documentId?: string | null
  artifactId?: string | null
  operationId?: string | null
  tmk: CryptoKey | null
}

export async function triggerCompiledRefreshFromCanonicalWrite(
  input: TriggerCompiledRefreshFromCanonicalWriteInput,
  env: Env,
): Promise<DispatchTargetedCompiledRefreshResult> {
  const event = buildCanonicalCompiledChangeEvent({
    tenantId: input.tenantId,
    changeType: 'capture_created',
    scope: input.scope,
    sourceSystem: input.sourceSystem,
    sourceRef: input.sourceRef ?? null,
    title: input.title ?? null,
    body: input.body,
    captureId: input.captureId ?? null,
    documentId: input.documentId ?? null,
    artifactId: input.artifactId ?? null,
    operationId: input.operationId ?? null,
  })
  const plan = planTargetedCompiledRefresh(event)
  return dispatchTargetedCompiledRefresh(plan, env, { tmk: input.tmk })
}

export { buildCanonicalCompiledChangeEvent } from './compiled-synthesis-trigger-extract'
export { dispatchTargetedCompiledRefresh } from './compiled-synthesis-trigger-dispatch'
export { planTargetedCompiledRefresh } from './compiled-synthesis-trigger-plan'
export type * from './compiled-synthesis-trigger-types'
