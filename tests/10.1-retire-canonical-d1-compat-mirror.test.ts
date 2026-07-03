import { describe, expect, it, vi } from 'vitest'
import { env } from 'cloudflare:test'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { captureThroughCanonicalPipeline } from '../src/services/canonical-capture-pipeline'
import { getCanonicalMemoryStore } from '../src/services/canonical-postgres'
import { encryptContentForArchive } from '../src/services/ingestion/encryption'
import { registerCanonicalMemoryTools } from '../src/tools/canonical-memory'
import type { CanonicalPipelineCaptureInput } from '../src/types/canonical-capture-pipeline'
import type {
  CanonicalDocumentResult,
  CanonicalMemoryStatusResult,
  CanonicalSearchResult,
} from '../src/types/canonical-memory-query'
import { createGraphitiContainerTestEnv } from './support/graphiti-test-env'
import { createHindsightTestEnv, type HindsightRecallRow } from './support/hindsight-test-env'
import { seedAvailableHindsightOperation, seedHistoricalHindsightProjectionOnCapture } from './support/hindsight-historical-projection-seed'
import conversationFixture from './fixtures/canonical-memory/conversation-capture.json'
import noteFixture from './fixtures/canonical-memory/note-capture.json'

type ToolResponse = { content: Array<{ text: string }> }
type ToolHandler = (input: unknown) => Promise<ToolResponse>
type ToolRegistry = { handlers: Map<string, ToolHandler>; pending: Promise<unknown>[] }

function tenantId(label: string): string {
  return `test-tenant-canonical-101-${label}-${crypto.randomUUID()}`
}

async function deriveTestTmk(seed: string): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(`canonical-101-${seed}`),
    { name: 'HKDF' },
    false,
    ['deriveKey'],
  )
  return crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new TextEncoder().encode('canonical-101-salt'),
      info: new TextEncoder().encode('canonical-101-info'),
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

function createRuntimeEnv(recallResults: HindsightRecallRow[] = []): typeof env {
  const { testEnv: graphEnv } = createGraphitiContainerTestEnv()
  return {
    ...createHindsightTestEnv({ operationStatus: 'completed', recallResults }),
    GRAPHITI_RUNTIME_MODE: graphEnv.GRAPHITI_RUNTIME_MODE,
    GRAPHITI: graphEnv.GRAPHITI,
  } as typeof env
}

function createToolRegistry(
  testEnv: typeof env,
  tenantId: string,
  tmk: CryptoKey,
): ToolRegistry {
  const handlers = new Map<string, ToolHandler>()
  const pending: Promise<unknown>[] = []
  const server = {
    tool(name: string, _description: string, _shape: object, handler: ToolHandler) {
      handlers.set(name, handler)
    },
  } as unknown as McpServer
  registerCanonicalMemoryTools(server, {
    getEnv: () => testEnv,
    getTenantId: () => tenantId,
    getTmk: () => tmk,
    getExecutionContext: () => ({
      waitUntil: (promise: Promise<unknown>) => { pending.push(promise) },
    }),
  })
  return { handlers, pending }
}

async function callTool<T>(
  registry: ToolRegistry,
  name: string,
  input: unknown,
): Promise<T> {
  const response = await registry.handlers.get(name)?.(input)
  await Promise.allSettled(registry.pending.splice(0))
  return JSON.parse(response?.content[0]?.text ?? 'null') as T
}

async function readD1Count(
  testEnv: typeof env,
  table: string,
  tenantId: string,
): Promise<number> {
  const row = await testEnv.D1_US.prepare(
    `SELECT COUNT(*) AS count FROM ${table} WHERE tenant_id = ?`,
  ).bind(tenantId).first<{ count: number }>()
  return row?.count ?? 0
}

async function expectNoCanonicalMirrorRows(testEnv: typeof env, tenantId: string): Promise<void> {
  for (const table of [
    'canonical_captures',
    'canonical_artifacts',
    'canonical_documents',
    'canonical_chunks',
    'canonical_memory_operations',
    'canonical_projection_jobs',
    'canonical_projection_results',
    'canonical_graph_identity_mappings',
  ]) {
    expect(await readD1Count(testEnv, table, tenantId)).toBe(0)
  }
}

describe('10.1 retire canonical D1 compatibility mirror', () => {
  it('captures canonically without D1 metadata mirroring and keeps memory_status/get_document/search_memory stable', async () => {
    const id = tenantId('stable-read-path')
    const tmk = await deriveTestTmk(id)
    await ensureTenantWithKek(id)
    const recallResults: HindsightRecallRow[] = []
    const testEnv = createRuntimeEnv(recallResults)
    const handlers = createToolRegistry(testEnv, id, tmk)
    const input = await encryptFixture(conversationFixture as CanonicalPipelineCaptureInput, id, 'stable', tmk)

    const result = await captureThroughCanonicalPipeline({
      ...input,
      eagerProjectionDispatch: true,
      memoryType: 'semantic',
    }, testEnv, id)

    // Historical hindsight projection seeded directly through the canonical
    // store — the write path was severed in mission Phase 1, but the read
    // path (memory_status/search_memory) still has to serve historical rows.
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
    recallResults.splice(0, recallResults.length, {
      id: 'stable-semantic',
      document_id: seeded.engineDocumentId!,
      text: 'The operations checklist still needs an owner before launch.',
      score: 0.97,
      metadata: { source: 'mcp_memory_write', domain: 'general' },
      tags: [`tenant:${id}`, 'domain:general', 'source:mcp_memory_write'],
    })

    const status = await callTool<CanonicalMemoryStatusResult>(handlers, 'memory_status', {
      operation_id: result.capture.operationId,
    })
    const document = await callTool<CanonicalDocumentResult>(handlers, 'get_document', {
      document_id: result.capture.documentId,
    })
    const search = await callTool<CanonicalSearchResult>(handlers, 'search_memory', {
      query: 'Who still owns the operations checklist?',
      mode: 'semantic',
      limit: 5,
    })

    expect(status.operation.operationId).toBe(result.capture.operationId)
    expect(status.projections.find((item) => item.kind === 'hindsight')?.resultStatus).toBe('completed')
    expect(document.documentId).toBe(result.capture.documentId)
    expect(document.body).toContain('operations checklist still needs an owner')
    expect(search.items[0]?.captureId).toBe(result.capture.captureId)
    expect(search.items[0]?.documentId).toBe(result.capture.documentId)
    await expectNoCanonicalMirrorRows(testEnv, id)
  })

  it('reconciles hindsight using Postgres-only canonical truth', async () => {
    const id = tenantId('hindsight-reconcile')
    const tmk = await deriveTestTmk(id)
    await ensureTenantWithKek(id)
    const testEnv = createRuntimeEnv()
    const input = await encryptFixture(noteFixture as CanonicalPipelineCaptureInput, id, 'hindsight', tmk)

    const result = await captureThroughCanonicalPipeline({
      ...input,
      eagerProjectionDispatch: true,
      memoryType: 'episodic',
    }, testEnv, id)

    // The hindsight write path was severed in mission Phase 1: captures no
    // longer create hindsight projections. Historical rows still have to
    // reconcile from Postgres-only canonical truth (no D1 mirror), so this
    // seeds the historical projection state the same way a pre-cutover
    // completed retain would have left it.
    await seedHistoricalHindsightProjectionOnCapture({
      testEnv,
      tenantId: id,
      captureId: result.capture.captureId,
      documentId: result.capture.documentId,
      operationId: result.capture.operationId,
      resultStatus: 'completed',
    })
    const store = getCanonicalMemoryStore(testEnv)
    const projection = await store.getLatestProjectionResultForOperation(id, result.capture.operationId, 'hindsight')

    expect(projection?.result_status).toBe('completed')
    expect(projection?.engine_document_id).toBeTruthy()
    expect(projection?.target_ref).toContain('hindsight://banks/')
    expect(await readD1Count(testEnv, 'canonical_projection_results', id)).toBe(0)
    expect(await readD1Count(testEnv, 'canonical_projection_jobs', id)).toBe(0)
  })

  it('reconciles graphiti using Postgres-only canonical truth', async () => {
    const id = tenantId('graphiti-reconcile')
    const tmk = await deriveTestTmk(id)
    await ensureTenantWithKek(id)
    const testEnv = createRuntimeEnv()
    const input = await encryptFixture(conversationFixture as CanonicalPipelineCaptureInput, id, 'graphiti', tmk)

    const result = await captureThroughCanonicalPipeline({
      ...input,
      eagerProjectionDispatch: true,
      memoryType: 'semantic',
    }, testEnv, id)
    const store = getCanonicalMemoryStore(testEnv)
    const projection = await store.getLatestProjectionResultForOperation(id, result.capture.operationId, 'graphiti')
    const mappings = await store.listGraphIdentityMappings(id)

    expect(projection?.result_status).toBe('completed')
    expect(projection?.target_ref).toContain('graphiti://episodes/')
    expect(mappings.length).toBeGreaterThan(0)
    expect(await readD1Count(testEnv, 'canonical_graph_identity_mappings', id)).toBe(0)
  })

  it('keeps D1 broker traces while canonical metadata mirror rows stay absent', async () => {
    const id = tenantId('broker-trace-only')
    const tmk = await deriveTestTmk(id)
    await ensureTenantWithKek(id)
    const recallResults: HindsightRecallRow[] = []
    const testEnv = createRuntimeEnv(recallResults)
    const handlers = createToolRegistry(testEnv, id, tmk)
    const input = await encryptFixture(conversationFixture as CanonicalPipelineCaptureInput, id, 'broker', tmk)

    const result = await captureThroughCanonicalPipeline({
      ...input,
      eagerProjectionDispatch: true,
      memoryType: 'semantic',
    }, testEnv, id)

    // Historical hindsight projection seeded directly through the canonical
    // store (write path severed in mission Phase 1) so search_memory has a
    // linkback to resolve, exercising the broker trace over historical data.
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
    recallResults.splice(0, recallResults.length, {
      id: 'broker-semantic',
      document_id: seeded.engineDocumentId!,
      text: 'User still needs an owner for the operations checklist before the next meeting.',
      score: 0.95,
      metadata: { source: 'mcp_memory_write', domain: 'general' },
      tags: [`tenant:${id}`, 'domain:general', 'source:mcp_memory_write'],
    })

    const search = await callTool<CanonicalSearchResult>(handlers, 'search_memory', {
      query: 'What do I know about User?',
      mode: 'semantic',
      limit: 5,
    })

    expect(search.broker?.queryId).toBeTruthy()
    expect(await readD1Count(testEnv, 'canonical_broker_traces', id)).toBeGreaterThan(0)
    await expectNoCanonicalMirrorRows(testEnv, id)
  })
})
