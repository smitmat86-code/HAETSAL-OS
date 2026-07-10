// Durable human approval + cancellation delay for irreversible actions.
// Workflow state contains identifiers only; action content remains TMK/KEK-
// sealed in R2 and is decrypted only inside the execution step.

import { WorkflowEntrypoint, WorkflowStep, WorkflowEvent } from 'cloudflare:workers'
import type { Env } from '../types/env'
import { deriveTmk } from '../middleware/auth'
import { executeApprovedAction } from '../services/action/approved-execution'

export interface ActionApprovalParams {
  actionId: string
  tenantId: string
}

interface ApprovalDecision {
  approved: boolean
  jwtSub: string
  sendDelaySeconds: number
}

export class ActionApprovalWorkflow extends WorkflowEntrypoint<Env, ActionApprovalParams> {
  async run(event: WorkflowEvent<ActionApprovalParams>, step: WorkflowStep) {
    const decision = await step.waitForEvent<ApprovalDecision>('wait-for-human-approval', {
      type: 'approval-response',
      timeout: '7 days',
    })
    if (!decision.payload.approved) return { status: 'rejected' }

    const delayMs = Math.max(0, decision.payload.sendDelaySeconds) * 1000
    if (delayMs > 0) await step.sleep('irreversible-action-cancel-window', delayMs)

    await step.do('execute-approved-action', {
      retries: { limit: 0, delay: '1 second', backoff: 'constant' },
      timeout: '2 minutes',
      sensitive: 'output',
    }, async () => {
      const tmk = await deriveTmk(decision.payload.jwtSub, this.env.CF_ACCESS_AUD)
      await executeApprovedAction(
        event.payload.actionId,
        event.payload.tenantId,
        tmk,
        this.env,
        this.ctx,
      )
    })
    return { status: 'completed' }
  }
}
