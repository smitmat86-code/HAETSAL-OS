// src/agents/helpers.ts
// Agent helpers — doom loop detection, encryption for R2, context budget
// Extracted from base-agent.ts for postflight line limits

import type { DoomLoopState } from './types'

export const MODEL_CONTEXT_LIMIT = 128_000
export const FLUSH_THRESHOLD = 0.80

export function shouldFlush(cumulativeTokens: number): boolean {
  return cumulativeTokens / MODEL_CONTEXT_LIMIT > FLUSH_THRESHOLD
}

async function computeInputHash(toolName: string, input: unknown): Promise<string> {
  const data = new TextEncoder().encode(toolName + JSON.stringify(input))
  const hash = await crypto.subtle.digest('SHA-256', data)
  return btoa(String.fromCharCode(...new Uint8Array(hash))).slice(0, 16)
}

export async function checkDoomLoop(
  state: DoomLoopState, toolName: string, input: unknown,
): Promise<'ok' | 'warn' | 'break'> {
  const hash = await computeInputHash(toolName, input)
  const recentSame = state.calls.filter(c => c.inputHash === hash)
  if (recentSame.length >= 5) return 'break'
  state.calls.push({ toolName, inputHash: hash })
  if (recentSame.length >= 3) { state.warnCount++; return 'warn' }
  return 'ok'
}

export async function encryptForR2(content: string, tmk: CryptoKey): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const data = new TextEncoder().encode(content)
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, tmk, data)
  const combined = new Uint8Array(iv.length + ciphertext.byteLength)
  combined.set(iv)
  combined.set(new Uint8Array(ciphertext), iv.length)
  return btoa(String.fromCharCode(...combined))
}

export async function writeAnomalySignal(
  env: { D1_US: D1Database }, tenantId: string, signalType: string, detail: string,
): Promise<void> {
  await env.D1_US.prepare(
    `INSERT OR IGNORE INTO anomaly_signals (id, tenant_id, created_at, signal_type, severity, detail_json)
     VALUES (?, ?, ?, ?, 'high', ?)`,
  ).bind(crypto.randomUUID(), tenantId, Date.now(), signalType, JSON.stringify({ detail })).run()
}
