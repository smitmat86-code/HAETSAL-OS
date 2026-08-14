import { z } from 'zod'
import type { Env } from '../types/env'
import { ARTIFACT_MAX_BYTES } from '../services/artifact-intake/config'
import type { DownloadedArtifactFile, HostedArtifactFileDescriptor } from '../services/artifact-intake/download'
import { openAIFileDescriptorSchema } from '../services/artifact-intake/schemas'

export const ARTIFACT_INTAKE_TOOL_NAMES = [
  'reserve_artifact_upload',
  'finalize_artifact_capture',
  'artifact_intake_status',
  'capture_artifact_file',
] as const

const uploadId = z.string().uuid()
const sha256 = z.string().regex(/^[a-f0-9]{64}$/i)
const mimeType = z.string().trim().min(1).max(255)
const idempotencyKey = z.string().trim().min(16).max(200)

export const reserveArtifactUploadToolSchema = z.object({
  idempotency_key: idempotencyKey,
  byte_length: z.number().int().positive().max(ARTIFACT_MAX_BYTES),
  plaintext_sha256: sha256,
  declared_mime_type: mimeType.optional(),
}).strict()

const manifestEntry = z.object({
  upload_id: uploadId,
  role: z.enum(['source', 'derivative']),
  parent_upload_id: uploadId.optional(),
  primary: z.boolean(),
  declared_mime_type: mimeType.optional(),
  detected_mime_type: mimeType,
  byte_length: z.number().int().positive().max(ARTIFACT_MAX_BYTES),
  plaintext_sha256: sha256,
}).strict()

export const finalizeArtifactCaptureToolSchema = z.object({
  searchable_content: z.string().trim().min(1).max(1_000_000),
  title: z.string().trim().min(1).max(500).optional(),
  scope: z.string().trim().min(1).max(120).default('general'),
  provenance: z.string().trim().min(1).max(500).optional(),
  model_runtime: z.string().trim().min(1).max(160).optional(),
  source_ref: z.string().trim().min(1).max(200).optional(),
  idempotency_key: idempotencyKey,
  expected_artifact_count: z.number().int().positive().max(100),
  declared_derivative_upload_ids: z.array(uploadId),
  artifacts: z.array(manifestEntry).min(1).max(100),
}).strict()

export const artifactIntakeStatusToolSchema = z.object({ upload_id: uploadId }).strict()

export const captureArtifactFileToolSchema = z.object({
  file: openAIFileDescriptorSchema,
  searchable_content: z.string().trim().min(1).max(1_000_000),
  title: z.string().trim().min(1).max(500).optional(),
  scope: z.string().trim().min(1).max(120).default('general'),
  model_runtime: z.string().trim().min(1).max(160).optional(),
}).strict()

export const artifactWriteAnnotations = Object.freeze({
  readOnlyHint: false,
  destructiveHint: false,
  openWorldHint: false,
})

export const artifactStatusAnnotations = Object.freeze({
  readOnlyHint: true,
  destructiveHint: false,
  openWorldHint: false,
})

export interface ArtifactIntakeToolContext {
  getEnv: () => Env
  getTenantId: () => string
  getTmk: () => CryptoKey | null
  getClientIdentity: () => { clientName: string | null; agentIdentity: string | null }
  downloadHostedFile?: (descriptor: HostedArtifactFileDescriptor) => Promise<DownloadedArtifactFile>
}
