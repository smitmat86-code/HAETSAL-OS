import type { Env } from '../types/env'
import { sha256Hex } from './canonical-memory-artifacts'
import type { CompiledArtifactFormat, CompiledDocumentFamily } from './compiled-synthesis-schema'

export interface CompiledArtifactPayloadInput {
  tenantId: string
  family: CompiledDocumentFamily
  stableKey: string
  artifactRole: string
  format: CompiledArtifactFormat
  version: string
  mediaType?: string | null
  contentEncrypted: string
}

export interface PersistedCompiledArtifactPayload {
  artifactRole: string
  format: CompiledArtifactFormat
  version: string
  mediaType: string | null
  r2Key: string
  sha256: string
  byteLength: number
}

function sanitizeSegment(value: string): string {
  const normalized = value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  return normalized || encodeURIComponent(value.trim().slice(0, 120))
}

function extensionFor(format: CompiledArtifactFormat): string {
  return format === 'markdown' ? 'md'
    : format === 'json' ? 'json'
      : 'html'
}

function defaultMediaType(format: CompiledArtifactFormat): string {
  return format === 'markdown' ? 'text/markdown'
    : format === 'json' ? 'application/json'
      : 'text/html'
}

export function buildCompiledArtifactR2Key(input: CompiledArtifactPayloadInput): string {
  return [
    'compiled',
    sanitizeSegment(input.tenantId),
    sanitizeSegment(input.family),
    sanitizeSegment(input.stableKey),
    sanitizeSegment(input.artifactRole),
    `${sanitizeSegment(input.version)}.${extensionFor(input.format)}`,
  ].join('/')
}

export async function persistCompiledArtifactPayload(
  env: Env,
  input: CompiledArtifactPayloadInput,
): Promise<PersistedCompiledArtifactPayload> {
  const r2Key = buildCompiledArtifactR2Key(input)
  await env.R2_ARTIFACTS.put(r2Key, input.contentEncrypted, {
    httpMetadata: { contentType: input.mediaType?.trim() || defaultMediaType(input.format) },
  })
  return {
    artifactRole: input.artifactRole,
    format: input.format,
    version: input.version.trim(),
    mediaType: input.mediaType?.trim() || defaultMediaType(input.format),
    r2Key,
    sha256: await sha256Hex(input.contentEncrypted),
    byteLength: new TextEncoder().encode(input.contentEncrypted).byteLength,
  }
}
