// Mission Phase 3 (G7): full Hindsight data export to R2 before code removal.
// Reads the Hindsight engine's own Postgres tables (same Neon database as the
// canonical schema, different schema) generically and archives them as
// KEK-encrypted JSONL parts under brain-artifacts. The Cron KEK is the tenant
// TMK raw bytes, so this satisfies "encrypted with the tenant TMK".
// Graphiti identity mappings (haetsal_canonical) are whitelisted into the
// same export. Metadata-only manifest; no plaintext content outside R2 bodies.

import type { Env } from '../types/env'
import { encryptWithKek, fetchAndValidateKek } from '../cron/kek'
import { CANONICAL_POSTGRES_SCHEMA } from './canonical-postgres-schema'
import { createCanonicalPostgresSql } from './postgres-sql'

const EXCLUDED_SCHEMAS = ['pg_catalog', 'information_schema', CANONICAL_POSTGRES_SCHEMA]
const WHITELISTED_CANONICAL_TABLES = ['canonical_graph_identity_mappings']
const IDENTIFIER = /^[a-z_][a-z0-9_$]*$/i
export const EXPORT_PAGE_SIZE = 500

export interface HindsightExportTable { schema: string; table: string; rows: number }

export interface HindsightExportScan {
  tenants: Array<{ id: string; createdAt: number; primaryChannel: string | null; kekExpiresAt: number | null; kekValid: boolean }>
  tables: HindsightExportTable[]
}

export async function scanHindsightExport(env: Env): Promise<HindsightExportScan> {
  const sql = createCanonicalPostgresSql(env)
  const now = Date.now()
  const tenantRows = await env.D1_US.prepare(
    'SELECT id, created_at, primary_channel, cron_kek_expires_at FROM tenants ORDER BY created_at ASC LIMIT 20',
  ).all<{ id: string; created_at: number; primary_channel: string | null; cron_kek_expires_at: number | null }>()

  const tableRows = await sql`
    SELECT table_schema, table_name FROM information_schema.tables
    WHERE table_type = 'BASE TABLE'
    ORDER BY table_schema, table_name
  ` as Array<{ table_schema: string; table_name: string }>
  const candidates = tableRows.filter((row) =>
    (!EXCLUDED_SCHEMAS.includes(row.table_schema)
      || (row.table_schema === CANONICAL_POSTGRES_SCHEMA && WHITELISTED_CANONICAL_TABLES.includes(row.table_name)))
    && IDENTIFIER.test(row.table_schema) && IDENTIFIER.test(row.table_name))

  const tables: HindsightExportTable[] = []
  for (const candidate of candidates) {
    const count = await sql.query(
      `SELECT count(*)::int AS rows FROM "${candidate.table_schema}"."${candidate.table_name}"`,
    ) as Array<{ rows: number }>
    tables.push({ schema: candidate.table_schema, table: candidate.table_name, rows: count[0]?.rows ?? 0 })
  }

  return {
    tenants: (tenantRows.results ?? []).map((row) => ({
      id: row.id,
      createdAt: row.created_at,
      primaryChannel: row.primary_channel,
      kekExpiresAt: row.cron_kek_expires_at,
      kekValid: Boolean(row.cron_kek_expires_at && row.cron_kek_expires_at > now),
    })),
    tables,
  }
}

export interface HindsightExportTableResult {
  status: 'ok' | 'kek_unavailable' | 'unknown_table'
  written?: number
  nextOffset?: number | null
  r2Key?: string
}

export async function exportHindsightTable(
  args: { exportId: string; tenantId: string; schema: string; table: string; offset: number },
  env: Env,
): Promise<HindsightExportTableResult> {
  if (!/^hindsight-export-[0-9TZ:.-]+$/.test(args.exportId)) throw new Error('Invalid exportId')
  if (!Number.isInteger(args.offset) || args.offset < 0) throw new Error('Invalid offset')
  const scan = await scanHindsightExport(env)
  const known = scan.tables.find((table) => table.schema === args.schema && table.table === args.table)
  if (!known) return { status: 'unknown_table' }

  const kek = await fetchAndValidateKek(args.tenantId, env)
  if (!kek) return { status: 'kek_unavailable' }

  const sql = createCanonicalPostgresSql(env)
  const rows = await sql.query(
    `SELECT * FROM "${args.schema}"."${args.table}" ORDER BY ctid LIMIT ${EXPORT_PAGE_SIZE} OFFSET ${args.offset}`,
  ) as Array<Record<string, unknown>>
  const jsonl = rows.map((row) => JSON.stringify(row)).join('\n')
  const r2Key = `${args.exportId}/${args.schema}.${args.table}.${String(args.offset).padStart(8, '0')}.jsonl.enc`
  await env.R2_ARTIFACTS.put(r2Key, await encryptWithKek(jsonl, kek))

  return {
    status: 'ok',
    written: rows.length,
    nextOffset: rows.length === EXPORT_PAGE_SIZE ? args.offset + EXPORT_PAGE_SIZE : null,
    r2Key,
  }
}

export async function finalizeHindsightExport(
  args: {
    exportId: string
    tenantId: string
    tables: Array<HindsightExportTable & { parts: string[]; exportedRows: number }>
  },
  env: Env,
): Promise<{ manifestKey: string }> {
  if (!/^hindsight-export-[0-9TZ:.-]+$/.test(args.exportId)) throw new Error('Invalid exportId')
  const manifestKey = `${args.exportId}/manifest.json`
  await env.R2_ARTIFACTS.put(manifestKey, JSON.stringify({
    exportId: args.exportId,
    tenantId: args.tenantId,
    encryption: 'AES-GCM under tenant Cron KEK (= TMK raw bytes); decrypt with decryptWithKek',
    createdAt: Date.now(),
    pageSize: EXPORT_PAGE_SIZE,
    tables: args.tables,
    note: 'Mission Phase 3 G7 archival snapshot of Hindsight engine tables + Graphiti identity mappings. Archival-only by default; no hard-delete within the mission.',
  }, null, 2))
  return { manifestKey }
}
