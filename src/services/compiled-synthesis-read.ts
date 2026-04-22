import type { Env } from '../types/env'
import { getCompiledSynthesisStore } from './compiled-synthesis-postgres'
import { buildCompiledSynthesisView } from './compiled-synthesis-read-models'
import type {
  CompiledChangeViewReadModel,
  CompiledContextPackReadModel,
  CompiledDossierReadModel,
  CompiledSynthesisView,
} from './compiled-synthesis-models'
import type {
  CompiledDocumentFamily,
  CompiledSynthesisBundle,
} from './compiled-synthesis-schema'

async function readBundle(
  tenantId: string,
  stableKey: string,
  env: Env,
): Promise<CompiledSynthesisBundle | null> {
  return getCompiledSynthesisStore(env).getCompiledDocumentBundle(tenantId, stableKey)
}

function requireFamily<T extends CompiledSynthesisView>(
  view: CompiledSynthesisView | null,
  family: CompiledDocumentFamily,
): T | null {
  if (!view || view.document.family !== family) return null
  return view as T
}

export async function readCompiledSynthesis(
  tenantId: string,
  stableKey: string,
  env: Env,
): Promise<CompiledSynthesisBundle | null> {
  return readBundle(tenantId, stableKey, env)
}

export async function readCompiledSynthesisView(
  tenantId: string,
  stableKey: string,
  env: Env,
): Promise<CompiledSynthesisView | null> {
  const bundle = await readBundle(tenantId, stableKey, env)
  return bundle ? buildCompiledSynthesisView(bundle) : null
}

export async function readCompiledDocumentByFamily(
  tenantId: string,
  family: CompiledDocumentFamily,
  stableKey: string,
  env: Env,
): Promise<CompiledSynthesisView | null> {
  const view = await readCompiledSynthesisView(tenantId, stableKey, env)
  return view?.document.family === family ? view : null
}

export async function readCompiledDossier(
  tenantId: string,
  stableKey: string,
  env: Env,
): Promise<CompiledDossierReadModel | null> {
  const view = await readCompiledDocumentByFamily(tenantId, 'dossier', stableKey, env)
  if (!view?.dossier) return null
  return requireFamily<CompiledDossierReadModel>(view, 'dossier')
}

export async function readCompiledContextPack(
  tenantId: string,
  stableKey: string,
  env: Env,
): Promise<CompiledContextPackReadModel | null> {
  const view = await readCompiledDocumentByFamily(tenantId, 'context_pack', stableKey, env)
  if (!view?.contextPack) return null
  return requireFamily<CompiledContextPackReadModel>(view, 'context_pack')
}

export async function readCompiledChangeView(
  tenantId: string,
  stableKey: string,
  env: Env,
): Promise<CompiledChangeViewReadModel | null> {
  const view = await readCompiledSynthesisView(tenantId, stableKey, env)
  if (!view?.changeView) return null
  if (view.document.family !== 'decision_log' && view.document.family !== 'what_changed') {
    return null
  }
  return view as CompiledChangeViewReadModel
}
