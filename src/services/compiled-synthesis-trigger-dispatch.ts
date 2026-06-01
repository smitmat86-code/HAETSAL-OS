import type { Env } from '../types/env'
import { compileProjectSynthesisFromCanonicalTruth } from './compiled-synthesis-compile'
import type {
  DispatchTargetedCompiledRefreshResult,
  PlannedCompiledRefresh,
} from './compiled-synthesis-trigger-types'

interface DispatchTargetedCompiledRefreshOptions {
  tmk: CryptoKey | null
  compileProject?: typeof compileProjectSynthesisFromCanonicalTruth
}

export async function dispatchTargetedCompiledRefresh(
  plan: PlannedCompiledRefresh,
  env: Env,
  options: DispatchTargetedCompiledRefreshOptions,
): Promise<DispatchTargetedCompiledRefreshResult> {
  const result: DispatchTargetedCompiledRefreshResult = {
    plan,
    dispatched: [],
    skipped: [],
    failed: [],
  }
  const compileProject = options.compileProject ?? compileProjectSynthesisFromCanonicalTruth

  const jobs = await Promise.allSettled(plan.dispatchJobs.map(async (job) => {
    if (job.jobKind === 'project_compilation') {
      if (!options.tmk) {
        result.skipped.push({
          jobKind: job.jobKind,
          subjectStableKey: job.subject.stableKey,
          targetStableKeys: job.targetStableKeys,
          reason: 'TMK unavailable, so targeted project compilation could not read canonical source bodies.',
        })
        return
      }
      const compiled = await compileProject({
        tenantId: plan.event.tenantId,
        subject: job.subject,
        tmk: options.tmk,
      }, env)
      result.dispatched.push({
        jobKind: job.jobKind,
        subjectStableKey: job.subject.stableKey,
        targetStableKeys: job.targetStableKeys,
        sourceFingerprint: compiled.sourceFingerprint,
        sourceCount: compiled.sourceCount,
      })
    }
  }))

  jobs.forEach((jobResult, index) => {
    if (jobResult.status === 'fulfilled') return
    const job = plan.dispatchJobs[index]
    result.failed.push({
      jobKind: job.jobKind,
      subjectStableKey: job.subject.stableKey,
      targetStableKeys: job.targetStableKeys,
      error: jobResult.reason instanceof Error ? jobResult.reason.message : String(jobResult.reason),
    })
  })

  return result
}
