import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { ArtifactManifestEntry } from '../types/artifact-intake'
import { ARTIFACT_MAX_BYTES } from '../services/artifact-intake/config'
import {
  ArtifactIntakeContractError,
  ARTIFACT_INTAKE_ERROR,
} from '../services/artifact-intake/contracts'
import { finalizeArtifactCapture } from '../services/artifact-intake/finalize'
import {
  getArtifactIntakeStatus,
  reserveArtifactUpload,
} from '../services/artifact-intake/operations'
import {
  artifactIntakeStatusToolSchema,
  artifactStatusAnnotations,
  artifactWriteAnnotations,
  finalizeArtifactCaptureToolSchema,
  reserveArtifactUploadToolSchema,
  type ArtifactIntakeToolContext,
} from './artifact-intake-tool-contracts'
import {
  artifactProvenanceReceipt,
  artifactToolErrorCode,
  artifactToolText,
  requireArtifactToolContext,
} from './artifact-intake-tool-support'
import { registerChatGptArtifactTool } from './artifact-intake-chatgpt'

export * from './artifact-intake-tool-contracts'

export function registerArtifactIntakeTools(server: McpServer, ctx: ArtifactIntakeToolContext): void {
  server.tool(
    'reserve_artifact_upload',
    'Reserve a tenant-scoped managed artifact upload without sending file bytes through MCP',
    reserveArtifactUploadToolSchema.shape,
    artifactWriteAnnotations,
    async (input) => {
      try {
        const typed = reserveArtifactUploadToolSchema.parse(input)
        const identity = requireArtifactToolContext(ctx)
        const receipt = await reserveArtifactUpload({
          tenantId: identity.tenantId,
          idempotencyKey: typed.idempotency_key,
          byteLength: typed.byte_length,
          plaintextSha256: typed.plaintext_sha256,
          declaredMimeType: typed.declared_mime_type,
        }, ctx.getEnv())
        return artifactToolText({
          ...receipt,
          ...(await artifactProvenanceReceipt(identity.tenantId, identity.clientName, identity.agentIdentity)),
          upload_path: `/api/artifacts/${receipt.uploadId}/content`,
          max_bytes: ARTIFACT_MAX_BYTES,
        })
      } catch (error) {
        return artifactToolText({ status: 'failed', error_code: artifactToolErrorCode(error) }, true)
      }
    },
  )

  registerChatGptArtifactTool(server, ctx)

  server.tool(
    'finalize_artifact_capture',
    'Finalize searchable extraction and an exact source/derivative artifact manifest',
    finalizeArtifactCaptureToolSchema.shape,
    artifactWriteAnnotations,
    async (input) => {
      try {
        const typed = finalizeArtifactCaptureToolSchema.parse(input)
        if (typed.expected_artifact_count !== typed.artifacts.length) {
          throw new ArtifactIntakeContractError(ARTIFACT_INTAKE_ERROR.MISSING_DECLARED_DERIVATIVE)
        }
        const identity = requireArtifactToolContext(ctx)
        const artifacts: ArtifactManifestEntry[] = typed.artifacts.map(artifact => ({
          uploadId: artifact.upload_id,
          role: artifact.role,
          parentUploadId: artifact.parent_upload_id,
          primary: artifact.primary,
          declaredMimeType: artifact.declared_mime_type,
          detectedMimeType: artifact.detected_mime_type,
          byteLength: artifact.byte_length,
          plaintextSha256: artifact.plaintext_sha256,
        }))
        const receipt = await finalizeArtifactCapture({
          tenantId: identity.tenantId,
          content: typed.searchable_content,
          title: typed.title,
          scope: typed.scope,
          provenance: typed.provenance,
          clientName: identity.clientName,
          agentIdentity: identity.agentIdentity,
          modelRuntime: typed.model_runtime,
          sourceRef: typed.source_ref,
          idempotencyKey: typed.idempotency_key,
          artifacts,
          declaredDerivativeUploadIds: typed.declared_derivative_upload_ids,
        }, identity.tmk, ctx.getEnv())
        return artifactToolText({
          ...receipt,
          ...(await artifactProvenanceReceipt(identity.tenantId, identity.clientName, identity.agentIdentity)),
        })
      } catch (error) {
        return artifactToolText({ status: 'failed', error_code: artifactToolErrorCode(error) }, true)
      }
    },
  )

  server.tool(
    'artifact_intake_status',
    'Read a content-free managed artifact intake receipt',
    artifactIntakeStatusToolSchema.shape,
    artifactStatusAnnotations,
    async (input) => {
      try {
        const typed = artifactIntakeStatusToolSchema.parse(input)
        const identity = requireArtifactToolContext(ctx)
        const receipt = await getArtifactIntakeStatus({
          tenantId: identity.tenantId,
          uploadId: typed.upload_id,
        }, ctx.getEnv())
        return artifactToolText({
          ...receipt,
          ...(await artifactProvenanceReceipt(identity.tenantId, identity.clientName, identity.agentIdentity)),
        })
      } catch (error) {
        return artifactToolText({ status: 'failed', error_code: artifactToolErrorCode(error) }, true)
      }
    },
  )
}
