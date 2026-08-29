import { ArtifactIntakeContractError, ARTIFACT_INTAKE_ERROR } from './contracts'
import type { ArtifactDownloadResponse } from './download-types'

function declaredContentLength(headers: Headers): number | null {
  const value = headers.get('content-length')
  if (value === null) return null
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new ArtifactIntakeContractError(ARTIFACT_INTAKE_ERROR.DOWNLOAD_UNAVAILABLE)
  }
  return parsed
}

export async function readBoundedArtifactResponse(
  response: ArtifactDownloadResponse,
  maxBytes: number,
): Promise<Uint8Array> {
  const declared = declaredContentLength(response.headers)
  if (declared !== null && declared > maxBytes) {
    response.cancel()
    throw new ArtifactIntakeContractError(ARTIFACT_INTAKE_ERROR.BULK_IMPORT_REQUIRED)
  }
  if (!response.body) throw new ArtifactIntakeContractError(ARTIFACT_INTAKE_ERROR.RAW_BYTES_UNAVAILABLE)

  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value) continue
      total += value.byteLength
      if (total > maxBytes) {
        await reader.cancel()
        response.cancel()
        throw new ArtifactIntakeContractError(ARTIFACT_INTAKE_ERROR.BULK_IMPORT_REQUIRED)
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  if (total === 0) throw new ArtifactIntakeContractError(ARTIFACT_INTAKE_ERROR.RAW_BYTES_UNAVAILABLE)
  if (declared !== null && declared !== total) {
    throw new ArtifactIntakeContractError(ARTIFACT_INTAKE_ERROR.DOWNLOAD_UNAVAILABLE)
  }

  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes
}
