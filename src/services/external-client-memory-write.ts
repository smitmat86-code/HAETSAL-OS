import type { Env } from '../types/env'
import type { ExternalClientCaptureInput } from '../types/external-client-memory'
import { retainViaService } from '../tools/retain'
import {
  BRAIN_MEMORY_SURFACE_PROFILE,
  normalizeExternalClientCapture,
  usesBrainMemoryRollout,
} from './external-client-memory'

export async function captureExternalClientMemory(
  input: ExternalClientCaptureInput,
  tenantId: string,
  tmk: CryptoKey | null,
  env: Env,
  ctx?: Pick<ExecutionContext, 'waitUntil'>,
): Promise<Record<string, unknown>> {
  if (!usesBrainMemoryRollout(input)) {
    return {
      ...(await retainViaService({
        content: input.content,
        domain: input.scope ?? 'general',
        memory_type: input.memory_type,
        provenance: input.provenance ?? undefined,
      }, tenantId, tmk, env, ctx, { hindsightAsync: true })),
      surface: BRAIN_MEMORY_SURFACE_PROFILE.surface,
      profile: BRAIN_MEMORY_SURFACE_PROFILE,
    }
  }
  const normalized = normalizeExternalClientCapture(input)
  return {
    ...(await retainViaService({
      content: input.content,
      domain: input.scope ?? 'general',
      memory_type: input.memory_type,
      provenance: normalized.provenance,
      source: normalized.sourceSystem,
      source_ref: normalized.sourceRef,
      title: normalized.title,
      artifact_ref: normalized.artifactRef,
      metadata: normalized.metadata,
    }, tenantId, tmk, env, ctx, {
      hindsightAsync: true,
      eagerProjectionDispatch: true,
    })),
    surface: BRAIN_MEMORY_SURFACE_PROFILE.surface,
    capture_mode: normalized.captureMode,
    source_system: normalized.sourceSystem,
    source_ref: normalized.sourceRef,
    provenance: normalized.provenance,
    client_name: normalized.clientName,
    profile: BRAIN_MEMORY_SURFACE_PROFILE,
  }
}
