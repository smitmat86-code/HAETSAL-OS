import { describe, expect, it } from 'vitest'
import {
  ARTIFACT_DOWNLOAD_TIMEOUT_MS,
  ARTIFACT_INTAKE_CONFIG,
  ARTIFACT_MAX_BYTES,
  ARTIFACT_UPLOAD_EXPIRY_MS,
} from '../src/services/artifact-intake/config'
import {
  ARTIFACT_CLIENT_CAPABILITIES,
  ArtifactIntakeContractError,
  ARTIFACT_INTAKE_ERROR,
  requireAvailableArtifactByteTransport,
  resolveArtifactMimeType,
  resolveArtifactSealFamily,
} from '../src/services/artifact-intake/contracts'
import {
  CHATGPT_ARTIFACT_FILE_TOOL_CONTRACT,
  finalizeArtifactCaptureSchema,
  openAIFileDescriptorSchema,
  reserveArtifactUploadSchema,
} from '../src/services/artifact-intake/schemas'

function issueMessages(result: ReturnType<typeof finalizeArtifactCaptureSchema.safeParse>): string[] {
  return result.success ? [] : result.error.issues.map((issue) => issue.message)
}

describe('12.0 governed artifact intake contract', () => {
  it('fixes bounded defaults in one config module', () => {
    expect(ARTIFACT_MAX_BYTES).toBe(25 * 1024 * 1024)
    expect(ARTIFACT_DOWNLOAD_TIMEOUT_MS).toBe(20_000)
    expect(ARTIFACT_UPLOAD_EXPIRY_MS).toBe(15 * 60 * 1000)
    expect(ARTIFACT_INTAKE_CONFIG.mime.behavior).toBe('detected_authoritative_declared_must_match')
    expect(ARTIFACT_INTAKE_CONFIG.download.policy).toBe('public_https_only')
    expect(ARTIFACT_INTAKE_CONFIG.download.revalidateEveryRedirect).toBe(true)
  })

  it('matches the official ChatGPT four-field file schema and fileParams descriptor', () => {
    const fileSchema = CHATGPT_ARTIFACT_FILE_TOOL_CONTRACT.inputSchema.properties.file
    expect(Object.keys(fileSchema.properties).sort()).toEqual([
      'download_url', 'file_id', 'file_name', 'mime_type',
    ])
    expect(fileSchema.required).toEqual(['download_url', 'file_id'])
    expect(CHATGPT_ARTIFACT_FILE_TOOL_CONTRACT._meta['openai/fileParams']).toEqual(['file'])
    expect(openAIFileDescriptorSchema.safeParse({
      download_url: 'https://files.example.com/input',
      file_id: 'file_123',
    }).success).toBe(true)
  })

  it('gives every unresolved client an explicit raw-bytes failure', () => {
    expect(ARTIFACT_CLIENT_CAPABILITIES).toHaveLength(5)
    for (const capability of ARTIFACT_CLIENT_CAPABILITIES) {
      expect(capability.session1Available || capability.unavailableResult === 'raw_bytes_unavailable').toBe(true)
      expect(() => requireAvailableArtifactByteTransport(capability.client)).toThrowError(
        new ArtifactIntakeContractError(ARTIFACT_INTAKE_ERROR.RAW_BYTES_UNAVAILABLE),
      )
    }
  })

  it('rejects finalization when no source bytes were sealed', () => {
    const result = finalizeArtifactCaptureSchema.safeParse({
      tenant_id: 'tenant-a',
      searchable_content: 'client extraction',
      artifacts: [],
    })
    expect(result.success).toBe(false)
    expect(issueMessages(result)).toContain(ARTIFACT_INTAKE_ERROR.RAW_BYTES_UNAVAILABLE)
  })

  it('rejects a declared derivative that is missing from the sealed manifest', () => {
    const result = finalizeArtifactCaptureSchema.safeParse({
      tenant_id: 'tenant-a',
      searchable_content: 'client extraction',
      declared_derivative_upload_ids: ['upload-derivative'],
      artifacts: [{ upload_id: 'upload-source', tenant_id: 'tenant-a', role: 'source', primary: true }],
    })
    expect(result.success).toBe(false)
    expect(issueMessages(result)).toContain(ARTIFACT_INTAKE_ERROR.MISSING_DECLARED_DERIVATIVE)
  })

  it('rejects tenant-mismatched artifact receipts', () => {
    const result = finalizeArtifactCaptureSchema.safeParse({
      tenant_id: 'tenant-a',
      searchable_content: 'client extraction',
      artifacts: [{ upload_id: 'upload-source', tenant_id: 'tenant-b', role: 'source', primary: true }],
    })
    expect(result.success).toBe(false)
    expect(issueMessages(result)).toContain(ARTIFACT_INTAKE_ERROR.TENANT_MISMATCH)
  })

  it('requires a single primary and ordered derivative parents', () => {
    expect(finalizeArtifactCaptureSchema.safeParse({
      tenant_id: 'tenant-a',
      searchable_content: 'client extraction',
      declared_derivative_upload_ids: ['upload-derivative'],
      artifacts: [
        { upload_id: 'upload-source', tenant_id: 'tenant-a', role: 'source', primary: true },
        {
          upload_id: 'upload-derivative', tenant_id: 'tenant-a', role: 'derivative',
          parent_upload_id: 'upload-source', primary: false,
        },
      ],
    }).success).toBe(true)
  })

  it('uses detected MIME and rejects a meaningful declared mismatch', () => {
    expect(resolveArtifactMimeType({ detectedMimeType: 'image/png' })).toBe('image/png')
    expect(resolveArtifactMimeType({
      declaredMimeType: 'application/octet-stream',
      detectedMimeType: 'image/png',
    })).toBe('image/png')
    expect(() => resolveArtifactMimeType({
      declaredMimeType: 'image/jpeg',
      detectedMimeType: 'image/png',
    })).toThrowError(new ArtifactIntakeContractError(ARTIFACT_INTAKE_ERROR.MIME_MISMATCH))
  })

  it('rejects interactive uploads over the configured maximum', () => {
    const result = reserveArtifactUploadSchema.safeParse({
      tenant_id: 'tenant-a', client_name: 'Codex', idempotency_key: '1234567890abcdef',
      byte_length: ARTIFACT_MAX_BYTES + 1, plaintext_sha256: 'a'.repeat(64),
    })
    expect(result.success).toBe(false)
    expect(result.error?.issues.map((issue) => issue.message)).toContain(ARTIFACT_INTAKE_ERROR.BULK_IMPORT_REQUIRED)
  })

  it('fails closed when the authority-specific encryption key is absent', () => {
    expect(() => resolveArtifactSealFamily({
      authority: 'authenticated_client', hasTmk: false, hasValidKek: true,
    })).toThrowError(new ArtifactIntakeContractError(ARTIFACT_INTAKE_ERROR.ENCRYPTION_KEY_UNAVAILABLE))
    expect(() => resolveArtifactSealFamily({
      authority: 'provider_channel', hasTmk: true, hasValidKek: false,
    })).toThrowError(new ArtifactIntakeContractError(ARTIFACT_INTAKE_ERROR.ENCRYPTION_KEY_UNAVAILABLE))
    expect(() => resolveArtifactSealFamily({
      authority: 'provider_channel', hasTmk: false, hasValidKek: true,
    })).toThrowError(new ArtifactIntakeContractError(ARTIFACT_INTAKE_ERROR.ENCRYPTION_KEY_UNAVAILABLE))
    expect(resolveArtifactSealFamily({
      authority: 'authenticated_client', hasTmk: true, hasValidKek: false,
    })).toBe('TMK1')
    expect(resolveArtifactSealFamily({
      authority: 'provider_channel', hasTmk: true, hasValidKek: true,
    })).toBe('TMK1')
  })
})
