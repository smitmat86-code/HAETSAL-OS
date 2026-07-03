// scripts/mission-phase1-live-smoke.ts
// Mission Phase 1 gate live smoke: drive the REAL capture_memory MCP tool
// handler so a governed write lands in REAL canonical Postgres (Neon) and
// returns a provenance-tagged receipt.
//
// Run: npx tsx scripts/mission-phase1-live-smoke.ts
// Reads CANONICAL_POSTGRES_CONNECTION_STRING from .dev.vars. Never prints it.
// Cloudflare-local bindings (D1/R2/KV/queues) are stubbed in-memory: the
// canonical Postgres adapter is the surface under test. The full HTTPS/MCP
// client path is smoked at the Phase 3 prod deploy.

import { readFileSync } from 'fs'
import { webcrypto } from 'node:crypto'
import type { Env } from '../src/types/env'
import { installCanonicalMemoryStore } from '../src/services/canonical-postgres'
import { PostgresCanonicalMemoryStore } from '../src/services/canonical-postgres-repository'
import { createPostgresSql } from '../src/services/postgres-sql'
import { registerCanonicalMemoryTools } from '../src/tools/canonical-memory'

if (!globalThis.crypto) (globalThis as Record<string, unknown>).crypto = webcrypto

const SMOKE_TENANT = 'mission-smoke-phase1'
const SMOKE_MARK = `phase1-live-smoke-${crypto.randomUUID()}`

function readConnectionString(): string {
  const devVars = readFileSync('.dev.vars', 'utf8')
  const line = devVars.split(/\r?\n/).find((entry) => entry.startsWith('CANONICAL_POSTGRES_CONNECTION_STRING='))
  const value = line?.slice('CANONICAL_POSTGRES_CONNECTION_STRING='.length).trim().replace(/^"|"$/g, '')
  if (!value) throw new Error('CANONICAL_POSTGRES_CONNECTION_STRING missing from .dev.vars')
  return value
}

function makeFakeEnv(): Env {
  const r2 = new Map<string, string>()
  const d1Stub = {
    prepare(query: string) {
      const statement = {
        bind: (..._args: unknown[]) => statement,
        first: async () => (query.includes('FROM tenants') ? { id: SMOKE_TENANT } : null),
        run: async () => ({ success: true }),
        all: async () => ({ results: [] }),
        raw: async () => [],
      }
      return statement
    },
    batch: async (_statements: unknown[]) => [],
  }
  return {
    D1_US: d1Stub,
    R2_ARTIFACTS: {
      put: async (key: string, value: string) => { r2.set(key, value) },
      get: async (key: string) => (r2.has(key) ? { text: async () => r2.get(key)! } : null),
    },
    KV_SESSION: {
      get: async () => null,
      put: async () => undefined,
    },
    QUEUE_BULK: { send: async () => undefined },
    WORKER_DOMAIN: 'haetsalos.local-smoke',
  } as unknown as Env
}

async function deriveSmokeTmk(): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(SMOKE_MARK), { name: 'HKDF' }, false, ['deriveKey'],
  )
  return crypto.subtle.deriveKey(
    {
      name: 'HKDF', hash: 'SHA-256',
      salt: new TextEncoder().encode('phase1-smoke-salt'),
      info: new TextEncoder().encode('phase1-smoke-info'),
    },
    material, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'],
  )
}

type ToolResponse = { content: Array<{ text: string }> }
type ToolHandler = (input: unknown) => Promise<ToolResponse>

async function main(): Promise<void> {
  const sql = createPostgresSql(readConnectionString())
  const env = makeFakeEnv()
  installCanonicalMemoryStore(env, new PostgresCanonicalMemoryStore(sql))
  const tmk = await deriveSmokeTmk()

  const handlers = new Map<string, ToolHandler>()
  const pending: Promise<unknown>[] = []
  registerCanonicalMemoryTools(
    {
      tool(name: string, _description: string, _shape: object, handler: ToolHandler) {
        handlers.set(name, handler)
      },
    } as never,
    {
      getEnv: () => env,
      getTenantId: () => SMOKE_TENANT,
      getTmk: () => tmk,
      getExecutionContext: () => ({ waitUntil: (promise: Promise<unknown>) => { pending.push(promise) } }),
    },
  )

  const response = await handlers.get('capture_memory')!({
    content: `Mission phase 1 live smoke marker ${SMOKE_MARK}. Canonical governed write path verification row.`,
    scope: 'general',
    source_system: 'notes',
    source_ref: SMOKE_MARK,
  })
  await Promise.allSettled(pending.splice(0))
  const receipt = JSON.parse(response.content[0]?.text ?? 'null') as Record<string, unknown>
  const governance = receipt.governance as Record<string, unknown> | undefined

  if (receipt.status !== 'queued') throw new Error(`Receipt status ${String(receipt.status)} (expected queued)`)
  if (!receipt.canonical_capture_id) throw new Error('Receipt missing canonical_capture_id')
  if (governance?.trustState !== 'evidence') throw new Error('Receipt missing evidence-grade governance tag')
  if (governance?.authorKind !== 'external_client') throw new Error('Receipt missing external_client author tag')

  const rows = await sql`
    SELECT id, memory_class, trust_state, use_policy, author_kind, retention, source_ref
    FROM haetsal_canonical.canonical_captures
    WHERE tenant_id = ${SMOKE_TENANT} AND id = ${receipt.canonical_capture_id}
  ` as Array<Record<string, unknown>>
  if (rows.length !== 1) throw new Error('Capture row not found in canonical Postgres')
  if (rows[0]!.trust_state !== 'evidence' || rows[0]!.use_policy !== 'can_use_as_evidence') {
    throw new Error('Capture row missing governed envelope values')
  }

  const events = await sql`
    SELECT event_type, actor_kind FROM haetsal_canonical.canonical_events
    WHERE tenant_id = ${SMOKE_TENANT} AND capture_id = ${receipt.canonical_capture_id}
  ` as Array<Record<string, unknown>>
  if (!events.some((event) => event.event_type === 'memory.captured')) {
    throw new Error('Event ledger row not found for capture')
  }

  const chunks = await sql`
    SELECT c.chunk_text FROM haetsal_canonical.canonical_chunks c
    INNER JOIN haetsal_canonical.canonical_documents d ON d.id = c.document_id
    WHERE d.tenant_id = ${SMOKE_TENANT} AND d.capture_id = ${receipt.canonical_capture_id}
  ` as Array<Record<string, unknown>>
  if (chunks.length === 0 || !String(chunks[0]!.chunk_text).includes('live smoke marker')) {
    throw new Error('Searchable chunk text not found for capture')
  }

  console.log('PHASE1_LIVE_SMOKE_OK', JSON.stringify({
    tenant: SMOKE_TENANT,
    captureId: receipt.canonical_capture_id,
    operationId: receipt.canonical_operation_id,
    memoryClass: rows[0]!.memory_class,
    trustState: rows[0]!.trust_state,
    usePolicy: rows[0]!.use_policy,
    authorKind: rows[0]!.author_kind,
    eventTypes: events.map((event) => event.event_type),
    chunkCount: chunks.length,
  }, null, 2))
}

main().catch((error) => {
  const detail = error instanceof Error
    ? `${error.name}: ${error.message}\n${error.stack ?? ''}${'cause' in error && error.cause ? `\ncause: ${String(error.cause)}` : ''}`
    : String(error)
  console.error('PHASE1_LIVE_SMOKE_FAILED', detail)
  process.exit(1)
})
