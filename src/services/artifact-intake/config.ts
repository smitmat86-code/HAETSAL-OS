export const ARTIFACT_MAX_BYTES = 25 * 1024 * 1024
export const TELEGRAM_ARTIFACT_MAX_BYTES = 20 * 1024 * 1024
export const ARTIFACT_DOWNLOAD_TIMEOUT_MS = 20_000
export const ARTIFACT_UPLOAD_EXPIRY_MS = 15 * 60 * 1000
export const ARTIFACT_MAX_REDIRECTS = 3
export const CHANNEL_MEDIA_HANDOFF_EXPIRY_MS = 24 * 60 * 60 * 1000
export const CHANNEL_MEDIA_JOB_LEASE_MS = 2 * 60 * 1000
// A reservation is not abandoned until it outlives both the provider handoff
// window and one complete Worker lease. This is longer than any live isolate.
export const CHANNEL_MEDIA_FINALIZATION_STALE_MS =
  CHANNEL_MEDIA_HANDOFF_EXPIRY_MS + CHANNEL_MEDIA_JOB_LEASE_MS
export const CHANNEL_MEDIA_QUEUE_RETRY_MIN_SECONDS = 1
export const CHANNEL_MEDIA_QUEUE_RETRY_MAX_SECONDS = 5 * 60
export const CHANNEL_MEDIA_MAX_ATTEMPTS = 4
export const CHANNEL_MEDIA_LOCATOR_MAX_CHARS = 2_048
export const CHANNEL_MEDIA_REPLY_TARGET_MAX_CHARS = 128
export const CHANNEL_MEDIA_CAPTION_MAX_CHARS = 4_096
export const CHANNEL_MEDIA_DESCRIPTION_MAX_CHARS = 8_192
export const CHANNEL_MEDIA_HANDOFF_MAX_BYTES = 8_192
export const CHANNEL_MEDIA_RECOVERY_MAX_BYTES = 16_384

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
  channelMedia: Object.freeze({
    handoffExpiryMs: CHANNEL_MEDIA_HANDOFF_EXPIRY_MS,
    leaseMs: CHANNEL_MEDIA_JOB_LEASE_MS,
    finalizationStaleMs: CHANNEL_MEDIA_FINALIZATION_STALE_MS,
    queueRetryMinSeconds: CHANNEL_MEDIA_QUEUE_RETRY_MIN_SECONDS,
    queueRetryMaxSeconds: CHANNEL_MEDIA_QUEUE_RETRY_MAX_SECONDS,
    maxAttempts: CHANNEL_MEDIA_MAX_ATTEMPTS,
    locatorMaxChars: CHANNEL_MEDIA_LOCATOR_MAX_CHARS,
    replyTargetMaxChars: CHANNEL_MEDIA_REPLY_TARGET_MAX_CHARS,
    captionMaxChars: CHANNEL_MEDIA_CAPTION_MAX_CHARS,
    descriptionMaxChars: CHANNEL_MEDIA_DESCRIPTION_MAX_CHARS,
    handoffMaxBytes: CHANNEL_MEDIA_HANDOFF_MAX_BYTES,
    recoveryMaxBytes: CHANNEL_MEDIA_RECOVERY_MAX_BYTES,
  }),
} as const)
