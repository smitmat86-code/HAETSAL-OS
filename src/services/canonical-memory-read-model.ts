import type { Env } from '../types/env'

export interface CanonicalMemoryReadOptions {
  tmk?: CryptoKey | null
}

export interface CanonicalListRow {
  capture_id: string
  document_id: string
  title: string | null
  scope: string
  source_system: string
  source_ref: string | null
  captured_at: number
  body_r2_key: string
}

export interface CanonicalDocumentRow extends CanonicalListRow {
  chunk_count: number
  document_created_at: number
  artifact_id: string | null
  filename: string | null
  media_type: string | null
  byte_length: number | null
}

export function clampCanonicalLimit(
  value: number | undefined,
  fallback: number,
  max: number,
): number {
  if (!Number.isFinite(value)) return fallback
  return Math.min(Math.max(Math.trunc(value ?? fallback), 1), max)
}

export async function decryptCanonicalPayload(
  encrypted: string,
  tmk: CryptoKey,
): Promise<string> {
  const combined = new Uint8Array(atob(encrypted).split('').map(char => char.charCodeAt(0)))
  const iv = combined.slice(0, 12)
  const ciphertext = combined.slice(12)
  const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, tmk, ciphertext)
  return new TextDecoder().decode(plaintext)
}

export async function readCanonicalDocumentBody(
  env: Env,
  r2Key: string,
  tmk: CryptoKey,
): Promise<string> {
  const stored = await env.R2_ARTIFACTS.get(r2Key)
  if (!stored) throw new Error(`Canonical document body missing from R2: ${r2Key}`)
  return decryptCanonicalPayload(await stored.text(), tmk)
}

export function buildCanonicalPreview(body: string, query?: string): string {
  const normalized = body.replace(/\s+/g, ' ').trim()
  if (!normalized) return ''
  if (!query?.trim()) return normalized.slice(0, 160)
  const needle = query.trim().toLowerCase()
  const start = Math.max(normalized.toLowerCase().indexOf(needle), 0)
  const offset = Math.max(start - 48, 0)
  const preview = normalized.slice(offset, offset + 160)
  return offset > 0 ? `...${preview}` : preview
}
