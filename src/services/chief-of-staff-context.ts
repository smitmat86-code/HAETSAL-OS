import type { Env } from '../types/env'
import type { AgentContextBundle, PrepareContextForAgentInput } from '../types/chief-of-staff-context'
import { type CanonicalMemoryReadOptions } from './canonical-memory-read-model'
import { loadCompiledChiefOfStaffContext } from './chief-of-staff-compiled-context'
import { assembleRuntimeContext } from './chief-of-staff-context-runtime'

export async function prepareContextForAgent(
  input: PrepareContextForAgentInput,
  env: Env,
  tenantId: string,
  options: CanonicalMemoryReadOptions = {},
): Promise<AgentContextBundle> {
  const compiled = await loadCompiledChiefOfStaffContext(input, env, tenantId)
  if (compiled?.bundle) return { ...compiled.bundle, compiled: compiled.metadata }

  const runtime = await assembleRuntimeContext(input, env, tenantId, options)
  if (!compiled) return runtime
  return { ...runtime, compiled: compiled.metadata }
}
