// src/middleware/dlp.ts
// DLP stub — MCP routes only
// TODO: Phase 2+ — wire real Cloudflare Firewall for AI integration
// This middleware will eventually scrub/transform prompts before AI Gateway

import { createMiddleware } from 'hono/factory'
import type { Env } from '../types/env'

export function dlpMiddleware() {
  return createMiddleware<{ Bindings: Env }>(async (_c, next) => {
    // Stub — passthrough. Real DLP logic wired in Phase 2+
    // When active: inspect MCP tool call payloads, scrub PII before
    // forwarding to AI Gateway, log DLP events to memory_audit
    await next()
  })
}
