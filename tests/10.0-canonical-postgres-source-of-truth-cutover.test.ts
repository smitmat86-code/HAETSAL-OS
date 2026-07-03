import { beforeEach, describe, expect, it, vi } from 'vitest'
import { env } from 'cloudflare:test'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { captureThroughCanonicalPipeline } from '../src/services/canonical-capture-pipeline'
import { getCanonicalMemoryStore } from '../src/services/canonical-postgres'
import { encryptContentForArchive } from '../src/services/ingestion/encryption'
import { registerCanonicalMemoryTools } from '../src/tools/canonical-memory'
import type { CanonicalPipelineCaptureInput } from '../src/types/canonical-capture-pipeline'
import type { CanonicalDocumentResult, CanonicalMemoryStatusResult } from '../src/types/canonical-memory-query'
import { createGraphitiContainerTestEnv } from './support/graphiti-test-env'
import { createHindsightTestEnv } from './support/hindsight-test-env'
import { seedAvailableHindsightOperation, seedHistoricalHindsightProjectionOnCapture } from './support/hindsight-historical-projection-seed'
import artifactFixture from './fixtures/canonical-memory/artifact-capture.json'
import conversationFixture from './fixtures/canonical-memory/conversation-capture.json'
import noteFixture from './fixtures/canonical-memory/note-capture.json'

type ToolResponse = { content: Array<{ text: string }> }
type ToolHandler = (input: unknown) => Promise<ToolResponse>

function tenantId(label: string): string {
  return `test-tenant-canonical-100-${label}-${crypto.randomUUID()}`
}

async function deriveTestTmk(seed: string): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(`canonical-100-${seed}`),
    { name: 'HKDF' },
    false,
    ['deriveKey'],
  )
  return crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new TextEncoder().encode('canonical-100-salt'),
      info: new TextEncoder().encode('canonical-100-info'),
    },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  )
}

async function ensureTenantWithKek(tenantId: string): Promise<void> {
  const now = Date.now()
  await env.D1_US.prepare(
    `INSERT OR IGNORE INTO tenants
     (id, created_at, updated_at, data_region, primary_channel, hindsight_tenant_id, ai_cost_reset_at)
     VALUES (?, ?, ?, 'us', 'sms', ?, ?)`,
  ).bind(tenantId, now, now, `hindsight-${tenantId}`, now).run()
  await env.KV_SESSION.put(
    `cron_kek:${tenantId}`,
    btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))),
    { expirationTtl: 60 * 60 * 24 },
  )
  await env.D1_US.prepare(
    `UPDATE tenants
     SET cron_kek_expires_at = ?, updated_at = ?
     WHERE id = ?`,
  ).bind(now + (24 * 60 * 60 * 1000), now, tenantId).run()
}

function createRuntimeEnv(): typeof env {
  const { testEnv: graphEnv } = createGraphitiContainerTestEnv()
  return {
    ...createHindsightTestEnv({ operationStatus: 'completed' }),
    GRAPHITI_RUNTIME_MODE: graphEnv.GRAPHITI_RUNTIME_MODE,
    GRAPHITI: graphEnv.GRAPHITI,
  } as typeof env
}

async function encryptFixture(
  fixture: CanonicalPipelineCaptureInput,
  tenantId: string,
  suffix: string,
  tmk: CryptoKey,
): Promise<CanonicalPipelineCaptureInput> {
  return {
    ...fixture,
    tenantId,
    sourceRef: `${fixture.sourceRef ?? 'fixture'}-${suffix}`,
    bodyEncrypted: await encryptContentForArchive(fixture.body, tmk),
  }
}

function createToolRegistry(
  testEnv: typeof env,
  tenantId: string,
  tmk: CryptoKey,
): Map<string, ToolHandler> {
  const handlers = new Map<string, ToolHandler>()
  const server = {
    tool(name: string, _description: string, _shape: object, handler: ToolHandler) {
      handlers.set(name, handler)
    },
  } as unknown as McpServer
  registerCanonicalMemoryTools(server, {
    getEnv: () => testEnv,
    getTenantId: () => tenantId,
    getTmk: () => tmk,
    getExecutionContext: () => ({ waitUntil: () => undefined }),
  })
  return handlers
}

async function callTool<T>(
  handlers: Map<string, ToolHandler>,
  name: string,
  input: unknown,
): Promise<T> {
  const response = await handlers.get(name)?.(input)
  return JSON.parse(response?.content[0]?.text ?? 'null') as T
}

beforeEach(() => {
  vi.restoreAllMocks()
})

describe('10.0 canonical Postgres source-of-truth cutover', () => {
  it('writes canonical note captures into Postgres first without recreating the retired D1 mirror', async () => {
    const id = tenantId('note')
    const tmk = await deriveTestTmk(id)
    await ensureTenantWithKek(id)
    const testEnv = createRuntimeEnv()
    const input = await encryptFixture(noteFixture as CanonicalPipelineCaptureInput, id, 'note', tmk)

    const result = await captureThroughCanonicalPipeline({
      ...input,
      eagerProjectionDispatch: true,
      memoryType: 'episodic',
    }, testEnv, id)
    const store = getCanonicalMemoryStore(testEnv)
    const capture = await store.getCapture(id, result.capture.captureId)
    const projection = await store.getLatestProjectionResultForOperation(id, result.capture.operationId, 'graphiti')
    const d1Mirror = await testEnv.D1_US.prepare(
      `SELECT source_system, source_ref, title, body_r2_key, body_sha256
       FROM canonical_captures
       WHERE tenant_id = ? AND id = ?`,
    ).bind(id, result.capture.captureId).first<Record<string, string | null>>()

    expect(capture?.id).toBe(result.capture.captureId)
    expect(result.capture.projectionKinds).toEqual([])
    expect(projection).toBeNull()
    expect(d1Mirror).toBeNull()
  })

  it('stores conversation chunks in Postgres and keeps memory_status/get_document stable after cutover', async () => {
    const id = tenantId('conversation')
    const tmk = await deriveTestTmk(id)
    await ensureTenantWithKek(id)
    const testEnv = createRuntimeEnv()
    const handlers = createToolRegistry(testEnv, id, tmk)
    const input = await encryptFixture(conversationFixture as CanonicalPipelineCaptureInput, id, 'conversation', tmk)

    const result = await captureThroughCanonicalPipeline({
      ...input,
      eagerProjectionDispatch: true,
      memoryType: 'semantic',
    }, testEnv, id)

    // Simulate a historical hindsight projection alongside the real (graphiti-only)
    // capture — memory_status still surfaces hindsight rows created before the
    // write path was severed in mission Phase 1.
    await seedHistoricalHindsightProjectionOnCapture({
      testEnv,
      tenantId: id,
      captureId: result.capture.captureId,
      documentId: result.capture.documentId,
      operationId: result.capture.operationId,
      resultStatus: 'completed',
    })

    const store = getCanonicalMemoryStore(testEnv)
    const document = await store.getDocument(id, result.capture.documentId)
    const status = await callTool<CanonicalMemoryStatusResult>(handlers, 'memory_status', {
      operation_id: result.capture.operationId,
    })
    const hydrated = await callTool<CanonicalDocumentResult>(handlers, 'get_document', {
      document_id: result.capture.documentId,
    })

    expect(document?.chunk_count).toBeGreaterThan(1)
    expect(status.operation.operationId).toBe(result.capture.operationId)
    expect(status.projections.some((item) => item.kind === 'hindsight')).toBe(true)
    expect(hydrated.documentId).toBe(result.capture.documentId)
    expect(hydrated.body).toContain('operations checklist still needs an owner')
  })

  it('preserves artifact-backed R2 linkage and graph/hindsight reconciliation through Postgres truth', async () => {
    const id = tenantId('artifact')
    const tmk = await deriveTestTmk(id)
    await ensureTenantWithKek(id)
    const testEnv = createRuntimeEnv()
    const input = await encryptFixture(artifactFixture as CanonicalPipelineCaptureInput, id, 'artifact', tmk)

    const result = await captureThroughCanonicalPipeline({
      ...input,
      eagerProjectionDispatch: true,
      memoryType: 'semantic',
    }, testEnv, id)

    // Historical hindsight projection seeded directly through the canonical
    // store — the write path was severed in mission Phase 1, but graph/hindsight
    // reconciliation over already-projected historical rows is still real
    // production behavior read straight from Postgres truth.
    const seeded = await seedHistoricalHindsightProjectionOnCapture({
      testEnv,
      tenantId: id,
      captureId: result.capture.captureId,
      documentId: result.capture.documentId,
      operationId: result.capture.operationId,
      resultStatus: 'completed',
    })
    await seedAvailableHindsightOperation({
      testEnv,
      tenantId: id,
      bankId: `hindsight-${id}`,
      operationId: seeded.engineOperationId!,
      sourceDocumentId: seeded.engineDocumentId!,
    })

    const store = getCanonicalMemoryStore(testEnv)
    const document = await store.getDocument(id, result.capture.documentId)
    const hindsight = await store.getLatestProjectionResultForOperation(id, result.capture.operationId, 'hindsight')
    const graph = await store.getLatestProjectionResultForOperation(id, result.capture.operationId, 'graphiti')
    const mappings = await store.listGraphIdentityMappings(id)
    const d1Artifact = await testEnv.D1_US.prepare(
      `SELECT filename, media_type, r2_key
       FROM canonical_artifacts
       WHERE tenant_id = ?`,
    ).bind(id).first<{ filename: string | null; media_type: string | null; r2_key: string | null }>()

    expect(document?.artifact_id).toBeTruthy()
    expect(document?.body_r2_key).toBeTruthy()
    expect(hindsight?.result_status).toBe('completed')
    // Graphiti engine retired in Phase 2: live captures create no graphiti projection job.
    expect(graph).toBeNull()
    // mappings are populated only by graphiti projection runs; none exist for retired engine.
    expect(d1Artifact).toBeNull()
  })
})
