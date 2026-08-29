import type { Env } from '../../types/env'
import type { ChannelMediaJob } from '../../types/channel-media'
import { ArtifactIntakeContractError, ARTIFACT_INTAKE_ERROR } from '../artifact-intake/contracts'
import { recoverFinalizedChannelMediaJob } from './canonical-recovery'
import { channelMediaRetrySeconds } from './claim-outcome'
import { cleanupChannelMediaHandoff, type ChannelMediaDeliver } from './delivery'
import { getChannelMediaJob } from './jobs'
import { markChannelMediaFailed, markChannelMediaIntegrityIncident } from './job-transitions'
import {
  handleTerminalChannelMediaJob,
  type ChannelMediaProcessResult,
} from './orchestrator-support'

export type ChannelMediaRecoveryGate =
  | { status: 'continue'; job: ChannelMediaJob }
  | { status: 'result'; result: ChannelMediaProcessResult }

export async function resolveChannelMediaRecovery(args: {
  job: ChannelMediaJob
  leaseToken?: string
  kek: CryptoKey
  env: Env
  deliver: ChannelMediaDeliver
}): Promise<ChannelMediaRecoveryGate> {
  const recovery = await recoverFinalizedChannelMediaJob(args.job, args.env)
  if (recovery.status === 'in_progress') {
    return {
      status: 'result',
      result: {
        status: 'deferred', reason: 'recovery_in_progress',
        retryAfterSeconds: args.job.leaseExpiresAt
          ? Math.min(recovery.retryAfterSeconds, channelMediaRetrySeconds(args.job.leaseExpiresAt))
          : recovery.retryAfterSeconds,
      },
    }
  }
  const job = recovery.status === 'recovered'
    ? await getChannelMediaJob(args.job.tenantId, args.job.id, args.env)
    : args.job
  if (!job) throw new ArtifactIntakeContractError(ARTIFACT_INTAKE_ERROR.NOT_FOUND)

  if (recovery.status === 'inconsistent' && recovery.protectedFinalizedHistory) {
    await markChannelMediaIntegrityIncident(job.tenantId, job.id, args.env)
    return { status: 'result', result: 'processed' }
  }

  if (job.status === 'finalized' || job.status === 'failed') {
    if (recovery.status === 'inconsistent') {
      // Artifact integrity failed after the job's capture outcome was
      // recorded, and no provider call is in doubt here (delivery is still
      // pending). Record the incident separately; never rewrite capture or
      // delivery truth into delivery_unknown.
      await markChannelMediaIntegrityIncident(job.tenantId, job.id, args.env)
      await cleanupChannelMediaHandoff(job, args.env)
      return { status: 'result', result: 'processed' }
    }
    return {
      status: 'result',
      result: await handleTerminalChannelMediaJob({
        job, kek: args.kek, env: args.env, deliver: args.deliver,
      }),
    }
  }
  if (recovery.status === 'failed' || recovery.status === 'inconsistent') {
    if (!args.leaseToken) throw new ArtifactIntakeContractError(ARTIFACT_INTAKE_ERROR.LEASE_LOST)
    try {
      await markChannelMediaFailed(
        job.tenantId, job.id, args.leaseToken, recovery.errorCode, args.env,
      )
    } catch (error) {
      if (!(error instanceof ArtifactIntakeContractError) || error.code !== ARTIFACT_INTAKE_ERROR.LEASE_LOST) {
        throw error
      }
      return {
        status: 'result',
        result: { status: 'deferred', reason: 'recovery_in_progress', retryAfterSeconds: 1 },
      }
    }
    const failed = await getChannelMediaJob(job.tenantId, job.id, args.env)
    return {
      status: 'result',
      result: failed
        ? await handleTerminalChannelMediaJob({
          job: failed, kek: args.kek, env: args.env, deliver: args.deliver,
        })
        : 'terminal_failed',
    }
  }
  return { status: 'continue', job }
}
