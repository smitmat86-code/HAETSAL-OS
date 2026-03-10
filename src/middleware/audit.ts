// src/middleware/audit.ts
// Audit write helpers — waitUntil pattern for non-blocking writes
// All audit writes to memory_audit table; metadata only — NEVER plaintext content

import { createMiddleware } from 'hono/factory'
import type { Env } from '../types/env'

type AuditVariables = {
  traceId: string
}

// Direct audit write — use for waitUntil() calls outside middleware chain
export async function writeAuditLog(
  env: Env,
  operation: string,
  tenantId: string,
  extra?: { memoryId?: string; agentIdentity?: string; domain?: string },
): Promise<void> {
  try {
    await env.D1_US.prepare(
      `INSERT INTO memory_audit (id, tenant_id, created_at, operation, memory_id, agent_identity, domain)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      crypto.randomUUID(),
      tenantId,
      Date.now(),
      operation,
      extra?.memoryId ?? null,
      extra?.agentIdentity ?? 'mcpagent/stub',
      extra?.domain ?? null,
    ).run()
  } catch {
    // Best-effort audit — never crash on audit failure in waitUntil
  }
}

// Audit middleware — stamps trace context for downstream handlers
// Actual audit writes happen via writeAuditLog in waitUntil() calls
export function auditMiddleware() {
  return createMiddleware<{ Bindings: Env; Variables: AuditVariables }>(async (c, next) => {
    c.set('traceId', crypto.randomUUID())
    await next()
  })
}
