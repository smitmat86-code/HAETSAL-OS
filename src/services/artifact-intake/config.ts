export const ARTIFACT_MAX_BYTES = 25 * 1024 * 1024
export const TELEGRAM_ARTIFACT_MAX_BYTES = 20 * 1024 * 1024
export const ARTIFACT_DOWNLOAD_TIMEOUT_MS = 20_000
export const ARTIFACT_UPLOAD_EXPIRY_MS = 15 * 60 * 1000
export const ARTIFACT_MAX_REDIRECTS = 3

export const ARTIFACT_INTAKE_CONFIG = Object.freeze({
  maxBytes: ARTIFACT_MAX_BYTES,
  providerLimits: Object.freeze({
    telegramMaxBytes: TELEGRAM_ARTIFACT_MAX_BYTES,
  }),
  mime: Object.freeze({
    behavior: 'detected_authoritative_declared_must_match',
    unspecifiedDeclaredTypes: Object.freeze(['application/octet-stream']),
  }),
  download: Object.freeze({
    policy: 'public_https_only',
    timeoutMs: ARTIFACT_DOWNLOAD_TIMEOUT_MS,
    maxRedirects: ARTIFACT_MAX_REDIRECTS,
    revalidateEveryRedirect: true,
    pinResolvedAddressPerRequest: true,
  }),
  uploadExpiryMs: ARTIFACT_UPLOAD_EXPIRY_MS,
} as const)
