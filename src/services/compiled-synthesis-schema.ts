import { CANONICAL_POSTGRES_SCHEMA } from './canonical-postgres-schema'

export const COMPILED_SYNTHESIS_SCHEMA = CANONICAL_POSTGRES_SCHEMA

export type * from './compiled-synthesis-inputs'
export type * from './compiled-synthesis-models'
export type * from './compiled-synthesis-records'
export type * from './compiled-synthesis-section-types'

export interface CompiledSynthesisBundle {
  document: import('./compiled-synthesis-records').CompiledDocumentRecord
  sources: import('./compiled-synthesis-records').CompiledDocumentSourceRecord[]
  artifacts: import('./compiled-synthesis-records').CompiledDocumentArtifactRecord[]
  entities: import('./compiled-synthesis-records').CompiledEntityRecord[]
  facts: import('./compiled-synthesis-records').CompiledFactRecord[]
  relationships: import('./compiled-synthesis-records').CompiledRelationshipRecord[]
  contradictions: import('./compiled-synthesis-records').CompiledContradictionRecord[]
  dossier: import('./compiled-synthesis-records').CompiledDossierRecord | null
  contextPack: import('./compiled-synthesis-records').CompiledContextPackRecord | null
  changeView: import('./compiled-synthesis-records').CompiledChangeViewRecord | null
}
