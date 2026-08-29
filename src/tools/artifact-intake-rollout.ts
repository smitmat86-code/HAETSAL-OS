import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import {
  IMMUTABLE_ROLLOUT_CATEGORY,
} from '../services/artifact-intake/immutable-rollout-digest'
import {
  immutableRolloutStatus,
  repairImmutableArtifactRollout,
} from '../services/artifact-intake/immutable-rollout'
import type { ArtifactIntakeToolContext } from './artifact-intake-tool-contracts'
import {
  artifactToolErrorCode,
  artifactToolText,
  requireArtifactToolContext,
} from './artifact-intake-tool-support'

const repairSchema = z.object({
  category: z.literal(IMMUTABLE_ROLLOUT_CATEGORY),
  expected_target_count: z.number().int().positive().max(100),
  approval_digest: z.string().regex(/^[a-f0-9]{64}$/),
})

const readAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
}

const repairAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
}

export function registerArtifactIntakeRolloutTools(
  server: McpServer,
  ctx: ArtifactIntakeToolContext,
): void {
  server.tool(
    'artifact_immutable_rollout_status',
    'Read the content-free exact-target digest and completion status for the one-time immutable rollout',
    {},
    readAnnotations,
    async () => {
      try {
        const identity = requireArtifactToolContext(ctx)
        return artifactToolText(await immutableRolloutStatus(identity.tenantId, ctx.getEnv()))
      } catch (error) {
        return artifactToolText({ status: 'failed', error_code: artifactToolErrorCode(error) }, true)
      }
    },
  )

  server.tool(
    'repair_artifact_immutable_rollout',
    'Execute only an explicitly approved exact-target immutable promotion; original R2 objects are retained',
    repairSchema.shape,
    repairAnnotations,
    async input => {
      try {
        const typed = repairSchema.parse(input)
        const identity = requireArtifactToolContext(ctx)
        return artifactToolText(await repairImmutableArtifactRollout({
          tenantId: identity.tenantId,
          category: typed.category,
          expectedTargetCount: typed.expected_target_count,
          approvalDigest: typed.approval_digest,
          tmk: identity.tmk,
        }, ctx.getEnv()))
      } catch (error) {
        return artifactToolText({ status: 'failed', error_code: artifactToolErrorCode(error) }, true)
      }
    },
  )
}
