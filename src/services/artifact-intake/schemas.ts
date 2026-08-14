import { z } from 'zod'
import { ARTIFACT_MAX_BYTES, TELEGRAM_ARTIFACT_MAX_BYTES } from './config'
import { ARTIFACT_INTAKE_ERROR } from './contracts'
import { validateInitialArtifactDownloadUrl } from './download-policy'

const tenantIdSchema = z.string().trim().min(1).max(160)
const uploadIdSchema = z.string().trim().min(1).max(160)
const mimeTypeSchema = z.string().trim().min(1).max(255)

export const reserveArtifactUploadSchema = z.object({
  tenant_id: tenantIdSchema,
  client_name: z.string().trim().min(1).max(120),
  idempotency_key: z.string().trim().min(16).max(200),
  byte_length: z.number().int().positive().max(ARTIFACT_MAX_BYTES, ARTIFACT_INTAKE_ERROR.BULK_IMPORT_REQUIRED),
  plaintext_sha256: z.string().regex(/^[a-f0-9]{64}$/i),
  declared_mime_type: mimeTypeSchema.optional(),
})

export const openAIFileDescriptorSchema = z.object({
  download_url: z.string().superRefine((value, ctx) => {
    try {
      validateInitialArtifactDownloadUrl(value)
    } catch {
      ctx.addIssue({ code: 'custom', message: ARTIFACT_INTAKE_ERROR.SSRF_URL_BLOCKED })
    }
  }),
  file_id: z.string().trim().min(1),
  mime_type: mimeTypeSchema.optional(),
  file_name: z.string().trim().min(1).max(512).optional(),
}).strict()

export const telegramArtifactFileDescriptorSchema = z.object({
  file_id: z.string().trim().min(1),
  file_unique_id: z.string().trim().min(1).optional(),
  file_size: z.number().int().positive().max(
    TELEGRAM_ARTIFACT_MAX_BYTES,
    ARTIFACT_INTAKE_ERROR.BULK_IMPORT_REQUIRED,
  ).optional(),
  mime_type: mimeTypeSchema.optional(),
  file_name: z.string().trim().min(1).max(512).optional(),
}).strict()

const artifactManifestEntrySchema = z.object({
  upload_id: uploadIdSchema,
  tenant_id: tenantIdSchema,
  role: z.enum(['source', 'derivative']),
  parent_upload_id: uploadIdSchema.optional(),
  primary: z.boolean(),
}).strict()

export const finalizeArtifactCaptureSchema = z.object({
  tenant_id: tenantIdSchema,
  searchable_content: z.string().trim().min(1),
  declared_derivative_upload_ids: z.array(uploadIdSchema).default([]),
  artifacts: z.array(artifactManifestEntrySchema),
}).strict().superRefine((value, ctx) => {
  if (value.artifacts.length === 0) {
    ctx.addIssue({ code: 'custom', path: ['artifacts'], message: ARTIFACT_INTAKE_ERROR.RAW_BYTES_UNAVAILABLE })
    return
  }

  const ids = new Set<string>()
  let sourceCount = 0
  let primaryCount = 0
  for (const [index, artifact] of value.artifacts.entries()) {
    if (ids.has(artifact.upload_id)) {
      ctx.addIssue({ code: 'custom', path: ['artifacts', index, 'upload_id'], message: ARTIFACT_INTAKE_ERROR.INVALID_MANIFEST })
    }
    if (artifact.tenant_id !== value.tenant_id) {
      ctx.addIssue({ code: 'custom', path: ['artifacts', index, 'tenant_id'], message: ARTIFACT_INTAKE_ERROR.TENANT_MISMATCH })
    }
    if (artifact.role === 'source') {
      sourceCount += 1
      if (artifact.parent_upload_id) {
        ctx.addIssue({ code: 'custom', path: ['artifacts', index, 'parent_upload_id'], message: ARTIFACT_INTAKE_ERROR.INVALID_MANIFEST })
      }
    } else if (index > 0 && (!artifact.parent_upload_id || !ids.has(artifact.parent_upload_id))) {
      ctx.addIssue({ code: 'custom', path: ['artifacts', index, 'parent_upload_id'], message: ARTIFACT_INTAKE_ERROR.INVALID_MANIFEST })
    }
    if (artifact.primary) primaryCount += 1
    ids.add(artifact.upload_id)
  }

  if (sourceCount > 1 || primaryCount !== 1) {
    ctx.addIssue({ code: 'custom', path: ['artifacts'], message: ARTIFACT_INTAKE_ERROR.INVALID_MANIFEST })
  }

  const derivatives = new Set(
    value.artifacts.filter((artifact) => artifact.role === 'derivative').map((artifact) => artifact.upload_id),
  )
  for (const declaredId of value.declared_derivative_upload_ids) {
    if (!derivatives.has(declaredId)) {
      ctx.addIssue({
        code: 'custom',
        path: ['declared_derivative_upload_ids'],
        message: ARTIFACT_INTAKE_ERROR.MISSING_DECLARED_DERIVATIVE,
      })
    }
  }
  for (const derivativeId of derivatives) {
    if (!value.declared_derivative_upload_ids.includes(derivativeId)) {
      ctx.addIssue({
        code: 'custom',
        path: ['declared_derivative_upload_ids'],
        message: ARTIFACT_INTAKE_ERROR.MISSING_DECLARED_DERIVATIVE,
      })
    }
  }
})

export const CHATGPT_ARTIFACT_FILE_TOOL_CONTRACT = Object.freeze({
  name: 'capture_artifact_file',
  title: 'Capture attached file',
  description: 'Use this only when a directly attached ChatGPT file is in scope. Read the attachment first, then provide a model-generated searchable extraction. Do not copy the temporary URL, file ID, or file name into other fields.',
  inputSchema: {
    type: 'object',
    properties: {
      file: {
        type: 'object',
        properties: {
          download_url: { type: 'string' },
          file_id: { type: 'string' },
          mime_type: { type: 'string' },
          file_name: { type: 'string' },
        },
        required: ['download_url', 'file_id'],
        additionalProperties: false,
      },
      searchable_content: { type: 'string' },
      title: { type: 'string' },
      scope: { type: 'string' },
      model_runtime: { type: 'string' },
    },
    required: ['file', 'searchable_content'],
    additionalProperties: false,
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    openWorldHint: false,
  },
  _meta: {
    'openai/fileParams': ['file'],
    ui: { visibility: ['model', 'app'] },
    'openai/widgetAccessible': true,
  },
} as const)
