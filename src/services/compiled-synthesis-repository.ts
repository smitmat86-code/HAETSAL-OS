import { neon } from '@neondatabase/serverless'
import {
  COMPILED_SYNTHESIS_SCHEMA,
  type CompiledArtifactFormat,
  type CompiledContextPackRecord,
  type CompiledContextPackUpsertInput,
  type CompiledContradictionRecord,
  type CompiledContradictionUpsertInput,
  type CompiledDocumentArtifactInput,
  type CompiledDocumentArtifactRecord,
  type CompiledDocumentRecord,
  type CompiledDocumentSourceInput,
  type CompiledDocumentSourceRecord,
  type CompiledDocumentUpsertInput,
  type CompiledEntityRecord,
  type CompiledEntityUpsertInput,
  type CompiledFactRecord,
  type CompiledFactUpsertInput,
  type CompiledRelationshipRecord,
  type CompiledRelationshipUpsertInput,
  type CompiledSynthesisBundle,
} from './compiled-synthesis-schema'

type NeonSql = ReturnType<typeof neon>
type NeonQueryCapable = NeonSql & {
  query: (statement: string) => Promise<unknown>
  transaction: (queries: unknown[]) => Promise<unknown>
}

export interface CompiledSynthesisStore {
  upsertCompiledDocument(input: CompiledDocumentUpsertInput): Promise<CompiledDocumentRecord>
  replaceCompiledDocumentSources(
    tenantId: string,
    compiledDocumentId: string,
    sources: CompiledDocumentSourceInput[],
  ): Promise<CompiledDocumentSourceRecord[]>
  insertCompiledDocumentArtifact(
    tenantId: string,
    input: CompiledDocumentArtifactInput,
  ): Promise<CompiledDocumentArtifactRecord>
  upsertCompiledEntity(input: CompiledEntityUpsertInput): Promise<CompiledEntityRecord>
  upsertCompiledFact(input: CompiledFactUpsertInput): Promise<CompiledFactRecord>
  upsertCompiledRelationship(input: CompiledRelationshipUpsertInput): Promise<CompiledRelationshipRecord>
  upsertCompiledContradiction(input: CompiledContradictionUpsertInput): Promise<CompiledContradictionRecord>
  upsertCompiledContextPack(input: CompiledContextPackUpsertInput): Promise<CompiledContextPackRecord>
  getCompiledDocumentByStableKey(
    tenantId: string,
    stableKey: string,
  ): Promise<CompiledDocumentRecord | null>
  getCompiledDocumentBundle(
    tenantId: string,
    stableKey: string,
  ): Promise<CompiledSynthesisBundle | null>
}

const NUMERIC_DB_FIELDS = new Set([
  'compiled_at',
  'created_at',
  'updated_at',
  'byte_length',
])

function normalizeDbRow<T>(row: T): T {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return row
  return Object.fromEntries(
    Object.entries(row).map(([key, value]) => {
      if (typeof value === 'string' && NUMERIC_DB_FIELDS.has(key) && /^-?\d+$/.test(value)) {
        return [key, Number(value)]
      }
      return [key, value]
    }),
  ) as T
}

function tenantScoped(tenantId: string, stableKey: string): string {
  return `${tenantId}::${stableKey}`
}

function artifactScoped(
  tenantId: string,
  compiledDocumentId: string,
  artifactRole: string,
  version: string,
): string {
  return `${tenantId}::${compiledDocumentId}::${artifactRole}::${version}`
}

function dedupeSources(sources: CompiledDocumentSourceInput[]): CompiledDocumentSourceInput[] {
  const seen = new Set<string>()
  return sources.filter((source) => {
    const key = [
      source.sourceRole,
      source.canonicalCaptureId ?? '',
      source.canonicalDocumentId ?? '',
      source.canonicalArtifactId ?? '',
      source.canonicalOperationId ?? '',
    ].join('::')
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function assertSourceLink(source: CompiledDocumentSourceInput): void {
  if (
    !source.canonicalCaptureId
    && !source.canonicalDocumentId
    && !source.canonicalArtifactId
    && !source.canonicalOperationId
  ) {
    throw new Error('Compiled source links require at least one canonical reference')
  }
}

function sortByStableKey<T extends { stable_key: string }>(rows: T[]): T[] {
  return [...rows].sort((left, right) => left.stable_key.localeCompare(right.stable_key))
}

export class InMemoryCompiledSynthesisStore implements CompiledSynthesisStore {
  private readonly documents = new Map<string, CompiledDocumentRecord>()
  private readonly documentByStableKey = new Map<string, string>()
  private readonly sources = new Map<string, CompiledDocumentSourceRecord>()
  private readonly artifacts = new Map<string, CompiledDocumentArtifactRecord>()
  private readonly artifactByLogicalKey = new Map<string, string>()
  private readonly entities = new Map<string, CompiledEntityRecord>()
  private readonly entityByStableKey = new Map<string, string>()
  private readonly facts = new Map<string, CompiledFactRecord>()
  private readonly factByStableKey = new Map<string, string>()
  private readonly relationships = new Map<string, CompiledRelationshipRecord>()
  private readonly relationshipByStableKey = new Map<string, string>()
  private readonly contradictions = new Map<string, CompiledContradictionRecord>()
  private readonly contradictionByStableKey = new Map<string, string>()
  private readonly contextPacks = new Map<string, CompiledContextPackRecord>()
  private readonly contextPackByStableKey = new Map<string, string>()

  async upsertCompiledDocument(input: CompiledDocumentUpsertInput): Promise<CompiledDocumentRecord> {
    const key = tenantScoped(input.tenantId, input.stableKey)
    const existingId = this.documentByStableKey.get(key)
    const existing = existingId ? this.documents.get(existingId) : null
    const row: CompiledDocumentRecord = existing
      ? {
        ...existing,
        family: input.family,
        scope: input.scope,
        title: input.title?.trim() || null,
        summary: input.summary?.trim() || null,
        audience: input.audience,
        compiled_at: input.compiledAt,
        updated_at: input.updatedAt,
      }
      : {
        id: crypto.randomUUID(),
        tenant_id: input.tenantId,
        stable_key: input.stableKey,
        family: input.family,
        scope: input.scope,
        title: input.title?.trim() || null,
        summary: input.summary?.trim() || null,
        audience: input.audience,
        compiled_at: input.compiledAt,
        created_at: input.updatedAt,
        updated_at: input.updatedAt,
      }
    this.documents.set(row.id, row)
    this.documentByStableKey.set(key, row.id)
    return { ...row }
  }

  async replaceCompiledDocumentSources(
    tenantId: string,
    compiledDocumentId: string,
    sources: CompiledDocumentSourceInput[],
  ): Promise<CompiledDocumentSourceRecord[]> {
    for (const row of [...this.sources.values()]) {
      if (row.tenant_id === tenantId && row.compiled_document_id === compiledDocumentId) {
        this.sources.delete(row.id)
      }
    }
    const createdAt = Date.now()
    const rows = dedupeSources(sources).map((source) => {
      assertSourceLink(source)
      const row: CompiledDocumentSourceRecord = {
        id: crypto.randomUUID(),
        tenant_id: tenantId,
        compiled_document_id: compiledDocumentId,
        source_role: source.sourceRole,
        canonical_capture_id: source.canonicalCaptureId ?? null,
        canonical_document_id: source.canonicalDocumentId ?? null,
        canonical_artifact_id: source.canonicalArtifactId ?? null,
        canonical_operation_id: source.canonicalOperationId ?? null,
        created_at: createdAt,
      }
      this.sources.set(row.id, row)
      return row
    })
    return rows.map((row) => ({ ...row }))
  }

  async insertCompiledDocumentArtifact(
    tenantId: string,
    input: CompiledDocumentArtifactInput,
  ): Promise<CompiledDocumentArtifactRecord> {
    const key = artifactScoped(tenantId, input.compiledDocumentId, input.artifactRole, input.version)
    const existingId = this.artifactByLogicalKey.get(key)
    const existing = existingId ? this.artifacts.get(existingId) : null
    const row: CompiledDocumentArtifactRecord = existing
      ? {
        ...existing,
        format: input.format,
        media_type: input.mediaType?.trim() || null,
        r2_key: input.r2Key,
        sha256: input.sha256,
        byte_length: input.byteLength,
      }
      : {
        id: crypto.randomUUID(),
        tenant_id: tenantId,
        compiled_document_id: input.compiledDocumentId,
        artifact_role: input.artifactRole,
        format: input.format,
        version: input.version,
        media_type: input.mediaType?.trim() || null,
        r2_key: input.r2Key,
        sha256: input.sha256,
        byte_length: input.byteLength,
        created_at: input.createdAt,
      }
    this.artifacts.set(row.id, row)
    this.artifactByLogicalKey.set(key, row.id)
    return { ...row }
  }

  async upsertCompiledEntity(input: CompiledEntityUpsertInput): Promise<CompiledEntityRecord> {
    const key = tenantScoped(input.tenantId, input.stableKey)
    const existingId = this.entityByStableKey.get(key)
    const existing = existingId ? this.entities.get(existingId) : null
    const row: CompiledEntityRecord = existing
      ? {
        ...existing,
        compiled_document_id: input.compiledDocumentId,
        scope: input.scope,
        entity_type: input.entityType,
        name: input.name,
        summary: input.summary?.trim() || null,
        compiled_at: input.compiledAt,
        updated_at: input.updatedAt,
      }
      : {
        id: crypto.randomUUID(),
        tenant_id: input.tenantId,
        compiled_document_id: input.compiledDocumentId,
        stable_key: input.stableKey,
        scope: input.scope,
        entity_type: input.entityType,
        name: input.name,
        summary: input.summary?.trim() || null,
        compiled_at: input.compiledAt,
        created_at: input.updatedAt,
        updated_at: input.updatedAt,
      }
    this.entities.set(row.id, row)
    this.entityByStableKey.set(key, row.id)
    return { ...row }
  }

  async upsertCompiledFact(input: CompiledFactUpsertInput): Promise<CompiledFactRecord> {
    const key = tenantScoped(input.tenantId, input.stableKey)
    const existingId = this.factByStableKey.get(key)
    const existing = existingId ? this.facts.get(existingId) : null
    const row: CompiledFactRecord = existing
      ? {
        ...existing,
        compiled_document_id: input.compiledDocumentId,
        scope: input.scope,
        subject_entity_id: input.subjectEntityId ?? null,
        fact_type: input.factType,
        value_json: input.valueJson,
        summary: input.summary?.trim() || null,
        compiled_at: input.compiledAt,
        updated_at: input.updatedAt,
      }
      : {
        id: crypto.randomUUID(),
        tenant_id: input.tenantId,
        compiled_document_id: input.compiledDocumentId,
        stable_key: input.stableKey,
        scope: input.scope,
        subject_entity_id: input.subjectEntityId ?? null,
        fact_type: input.factType,
        value_json: input.valueJson,
        summary: input.summary?.trim() || null,
        compiled_at: input.compiledAt,
        created_at: input.updatedAt,
        updated_at: input.updatedAt,
      }
    this.facts.set(row.id, row)
    this.factByStableKey.set(key, row.id)
    return { ...row }
  }

  async upsertCompiledRelationship(input: CompiledRelationshipUpsertInput): Promise<CompiledRelationshipRecord> {
    const key = tenantScoped(input.tenantId, input.stableKey)
    const existingId = this.relationshipByStableKey.get(key)
    const existing = existingId ? this.relationships.get(existingId) : null
    const row: CompiledRelationshipRecord = existing
      ? {
        ...existing,
        compiled_document_id: input.compiledDocumentId,
        scope: input.scope,
        subject_entity_id: input.subjectEntityId ?? null,
        object_entity_id: input.objectEntityId ?? null,
        relationship_type: input.relationshipType,
        summary: input.summary?.trim() || null,
        compiled_at: input.compiledAt,
        updated_at: input.updatedAt,
      }
      : {
        id: crypto.randomUUID(),
        tenant_id: input.tenantId,
        compiled_document_id: input.compiledDocumentId,
        stable_key: input.stableKey,
        scope: input.scope,
        subject_entity_id: input.subjectEntityId ?? null,
        object_entity_id: input.objectEntityId ?? null,
        relationship_type: input.relationshipType,
        summary: input.summary?.trim() || null,
        compiled_at: input.compiledAt,
        created_at: input.updatedAt,
        updated_at: input.updatedAt,
      }
    this.relationships.set(row.id, row)
    this.relationshipByStableKey.set(key, row.id)
    return { ...row }
  }

  async upsertCompiledContradiction(input: CompiledContradictionUpsertInput): Promise<CompiledContradictionRecord> {
    const key = tenantScoped(input.tenantId, input.stableKey)
    const existingId = this.contradictionByStableKey.get(key)
    const existing = existingId ? this.contradictions.get(existingId) : null
    const row: CompiledContradictionRecord = existing
      ? {
        ...existing,
        compiled_document_id: input.compiledDocumentId,
        scope: input.scope,
        left_fact_id: input.leftFactId ?? null,
        right_fact_id: input.rightFactId ?? null,
        title: input.title?.trim() || null,
        summary: input.summary,
        status: input.status,
        compiled_at: input.compiledAt,
        updated_at: input.updatedAt,
      }
      : {
        id: crypto.randomUUID(),
        tenant_id: input.tenantId,
        compiled_document_id: input.compiledDocumentId,
        stable_key: input.stableKey,
        scope: input.scope,
        left_fact_id: input.leftFactId ?? null,
        right_fact_id: input.rightFactId ?? null,
        title: input.title?.trim() || null,
        summary: input.summary,
        status: input.status,
        compiled_at: input.compiledAt,
        created_at: input.updatedAt,
        updated_at: input.updatedAt,
      }
    this.contradictions.set(row.id, row)
    this.contradictionByStableKey.set(key, row.id)
    return { ...row }
  }

  async upsertCompiledContextPack(input: CompiledContextPackUpsertInput): Promise<CompiledContextPackRecord> {
    const key = tenantScoped(input.tenantId, input.stableKey)
    const existingId = this.contextPackByStableKey.get(key)
    const existing = existingId ? this.contextPacks.get(existingId) : null
    const row: CompiledContextPackRecord = existing
      ? {
        ...existing,
        compiled_document_id: input.compiledDocumentId,
        scope: input.scope,
        pack_kind: input.packKind,
        title: input.title,
        summary: input.summary?.trim() || null,
        agent_usable: input.agentUsable,
        human_usable: input.humanUsable,
        compiled_at: input.compiledAt,
        updated_at: input.updatedAt,
      }
      : {
        id: crypto.randomUUID(),
        tenant_id: input.tenantId,
        compiled_document_id: input.compiledDocumentId,
        stable_key: input.stableKey,
        scope: input.scope,
        pack_kind: input.packKind,
        title: input.title,
        summary: input.summary?.trim() || null,
        agent_usable: input.agentUsable,
        human_usable: input.humanUsable,
        compiled_at: input.compiledAt,
        created_at: input.updatedAt,
        updated_at: input.updatedAt,
      }
    this.contextPacks.set(row.id, row)
    this.contextPackByStableKey.set(key, row.id)
    return { ...row }
  }

  async getCompiledDocumentByStableKey(
    tenantId: string,
    stableKey: string,
  ): Promise<CompiledDocumentRecord | null> {
    const id = this.documentByStableKey.get(tenantScoped(tenantId, stableKey))
    return id ? { ...this.documents.get(id)! } : null
  }

  async getCompiledDocumentBundle(
    tenantId: string,
    stableKey: string,
  ): Promise<CompiledSynthesisBundle | null> {
    const document = await this.getCompiledDocumentByStableKey(tenantId, stableKey)
    if (!document) return null
    return {
      document,
      sources: [...this.sources.values()]
        .filter((row) => row.tenant_id === tenantId && row.compiled_document_id === document.id)
        .sort((left, right) => left.source_role.localeCompare(right.source_role))
        .map((row) => ({ ...row })),
      artifacts: [...this.artifacts.values()]
        .filter((row) => row.tenant_id === tenantId && row.compiled_document_id === document.id)
        .sort((left, right) => left.created_at - right.created_at || left.version.localeCompare(right.version))
        .map((row) => ({ ...row })),
      entities: sortByStableKey(
        [...this.entities.values()]
          .filter((row) => row.tenant_id === tenantId && row.compiled_document_id === document.id),
      ).map((row) => ({ ...row })),
      facts: sortByStableKey(
        [...this.facts.values()]
          .filter((row) => row.tenant_id === tenantId && row.compiled_document_id === document.id),
      ).map((row) => ({ ...row })),
      relationships: sortByStableKey(
        [...this.relationships.values()]
          .filter((row) => row.tenant_id === tenantId && row.compiled_document_id === document.id),
      ).map((row) => ({ ...row })),
      contradictions: sortByStableKey(
        [...this.contradictions.values()]
          .filter((row) => row.tenant_id === tenantId && row.compiled_document_id === document.id),
      ).map((row) => ({ ...row })),
      contextPack: [...this.contextPacks.values()]
        .find((row) => row.tenant_id === tenantId && row.compiled_document_id === document.id) ?? null,
    }
  }
}

export class NeonCompiledSynthesisStore implements CompiledSynthesisStore {
  private schemaReadyPromise: Promise<void> | null = null

  constructor(private readonly sql: NeonSql) {}

  private async ensureSchema(): Promise<void> {
    if (!this.schemaReadyPromise) {
      this.schemaReadyPromise = this.ensureSchemaOnce()
        .catch((error) => {
          this.schemaReadyPromise = null
          throw error
        })
    }
    await this.schemaReadyPromise
  }

  private async ensureSchemaOnce(): Promise<void> {
    const q = this.sql as NeonQueryCapable
    await q.query(`CREATE SCHEMA IF NOT EXISTS ${COMPILED_SYNTHESIS_SCHEMA}`)
    const statements = [
      `CREATE TABLE IF NOT EXISTS ${COMPILED_SYNTHESIS_SCHEMA}.compiled_documents (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        stable_key TEXT NOT NULL,
        family TEXT NOT NULL,
        scope TEXT NOT NULL,
        title TEXT,
        summary TEXT,
        audience TEXT NOT NULL,
        compiled_at BIGINT NOT NULL,
        created_at BIGINT NOT NULL,
        updated_at BIGINT NOT NULL
      )`,
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_pg_compiled_documents_tenant_stable
        ON ${COMPILED_SYNTHESIS_SCHEMA}.compiled_documents(tenant_id, stable_key)`,
      `CREATE INDEX IF NOT EXISTS idx_pg_compiled_documents_tenant_family
        ON ${COMPILED_SYNTHESIS_SCHEMA}.compiled_documents(tenant_id, family, scope, updated_at DESC)`,
      `CREATE TABLE IF NOT EXISTS ${COMPILED_SYNTHESIS_SCHEMA}.compiled_document_sources (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        compiled_document_id TEXT NOT NULL REFERENCES ${COMPILED_SYNTHESIS_SCHEMA}.compiled_documents(id) ON DELETE CASCADE,
        source_role TEXT NOT NULL,
        canonical_capture_id TEXT REFERENCES ${COMPILED_SYNTHESIS_SCHEMA}.canonical_captures(id) ON DELETE CASCADE,
        canonical_document_id TEXT REFERENCES ${COMPILED_SYNTHESIS_SCHEMA}.canonical_documents(id) ON DELETE CASCADE,
        canonical_artifact_id TEXT REFERENCES ${COMPILED_SYNTHESIS_SCHEMA}.canonical_artifacts(id) ON DELETE CASCADE,
        canonical_operation_id TEXT REFERENCES ${COMPILED_SYNTHESIS_SCHEMA}.canonical_memory_operations(id) ON DELETE CASCADE,
        created_at BIGINT NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS idx_pg_compiled_document_sources_lookup
        ON ${COMPILED_SYNTHESIS_SCHEMA}.compiled_document_sources(tenant_id, compiled_document_id, source_role)`,
      `CREATE TABLE IF NOT EXISTS ${COMPILED_SYNTHESIS_SCHEMA}.compiled_document_artifacts (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        compiled_document_id TEXT NOT NULL REFERENCES ${COMPILED_SYNTHESIS_SCHEMA}.compiled_documents(id) ON DELETE CASCADE,
        artifact_role TEXT NOT NULL,
        format TEXT NOT NULL,
        version TEXT NOT NULL,
        media_type TEXT,
        r2_key TEXT NOT NULL,
        sha256 TEXT NOT NULL,
        byte_length BIGINT NOT NULL,
        created_at BIGINT NOT NULL
      )`,
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_pg_compiled_document_artifacts_version
        ON ${COMPILED_SYNTHESIS_SCHEMA}.compiled_document_artifacts(tenant_id, compiled_document_id, artifact_role, version)`,
      `CREATE INDEX IF NOT EXISTS idx_pg_compiled_document_artifacts_lookup
        ON ${COMPILED_SYNTHESIS_SCHEMA}.compiled_document_artifacts(tenant_id, compiled_document_id, created_at DESC)`,
      `CREATE TABLE IF NOT EXISTS ${COMPILED_SYNTHESIS_SCHEMA}.compiled_entities (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        compiled_document_id TEXT NOT NULL REFERENCES ${COMPILED_SYNTHESIS_SCHEMA}.compiled_documents(id) ON DELETE CASCADE,
        stable_key TEXT NOT NULL,
        scope TEXT NOT NULL,
        entity_type TEXT NOT NULL,
        name TEXT NOT NULL,
        summary TEXT,
        compiled_at BIGINT NOT NULL,
        created_at BIGINT NOT NULL,
        updated_at BIGINT NOT NULL
      )`,
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_pg_compiled_entities_tenant_stable
        ON ${COMPILED_SYNTHESIS_SCHEMA}.compiled_entities(tenant_id, stable_key)`,
      `CREATE TABLE IF NOT EXISTS ${COMPILED_SYNTHESIS_SCHEMA}.compiled_facts (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        compiled_document_id TEXT NOT NULL REFERENCES ${COMPILED_SYNTHESIS_SCHEMA}.compiled_documents(id) ON DELETE CASCADE,
        stable_key TEXT NOT NULL,
        scope TEXT NOT NULL,
        subject_entity_id TEXT REFERENCES ${COMPILED_SYNTHESIS_SCHEMA}.compiled_entities(id) ON DELETE SET NULL,
        fact_type TEXT NOT NULL,
        value_json TEXT NOT NULL,
        summary TEXT,
        compiled_at BIGINT NOT NULL,
        created_at BIGINT NOT NULL,
        updated_at BIGINT NOT NULL
      )`,
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_pg_compiled_facts_tenant_stable
        ON ${COMPILED_SYNTHESIS_SCHEMA}.compiled_facts(tenant_id, stable_key)`,
      `CREATE TABLE IF NOT EXISTS ${COMPILED_SYNTHESIS_SCHEMA}.compiled_relationships (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        compiled_document_id TEXT NOT NULL REFERENCES ${COMPILED_SYNTHESIS_SCHEMA}.compiled_documents(id) ON DELETE CASCADE,
        stable_key TEXT NOT NULL,
        scope TEXT NOT NULL,
        subject_entity_id TEXT REFERENCES ${COMPILED_SYNTHESIS_SCHEMA}.compiled_entities(id) ON DELETE SET NULL,
        object_entity_id TEXT REFERENCES ${COMPILED_SYNTHESIS_SCHEMA}.compiled_entities(id) ON DELETE SET NULL,
        relationship_type TEXT NOT NULL,
        summary TEXT,
        compiled_at BIGINT NOT NULL,
        created_at BIGINT NOT NULL,
        updated_at BIGINT NOT NULL
      )`,
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_pg_compiled_relationships_tenant_stable
        ON ${COMPILED_SYNTHESIS_SCHEMA}.compiled_relationships(tenant_id, stable_key)`,
      `CREATE TABLE IF NOT EXISTS ${COMPILED_SYNTHESIS_SCHEMA}.compiled_contradictions (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        compiled_document_id TEXT NOT NULL REFERENCES ${COMPILED_SYNTHESIS_SCHEMA}.compiled_documents(id) ON DELETE CASCADE,
        stable_key TEXT NOT NULL,
        scope TEXT NOT NULL,
        left_fact_id TEXT REFERENCES ${COMPILED_SYNTHESIS_SCHEMA}.compiled_facts(id) ON DELETE SET NULL,
        right_fact_id TEXT REFERENCES ${COMPILED_SYNTHESIS_SCHEMA}.compiled_facts(id) ON DELETE SET NULL,
        title TEXT,
        summary TEXT NOT NULL,
        status TEXT NOT NULL,
        compiled_at BIGINT NOT NULL,
        created_at BIGINT NOT NULL,
        updated_at BIGINT NOT NULL
      )`,
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_pg_compiled_contradictions_tenant_stable
        ON ${COMPILED_SYNTHESIS_SCHEMA}.compiled_contradictions(tenant_id, stable_key)`,
      `CREATE TABLE IF NOT EXISTS ${COMPILED_SYNTHESIS_SCHEMA}.compiled_context_packs (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        compiled_document_id TEXT NOT NULL REFERENCES ${COMPILED_SYNTHESIS_SCHEMA}.compiled_documents(id) ON DELETE CASCADE,
        stable_key TEXT NOT NULL,
        scope TEXT NOT NULL,
        pack_kind TEXT NOT NULL,
        title TEXT NOT NULL,
        summary TEXT,
        agent_usable BOOLEAN NOT NULL,
        human_usable BOOLEAN NOT NULL,
        compiled_at BIGINT NOT NULL,
        created_at BIGINT NOT NULL,
        updated_at BIGINT NOT NULL
      )`,
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_pg_compiled_context_packs_tenant_stable
        ON ${COMPILED_SYNTHESIS_SCHEMA}.compiled_context_packs(tenant_id, stable_key)`,
    ]
    for (const statement of statements) {
      await q.query(statement)
    }
  }

  private async rows<T>(query: Promise<unknown>): Promise<T[]> {
    await this.ensureSchema()
    return (await query as T[]).map((row) => normalizeDbRow(row))
  }

  private async first<T>(query: Promise<unknown>): Promise<T | null> {
    return (await this.rows<T>(query))[0] ?? null
  }

  async upsertCompiledDocument(input: CompiledDocumentUpsertInput): Promise<CompiledDocumentRecord> {
    return this.first<CompiledDocumentRecord>(this.sql`
      INSERT INTO haetsal_canonical.compiled_documents
        (id, tenant_id, stable_key, family, scope, title, summary, audience, compiled_at, created_at, updated_at)
      VALUES (${crypto.randomUUID()}, ${input.tenantId}, ${input.stableKey}, ${input.family}, ${input.scope},
              ${input.title?.trim() || null}, ${input.summary?.trim() || null}, ${input.audience},
              ${input.compiledAt}, ${input.updatedAt}, ${input.updatedAt})
      ON CONFLICT (tenant_id, stable_key)
      DO UPDATE SET family = EXCLUDED.family,
                    scope = EXCLUDED.scope,
                    title = EXCLUDED.title,
                    summary = EXCLUDED.summary,
                    audience = EXCLUDED.audience,
                    compiled_at = EXCLUDED.compiled_at,
                    updated_at = EXCLUDED.updated_at
      RETURNING id, tenant_id, stable_key, family, scope, title, summary, audience, compiled_at, created_at, updated_at
    `) as Promise<CompiledDocumentRecord>
  }

  async replaceCompiledDocumentSources(
    tenantId: string,
    compiledDocumentId: string,
    sources: CompiledDocumentSourceInput[],
  ): Promise<CompiledDocumentSourceRecord[]> {
    await this.ensureSchema()
    const normalized = dedupeSources(sources)
    normalized.forEach(assertSourceLink)
    const createdAt = Date.now()
    const q = this.sql as NeonQueryCapable
    await q.transaction([
      this.sql`DELETE FROM haetsal_canonical.compiled_document_sources
        WHERE tenant_id = ${tenantId} AND compiled_document_id = ${compiledDocumentId}`,
      ...normalized.map((source) => this.sql`
        INSERT INTO haetsal_canonical.compiled_document_sources
          (id, tenant_id, compiled_document_id, source_role, canonical_capture_id, canonical_document_id, canonical_artifact_id, canonical_operation_id, created_at)
        VALUES (${crypto.randomUUID()}, ${tenantId}, ${compiledDocumentId}, ${source.sourceRole},
                ${source.canonicalCaptureId ?? null}, ${source.canonicalDocumentId ?? null},
                ${source.canonicalArtifactId ?? null}, ${source.canonicalOperationId ?? null}, ${createdAt})
      `),
    ])
    return this.rows<CompiledDocumentSourceRecord>(this.sql`
      SELECT id, tenant_id, compiled_document_id, source_role, canonical_capture_id, canonical_document_id,
             canonical_artifact_id, canonical_operation_id, created_at
      FROM haetsal_canonical.compiled_document_sources
      WHERE tenant_id = ${tenantId} AND compiled_document_id = ${compiledDocumentId}
      ORDER BY source_role ASC, id ASC
    `)
  }

  async insertCompiledDocumentArtifact(
    tenantId: string,
    input: CompiledDocumentArtifactInput,
  ): Promise<CompiledDocumentArtifactRecord> {
    return this.first<CompiledDocumentArtifactRecord>(this.sql`
      INSERT INTO haetsal_canonical.compiled_document_artifacts
        (id, tenant_id, compiled_document_id, artifact_role, format, version, media_type, r2_key, sha256, byte_length, created_at)
      VALUES (${crypto.randomUUID()}, ${tenantId}, ${input.compiledDocumentId}, ${input.artifactRole}, ${input.format},
              ${input.version}, ${input.mediaType?.trim() || null}, ${input.r2Key}, ${input.sha256},
              ${input.byteLength}, ${input.createdAt})
      ON CONFLICT (tenant_id, compiled_document_id, artifact_role, version)
      DO UPDATE SET format = EXCLUDED.format,
                    media_type = EXCLUDED.media_type,
                    r2_key = EXCLUDED.r2_key,
                    sha256 = EXCLUDED.sha256,
                    byte_length = EXCLUDED.byte_length
      RETURNING id, tenant_id, compiled_document_id, artifact_role, format, version, media_type,
                r2_key, sha256, byte_length, created_at
    `) as Promise<CompiledDocumentArtifactRecord>
  }

  async upsertCompiledEntity(input: CompiledEntityUpsertInput): Promise<CompiledEntityRecord> {
    return this.first<CompiledEntityRecord>(this.sql`
      INSERT INTO haetsal_canonical.compiled_entities
        (id, tenant_id, compiled_document_id, stable_key, scope, entity_type, name, summary, compiled_at, created_at, updated_at)
      VALUES (${crypto.randomUUID()}, ${input.tenantId}, ${input.compiledDocumentId}, ${input.stableKey},
              ${input.scope}, ${input.entityType}, ${input.name}, ${input.summary?.trim() || null},
              ${input.compiledAt}, ${input.updatedAt}, ${input.updatedAt})
      ON CONFLICT (tenant_id, stable_key)
      DO UPDATE SET compiled_document_id = EXCLUDED.compiled_document_id,
                    scope = EXCLUDED.scope,
                    entity_type = EXCLUDED.entity_type,
                    name = EXCLUDED.name,
                    summary = EXCLUDED.summary,
                    compiled_at = EXCLUDED.compiled_at,
                    updated_at = EXCLUDED.updated_at
      RETURNING id, tenant_id, compiled_document_id, stable_key, scope, entity_type, name, summary,
                compiled_at, created_at, updated_at
    `) as Promise<CompiledEntityRecord>
  }

  async upsertCompiledFact(input: CompiledFactUpsertInput): Promise<CompiledFactRecord> {
    return this.first<CompiledFactRecord>(this.sql`
      INSERT INTO haetsal_canonical.compiled_facts
        (id, tenant_id, compiled_document_id, stable_key, scope, subject_entity_id, fact_type, value_json, summary, compiled_at, created_at, updated_at)
      VALUES (${crypto.randomUUID()}, ${input.tenantId}, ${input.compiledDocumentId}, ${input.stableKey},
              ${input.scope}, ${input.subjectEntityId ?? null}, ${input.factType}, ${input.valueJson},
              ${input.summary?.trim() || null}, ${input.compiledAt}, ${input.updatedAt}, ${input.updatedAt})
      ON CONFLICT (tenant_id, stable_key)
      DO UPDATE SET compiled_document_id = EXCLUDED.compiled_document_id,
                    scope = EXCLUDED.scope,
                    subject_entity_id = EXCLUDED.subject_entity_id,
                    fact_type = EXCLUDED.fact_type,
                    value_json = EXCLUDED.value_json,
                    summary = EXCLUDED.summary,
                    compiled_at = EXCLUDED.compiled_at,
                    updated_at = EXCLUDED.updated_at
      RETURNING id, tenant_id, compiled_document_id, stable_key, scope, subject_entity_id, fact_type,
                value_json, summary, compiled_at, created_at, updated_at
    `) as Promise<CompiledFactRecord>
  }

  async upsertCompiledRelationship(input: CompiledRelationshipUpsertInput): Promise<CompiledRelationshipRecord> {
    return this.first<CompiledRelationshipRecord>(this.sql`
      INSERT INTO haetsal_canonical.compiled_relationships
        (id, tenant_id, compiled_document_id, stable_key, scope, subject_entity_id, object_entity_id, relationship_type, summary, compiled_at, created_at, updated_at)
      VALUES (${crypto.randomUUID()}, ${input.tenantId}, ${input.compiledDocumentId}, ${input.stableKey},
              ${input.scope}, ${input.subjectEntityId ?? null}, ${input.objectEntityId ?? null},
              ${input.relationshipType}, ${input.summary?.trim() || null}, ${input.compiledAt},
              ${input.updatedAt}, ${input.updatedAt})
      ON CONFLICT (tenant_id, stable_key)
      DO UPDATE SET compiled_document_id = EXCLUDED.compiled_document_id,
                    scope = EXCLUDED.scope,
                    subject_entity_id = EXCLUDED.subject_entity_id,
                    object_entity_id = EXCLUDED.object_entity_id,
                    relationship_type = EXCLUDED.relationship_type,
                    summary = EXCLUDED.summary,
                    compiled_at = EXCLUDED.compiled_at,
                    updated_at = EXCLUDED.updated_at
      RETURNING id, tenant_id, compiled_document_id, stable_key, scope, subject_entity_id, object_entity_id,
                relationship_type, summary, compiled_at, created_at, updated_at
    `) as Promise<CompiledRelationshipRecord>
  }

  async upsertCompiledContradiction(input: CompiledContradictionUpsertInput): Promise<CompiledContradictionRecord> {
    return this.first<CompiledContradictionRecord>(this.sql`
      INSERT INTO haetsal_canonical.compiled_contradictions
        (id, tenant_id, compiled_document_id, stable_key, scope, left_fact_id, right_fact_id, title, summary, status, compiled_at, created_at, updated_at)
      VALUES (${crypto.randomUUID()}, ${input.tenantId}, ${input.compiledDocumentId}, ${input.stableKey},
              ${input.scope}, ${input.leftFactId ?? null}, ${input.rightFactId ?? null}, ${input.title?.trim() || null},
              ${input.summary}, ${input.status}, ${input.compiledAt}, ${input.updatedAt}, ${input.updatedAt})
      ON CONFLICT (tenant_id, stable_key)
      DO UPDATE SET compiled_document_id = EXCLUDED.compiled_document_id,
                    scope = EXCLUDED.scope,
                    left_fact_id = EXCLUDED.left_fact_id,
                    right_fact_id = EXCLUDED.right_fact_id,
                    title = EXCLUDED.title,
                    summary = EXCLUDED.summary,
                    status = EXCLUDED.status,
                    compiled_at = EXCLUDED.compiled_at,
                    updated_at = EXCLUDED.updated_at
      RETURNING id, tenant_id, compiled_document_id, stable_key, scope, left_fact_id, right_fact_id,
                title, summary, status, compiled_at, created_at, updated_at
    `) as Promise<CompiledContradictionRecord>
  }

  async upsertCompiledContextPack(input: CompiledContextPackUpsertInput): Promise<CompiledContextPackRecord> {
    return this.first<CompiledContextPackRecord>(this.sql`
      INSERT INTO haetsal_canonical.compiled_context_packs
        (id, tenant_id, compiled_document_id, stable_key, scope, pack_kind, title, summary, agent_usable, human_usable, compiled_at, created_at, updated_at)
      VALUES (${crypto.randomUUID()}, ${input.tenantId}, ${input.compiledDocumentId}, ${input.stableKey},
              ${input.scope}, ${input.packKind}, ${input.title}, ${input.summary?.trim() || null},
              ${input.agentUsable}, ${input.humanUsable}, ${input.compiledAt}, ${input.updatedAt}, ${input.updatedAt})
      ON CONFLICT (tenant_id, stable_key)
      DO UPDATE SET compiled_document_id = EXCLUDED.compiled_document_id,
                    scope = EXCLUDED.scope,
                    pack_kind = EXCLUDED.pack_kind,
                    title = EXCLUDED.title,
                    summary = EXCLUDED.summary,
                    agent_usable = EXCLUDED.agent_usable,
                    human_usable = EXCLUDED.human_usable,
                    compiled_at = EXCLUDED.compiled_at,
                    updated_at = EXCLUDED.updated_at
      RETURNING id, tenant_id, compiled_document_id, stable_key, scope, pack_kind, title, summary,
                agent_usable, human_usable, compiled_at, created_at, updated_at
    `) as Promise<CompiledContextPackRecord>
  }

  async getCompiledDocumentByStableKey(
    tenantId: string,
    stableKey: string,
  ): Promise<CompiledDocumentRecord | null> {
    return this.first<CompiledDocumentRecord>(this.sql`
      SELECT id, tenant_id, stable_key, family, scope, title, summary, audience, compiled_at, created_at, updated_at
      FROM haetsal_canonical.compiled_documents
      WHERE tenant_id = ${tenantId} AND stable_key = ${stableKey}
      LIMIT 1
    `)
  }

  async getCompiledDocumentBundle(
    tenantId: string,
    stableKey: string,
  ): Promise<CompiledSynthesisBundle | null> {
    const document = await this.getCompiledDocumentByStableKey(tenantId, stableKey)
    if (!document) return null
    const [
      sources,
      artifacts,
      entities,
      facts,
      relationships,
      contradictions,
      contextPack,
    ] = await Promise.all([
      this.rows<CompiledDocumentSourceRecord>(this.sql`
        SELECT id, tenant_id, compiled_document_id, source_role, canonical_capture_id, canonical_document_id,
               canonical_artifact_id, canonical_operation_id, created_at
        FROM haetsal_canonical.compiled_document_sources
        WHERE tenant_id = ${tenantId} AND compiled_document_id = ${document.id}
        ORDER BY source_role ASC, id ASC
      `),
      this.rows<CompiledDocumentArtifactRecord>(this.sql`
        SELECT id, tenant_id, compiled_document_id, artifact_role, format, version, media_type,
               r2_key, sha256, byte_length, created_at
        FROM haetsal_canonical.compiled_document_artifacts
        WHERE tenant_id = ${tenantId} AND compiled_document_id = ${document.id}
        ORDER BY created_at ASC, version ASC
      `),
      this.rows<CompiledEntityRecord>(this.sql`
        SELECT id, tenant_id, compiled_document_id, stable_key, scope, entity_type, name, summary,
               compiled_at, created_at, updated_at
        FROM haetsal_canonical.compiled_entities
        WHERE tenant_id = ${tenantId} AND compiled_document_id = ${document.id}
        ORDER BY stable_key ASC
      `),
      this.rows<CompiledFactRecord>(this.sql`
        SELECT id, tenant_id, compiled_document_id, stable_key, scope, subject_entity_id, fact_type,
               value_json, summary, compiled_at, created_at, updated_at
        FROM haetsal_canonical.compiled_facts
        WHERE tenant_id = ${tenantId} AND compiled_document_id = ${document.id}
        ORDER BY stable_key ASC
      `),
      this.rows<CompiledRelationshipRecord>(this.sql`
        SELECT id, tenant_id, compiled_document_id, stable_key, scope, subject_entity_id, object_entity_id,
               relationship_type, summary, compiled_at, created_at, updated_at
        FROM haetsal_canonical.compiled_relationships
        WHERE tenant_id = ${tenantId} AND compiled_document_id = ${document.id}
        ORDER BY stable_key ASC
      `),
      this.rows<CompiledContradictionRecord>(this.sql`
        SELECT id, tenant_id, compiled_document_id, stable_key, scope, left_fact_id, right_fact_id,
               title, summary, status, compiled_at, created_at, updated_at
        FROM haetsal_canonical.compiled_contradictions
        WHERE tenant_id = ${tenantId} AND compiled_document_id = ${document.id}
        ORDER BY stable_key ASC
      `),
      this.first<CompiledContextPackRecord>(this.sql`
        SELECT id, tenant_id, compiled_document_id, stable_key, scope, pack_kind, title, summary,
               agent_usable, human_usable, compiled_at, created_at, updated_at
        FROM haetsal_canonical.compiled_context_packs
        WHERE tenant_id = ${tenantId} AND compiled_document_id = ${document.id}
        ORDER BY updated_at DESC
        LIMIT 1
      `),
    ])

    return {
      document,
      sources,
      artifacts,
      entities,
      facts,
      relationships,
      contradictions,
      contextPack,
    }
  }
}
