import type { Env } from '../types/env'
import { getCompiledSynthesisStore } from './compiled-synthesis-postgres'
import type { CompiledSynthesisBundle } from './compiled-synthesis-service-types'

export async function readCompiledSynthesis(
  tenantId: string,
  stableKey: string,
  env: Env,
): Promise<CompiledSynthesisBundle | null> {
  return getCompiledSynthesisStore(env).getCompiledDocumentBundle(tenantId, stableKey)
}
