import { Hono } from 'hono'
import { deriveTmk } from '../../../middleware/auth'
import type { Env } from '../../../types/env'
import { ARTIFACT_MAX_BYTES } from '../../../services/artifact-intake/config'
import {
  ArtifactIntakeContractError,
  ARTIFACT_INTAKE_ERROR,
  type ArtifactIntakeErrorCode,
} from '../../../services/artifact-intake/contracts'
import {
  getArtifactIntakeStatus,
  uploadArtifactBytes,
} from '../../../services/artifact-intake/operations'

type Variables = { tenantId: string; jwtSub: string; traceId: string }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function begins(bytes: Uint8Array, signature: number[]): boolean {
  return signature.every((value, index) => bytes[index] === value)
}

export function detectArtifactMimeType(bytes: Uint8Array): string {
  if (begins(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png'
  if (begins(bytes, [0xff, 0xd8, 0xff])) return 'image/jpeg'
  if (begins(bytes, [0x47, 0x49, 0x46, 0x38])) return 'image/gif'
  if (
    begins(bytes, [0x52, 0x49, 0x46, 0x46]) &&
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
  ) return 'image/webp'
  if (begins(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d])) return 'application/pdf'

  try {
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes)
    if (!text.includes('\u0000')) return 'text/plain'
  } catch {
    // Non-text bytes stay application/octet-stream.
  }
  return 'application/octet-stream'
}

async function readBoundedBody(request: Request): Promise<Uint8Array> {
  const declaredLength = request.headers.get('content-length')
  if (declaredLength) {
    const parsed = Number(declaredLength)
    if (!Number.isSafeInteger(parsed) || parsed <= 0) {
      throw new ArtifactIntakeContractError(ARTIFACT_INTAKE_ERROR.RAW_BYTES_UNAVAILABLE)
    }
    if (parsed > ARTIFACT_MAX_BYTES) {
      throw new ArtifactIntakeContractError(ARTIFACT_INTAKE_ERROR.BULK_IMPORT_REQUIRED)
    }
  }
  if (!request.body) throw new ArtifactIntakeContractError(ARTIFACT_INTAKE_ERROR.RAW_BYTES_UNAVAILABLE)

  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      if (!value) continue
      total += value.byteLength
      if (total > ARTIFACT_MAX_BYTES) {
        await reader.cancel()
        throw new ArtifactIntakeContractError(ARTIFACT_INTAKE_ERROR.BULK_IMPORT_REQUIRED)
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  if (total === 0) throw new ArtifactIntakeContractError(ARTIFACT_INTAKE_ERROR.RAW_BYTES_UNAVAILABLE)
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes
}

function codeFor(error: unknown): ArtifactIntakeErrorCode {
  return error instanceof ArtifactIntakeContractError
    ? error.code
    : ARTIFACT_INTAKE_ERROR.INVALID_STATE
}

function statusFor(code: ArtifactIntakeErrorCode): 400 | 404 | 409 | 413 | 422 | 503 {
  if (code === ARTIFACT_INTAKE_ERROR.NOT_FOUND) return 404
  if (code === ARTIFACT_INTAKE_ERROR.BULK_IMPORT_REQUIRED) return 413
  if (code === ARTIFACT_INTAKE_ERROR.HASH_MISMATCH || code === ARTIFACT_INTAKE_ERROR.MIME_MISMATCH) return 422
  if (code === ARTIFACT_INTAKE_ERROR.ENCRYPTION_KEY_UNAVAILABLE) return 503
  if (code === ARTIFACT_INTAKE_ERROR.INVALID_STATE) return 409
  return 400
}

export const artifactContent = new Hono<{ Bindings: Env; Variables: Variables }>()

artifactContent.put('/:uploadId/content', async (c) => {
  try {
    const uploadId = c.req.param('uploadId')
    if (!UUID.test(uploadId)) throw new ArtifactIntakeContractError(ARTIFACT_INTAKE_ERROR.NOT_FOUND)
    if (!c.env.CF_ACCESS_AUD?.trim()) {
      throw new ArtifactIntakeContractError(ARTIFACT_INTAKE_ERROR.ENCRYPTION_KEY_UNAVAILABLE)
    }
    const existing = await getArtifactIntakeStatus({
      tenantId: c.get('tenantId'),
      uploadId,
    }, c.env)
    if (existing.status === 'finalized') return c.json(existing)
    if (existing.status === 'expired') {
      throw new ArtifactIntakeContractError(ARTIFACT_INTAKE_ERROR.INVALID_STATE)
    }
    const bytes = await readBoundedBody(c.req.raw)
    const detectedMimeType = detectArtifactMimeType(bytes)
    const declaredMimeType = c.req.header('Content-Type')?.split(';', 1)[0]?.trim().toLowerCase()
    const key = await deriveTmk(c.get('jwtSub'), c.env.CF_ACCESS_AUD)
    const receipt = await uploadArtifactBytes({
      tenantId: c.get('tenantId'),
      uploadId,
      bytes,
      detectedMimeType,
      declaredMimeType: declaredMimeType || undefined,
      encryptionFamily: 'tmk',
      key,
    }, c.env)
    return c.json(receipt)
  } catch (error) {
    const code = codeFor(error)
    return c.json({ status: 'failed', error_code: code }, statusFor(code))
  }
})
