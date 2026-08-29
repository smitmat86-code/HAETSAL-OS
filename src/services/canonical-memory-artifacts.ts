import type { Env } from '../types/env'
import type {
  CanonicalArtifactPlan,
  NormalizedCanonicalCapture,
} from './canonical-memory-types'

export interface PersistedCanonicalPayloads {
  documentR2Key: string
  documentSha256: string
  artifacts: Record<string, { r2Key: string | null; sha256: string | null }>
}

export function canonicalR2Key(tenantId: string, lane: string, id: string): string {
  return `canonical/${tenantId}/${lane}/${id}.enc`
}

export async function sha256Hex(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value)
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(digest))
    .map(byte => byte.toString(16).padStart(2, '0'))
    .join('')
}

async function persistEncryptedObject(env: Env, key: string, body: string): Promise<string> {
  await env.R2_ARTIFACTS.put(key, body)
  return key
}

async function persistArtifactPayload(
  env: Env,
  tenantId: string,
  artifact: CanonicalArtifactPlan | null,
): Promise<{ artifactR2Key: string | null; artifactSha256: string | null }> {
  if (!artifact) return { artifactR2Key: null, artifactSha256: null }
  const inlinePayload = artifact.ref.contentEncrypted?.trim()
  if (inlinePayload) {
    const artifactR2Key = canonicalR2Key(tenantId, 'artifacts', artifact.id)
    await persistEncryptedObject(env, artifactR2Key, inlinePayload)
    return {
      artifactR2Key,
      artifactSha256: artifact.ref.sha256 ?? await sha256Hex(inlinePayload),
    }
  }
  return {
    artifactR2Key: artifact.ref.storageKey ?? null,
    artifactSha256: artifact.ref.sha256 ?? null,
  }
}

export async function persistCanonicalPayloads(
  capture: NormalizedCanonicalCapture,
  env: Env,
): Promise<PersistedCanonicalPayloads> {
  const documentR2Key = canonicalR2Key(capture.tenantId, 'documents', capture.documentId)
  await persistEncryptedObject(env, documentR2Key, capture.bodyEncrypted)
  const artifacts = Object.fromEntries(await Promise.all(capture.artifacts.map(async artifact => {
    const persisted = await persistArtifactPayload(env, capture.tenantId, artifact)
    return [artifact.id, { r2Key: persisted.artifactR2Key, sha256: persisted.artifactSha256 }]
  })))
  return {
    documentR2Key,
    documentSha256: await sha256Hex(capture.body),
    artifacts,
  }
}
