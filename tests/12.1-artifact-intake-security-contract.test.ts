import { describe, expect, it } from 'vitest'
import {
  ArtifactIntakeContractError,
  ARTIFACT_INTAKE_ERROR,
} from '../src/services/artifact-intake/contracts'
import {
  assertArtifactResolvedAddressAllowed,
  validateInitialArtifactDownloadUrl,
} from '../src/services/artifact-intake/download-policy'
import { openAIFileDescriptorSchema } from '../src/services/artifact-intake/schemas'

describe('12.1 artifact download security contract', () => {
  it('accepts only credential-free public HTTPS URL shapes', () => {
    expect(validateInitialArtifactDownloadUrl('https://files.example.com/signed?token=opaque').hostname)
      .toBe('files.example.com')
    for (const blocked of [
      'http://files.example.com/input',
      'https://user:password@files.example.com/input',
      'https://localhost/input',
      'https://internal/input',
      'https://service.local/input',
      'https://127.0.0.1/input',
      'https://10.1.2.3/input',
      'https://169.254.169.254/latest/meta-data',
      'https://192.168.1.5/input',
      'https://[::1]/input',
      'not a URL',
    ]) {
      expect(() => validateInitialArtifactDownloadUrl(blocked)).toThrowError(
        new ArtifactIntakeContractError(ARTIFACT_INTAKE_ERROR.SSRF_URL_BLOCKED),
      )
    }
  })

  it('rejects private resolved addresses for DNS and redirect revalidation', () => {
    for (const blocked of ['127.0.0.1', '10.0.0.8', '169.254.169.254', '192.168.2.4', '::1', 'fd00::1']) {
      expect(() => assertArtifactResolvedAddressAllowed(blocked)).toThrowError(
        new ArtifactIntakeContractError(ARTIFACT_INTAKE_ERROR.SSRF_URL_BLOCKED),
      )
    }
    expect(() => assertArtifactResolvedAddressAllowed('203.1.2.3')).not.toThrow()
    expect(() => assertArtifactResolvedAddressAllowed('2606:4700:4700::1111')).not.toThrow()
  })

  it('applies the SSRF contract to ChatGPT file descriptors', () => {
    const result = openAIFileDescriptorSchema.safeParse({
      download_url: 'https://169.254.169.254/latest/meta-data',
      file_id: 'file_private',
      mime_type: 'text/plain',
      file_name: 'input.txt',
    })
    expect(result.success).toBe(false)
    expect(result.error?.issues.map((issue) => issue.message)).toContain(ARTIFACT_INTAKE_ERROR.SSRF_URL_BLOCKED)
  })
})
