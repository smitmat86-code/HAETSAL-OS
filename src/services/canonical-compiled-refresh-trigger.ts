import type { Env } from '../types/env'
import { triggerCompiledRefreshFromCanonicalWrite } from './compiled-synthesis-trigger'

export async function maybeTriggerCompiledRefresh(
  args: {
    tenantId: string
    scope: string
    sourceSystem: string
    sourceRef?: string | null
    title?: string | null
    body: string
    captureId: string
    documentId: string
    artifactId: string | null
    operationId: string
    tmk: CryptoKey | null
  },
  env: Env,
  ctx?: Pick<ExecutionContext, 'waitUntil'>,
): Promise<void> {
  if (!args.tmk) return

  const trigger = async () => {
    const result = await triggerCompiledRefreshFromCanonicalWrite({
      tenantId: args.tenantId,
      scope: args.scope,
      sourceSystem: args.sourceSystem,
      sourceRef: args.sourceRef ?? null,
      title: args.title ?? null,
      body: args.body,
      captureId: args.captureId,
      documentId: args.documentId,
      artifactId: args.artifactId,
      operationId: args.operationId,
      tmk: args.tmk,
    }, env)

    if (result.failed.length > 0) {
      console.error('COMPILED_REFRESH_TRIGGER_FAILED', {
        tenantId: args.tenantId,
        captureId: args.captureId,
        documentId: args.documentId,
        errors: result.failed,
      })
    }
  }

  if (ctx?.waitUntil) {
    ctx.waitUntil(trigger())
    return
  }
  await trigger()
}
