import { ARTIFACT_INTAKE_CONFIG } from './config'

export const ARTIFACT_INTAKE_ERROR = Object.freeze({
  RAW_BYTES_UNAVAILABLE: 'raw_bytes_unavailable',
  MISSING_DECLARED_DERIVATIVE: 'missing_declared_derivative',
  TENANT_MISMATCH: 'tenant_mismatch',
  MIME_MISMATCH: 'mime_mismatch',
  BULK_IMPORT_REQUIRED: 'bulk_import_required',
  SSRF_URL_BLOCKED: 'ssrf_url_blocked',
  DOWNLOAD_TIMEOUT: 'download_timeout',
  DOWNLOAD_UNAVAILABLE: 'download_unavailable',
  ENCRYPTION_KEY_UNAVAILABLE: 'encryption_key_unavailable',
  ENCRYPTION_FAMILY_MISMATCH: 'encryption_family_mismatch',
  CIPHERTEXT_INVALID: 'ciphertext_invalid',
  HASH_MISMATCH: 'hash_mismatch',
  STORAGE_WRITE_FAILED: 'storage_write_failed',
  CANONICAL_WRITE_FAILED: 'canonical_write_failed',
  INVALID_STATE: 'invalid_state',
  CLIENT_IDENTITY_UNAVAILABLE: 'client_identity_unavailable',
  NOT_FOUND: 'not_found',
  INVALID_MANIFEST: 'invalid_manifest',
  PROVIDER_LOCATOR_INVALID: 'provider_locator_invalid',
  PROVIDER_RESPONSE_MISMATCH: 'provider_response_mismatch',
  LOCATOR_EXPIRED: 'locator_expired',
  UNSUPPORTED_MEDIA: 'unsupported_media',
  DELIVERY_REJECTED: 'delivery_rejected',
  DELIVERY_UNKNOWN: 'delivery_unknown',
  LEASE_LOST: 'lease_lost',
} as const)

export type ArtifactIntakeErrorCode = typeof ARTIFACT_INTAKE_ERROR[keyof typeof ARTIFACT_INTAKE_ERROR]

/** Content-free contract error. Callers may log the code, never the rejected value. */
export class ArtifactIntakeContractError extends Error {
  readonly code: ArtifactIntakeErrorCode

  constructor(code: ArtifactIntakeErrorCode) {
    super(code)
    this.name = 'ArtifactIntakeContractError'
    this.code = code
  }
}

export type ArtifactClientKind =
  | 'codex_local'
  | 'claude_code'
  | 'chatgpt_plugin'
  | 'telegram'
  | 'context_only'

export interface ArtifactClientCapabilityContract {
  client: ArtifactClientKind
  byteTransport: 'explicit_local_path_helper' | 'openai_file_parameter' | 'telegram_file_id' | null
  session1Available: boolean
  unavailableResult: typeof ARTIFACT_INTAKE_ERROR.RAW_BYTES_UNAVAILABLE | null
}

/**
 * Session 1 capability truth. A client cannot be treated as successful until
 * the later transport session makes its byte path available end to end.
 */
export const ARTIFACT_CLIENT_CAPABILITIES: readonly ArtifactClientCapabilityContract[] = Object.freeze([
  {
    client: 'codex_local',
    byteTransport: 'explicit_local_path_helper',
    session1Available: false,
    unavailableResult: ARTIFACT_INTAKE_ERROR.RAW_BYTES_UNAVAILABLE,
  },
  {
    client: 'claude_code',
    byteTransport: 'explicit_local_path_helper',
    session1Available: false,
    unavailableResult: ARTIFACT_INTAKE_ERROR.RAW_BYTES_UNAVAILABLE,
  },
  {
    client: 'chatgpt_plugin',
    byteTransport: 'openai_file_parameter',
    session1Available: false,
    unavailableResult: ARTIFACT_INTAKE_ERROR.RAW_BYTES_UNAVAILABLE,
  },
  {
    client: 'telegram',
    byteTransport: 'telegram_file_id',
    session1Available: false,
    unavailableResult: ARTIFACT_INTAKE_ERROR.RAW_BYTES_UNAVAILABLE,
  },
  {
    client: 'context_only',
    byteTransport: null,
    session1Available: false,
    unavailableResult: ARTIFACT_INTAKE_ERROR.RAW_BYTES_UNAVAILABLE,
  },
])

export function requireAvailableArtifactByteTransport(client: ArtifactClientKind): void {
  const capability = ARTIFACT_CLIENT_CAPABILITIES.find((entry) => entry.client === client)
  if (!capability?.session1Available) {
    throw new ArtifactIntakeContractError(ARTIFACT_INTAKE_ERROR.RAW_BYTES_UNAVAILABLE)
  }
}

function normalizedMime(value: string): string {
  return value.split(';', 1)[0]?.trim().toLowerCase() ?? ''
}

export function resolveArtifactMimeType(args: {
  declaredMimeType?: string | null
  detectedMimeType: string
}): string {
  const detected = normalizedMime(args.detectedMimeType)
  if (!detected) throw new ArtifactIntakeContractError(ARTIFACT_INTAKE_ERROR.MIME_MISMATCH)

  const declared = args.declaredMimeType ? normalizedMime(args.declaredMimeType) : ''
  if (!declared || ARTIFACT_INTAKE_CONFIG.mime.unspecifiedDeclaredTypes.includes(declared)) return detected
  if (declared !== detected) throw new ArtifactIntakeContractError(ARTIFACT_INTAKE_ERROR.MIME_MISMATCH)
  return detected
}

export function resolveArtifactSealFamily(args: {
  authority: 'authenticated_client' | 'provider_channel'
  hasTmk: boolean
  hasValidKek: boolean
}): 'TMK1' {
  if (args.authority === 'authenticated_client') {
    if (!args.hasTmk) throw new ArtifactIntakeContractError(ARTIFACT_INTAKE_ERROR.ENCRYPTION_KEY_UNAVAILABLE)
    return 'TMK1'
  }
  // Provider adapters need KEK authority for the encrypted ephemeral handoff,
  // then the tenant TMK for the durable managed original.
  if (!args.hasValidKek || !args.hasTmk) {
    throw new ArtifactIntakeContractError(ARTIFACT_INTAKE_ERROR.ENCRYPTION_KEY_UNAVAILABLE)
  }
  return 'TMK1'
}
