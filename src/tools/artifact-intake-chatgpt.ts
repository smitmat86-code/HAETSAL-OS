import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { ArtifactIntakeContractError, ARTIFACT_INTAKE_ERROR } from '../services/artifact-intake/contracts'
import { sha256Bytes, sha256Text } from '../services/artifact-intake/crypto'
import { downloadHostedArtifactFile } from '../services/artifact-intake/download'
import { finalizeArtifactCapture } from '../services/artifact-intake/finalize'
import { reserveArtifactUpload, uploadArtifactBytes } from '../services/artifact-intake/operations'
import { CHATGPT_ARTIFACT_FILE_TOOL_CONTRACT } from '../services/artifact-intake/schemas'
import {
  artifactWriteAnnotations,
  captureArtifactFileToolSchema,
  type ArtifactIntakeToolContext,
} from './artifact-intake-tool-contracts'
import {
  artifactProvenanceReceipt,
  artifactToolErrorCode,
  artifactToolText,
  requireArtifactToolContext,
} from './artifact-intake-tool-support'

export function registerChatGptArtifactTool(server: McpServer, ctx: ArtifactIntakeToolContext): void {
  const handler = async (input: unknown) => {
    try {
      if (
        !input
        || typeof input !== 'object'
        || !('file' in input)
        || typeof input.file !== 'object'
        || input.file === null
        || Array.isArray(input.file)
      ) {
        throw new ArtifactIntakeContractError(ARTIFACT_INTAKE_ERROR.RAW_BYTES_UNAVAILABLE)
      }
      const typed = captureArtifactFileToolSchema.parse(input)
      const identity = requireArtifactToolContext(ctx)
      const downloaded = await (ctx.downloadHostedFile ?? downloadHostedArtifactFile)(typed.file)
      const plaintextSha256 = await sha256Bytes(downloaded.bytes)
      const privateFileBinding = await sha256Text(
        `chatgpt-hosted-file-v1\u0000${identity.tenantId}\u0000${typed.file.file_id}`,
      )
      const reserved = await reserveArtifactUpload({
        tenantId: identity.tenantId,
        idempotencyKey: `chatgpt-upload-${privateFileBinding}`,
        byteLength: downloaded.bytes.byteLength,
        plaintextSha256,
        declaredMimeType: downloaded.declaredMimeType,
      }, ctx.getEnv())
      await uploadArtifactBytes({
        tenantId: identity.tenantId,
        uploadId: reserved.uploadId,
        bytes: downloaded.bytes,
        detectedMimeType: downloaded.detectedMimeType,
        declaredMimeType: downloaded.declaredMimeType,
        encryptionFamily: 'tmk',
        key: identity.tmk,
      }, ctx.getEnv())
      const receipt = await finalizeArtifactCapture({
        tenantId: identity.tenantId,
        content: typed.searchable_content,
        title: typed.title,
        scope: typed.scope,
        provenance: 'chatgpt_hosted_attachment',
        clientName: identity.clientName,
        agentIdentity: identity.agentIdentity,
        modelRuntime: typed.model_runtime,
        idempotencyKey: `chatgpt-capture-${privateFileBinding}`,
        artifacts: [{
          uploadId: reserved.uploadId,
          role: 'source',
          primary: true,
          detectedMimeType: downloaded.detectedMimeType,
          declaredMimeType: downloaded.declaredMimeType,
          byteLength: downloaded.bytes.byteLength,
          plaintextSha256,
        }],
        declaredDerivativeUploadIds: [],
      }, identity.tmk, ctx.getEnv())
      return artifactToolText({
        ...receipt,
        ...(await artifactProvenanceReceipt(identity.tenantId, identity.clientName, identity.agentIdentity)),
      })
    } catch (error) {
      return artifactToolText({ status: 'failed', error_code: artifactToolErrorCode(error) }, true)
    }
  }

  server.registerTool(
    CHATGPT_ARTIFACT_FILE_TOOL_CONTRACT.name,
    {
      title: CHATGPT_ARTIFACT_FILE_TOOL_CONTRACT.title,
      description: CHATGPT_ARTIFACT_FILE_TOOL_CONTRACT.description,
      inputSchema: captureArtifactFileToolSchema,
      annotations: artifactWriteAnnotations,
      _meta: CHATGPT_ARTIFACT_FILE_TOOL_CONTRACT._meta,
    },
    handler,
  )

  server.registerTool(
    'capture_artifact_file_from_widget',
    {
      title: 'Complete attached file capture',
      description: 'Private MCP App continuation for an already prepared ChatGPT attachment capture.',
      inputSchema: captureArtifactFileToolSchema,
      annotations: artifactWriteAnnotations,
      _meta: {
        ui: { visibility: ['app'] },
        'openai/visibility': 'private',
      },
    },
    handler,
  )
}
