// src/tools/bootstrap.ts
// MCP tool registration for bootstrap onboarding
// brain_v1_bootstrap_start — idempotent Workflow creation
// brain_v1_bootstrap_interview_next — interview Q&A with retain

import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { Env } from '../types/env'
import type { InterviewState } from '../types/bootstrap'
import {
  createInitialState, currentQuestion, currentDomain,
  recordAnswer, totalQuestions, answeredCount,
} from '../services/bootstrap/interview'

interface BootstrapContext {
  getEnv: () => Env
  getTenantId: () => string
  getTmk: () => CryptoKey | null
  getInterviewState: () => InterviewState | null
  setInterviewState: (s: InterviewState) => void
}

export function registerBootstrapTools(server: McpServer, ctx: BootstrapContext) {
  server.tool('brain_v1_bootstrap_start', 'Start bootstrap onboarding',
    { skip_interview: z.boolean().optional() },
    async (input) => {
      const env = ctx.getEnv()
      const tenantId = ctx.getTenantId()
      const row = await env.D1_US.prepare(
        'SELECT bootstrap_status, bootstrap_workflow_id FROM tenants WHERE id = ?',
      ).bind(tenantId).first<{ bootstrap_status: string; bootstrap_workflow_id: string | null }>()

      if (row && row.bootstrap_status !== 'not_started') {
        return { content: [{ type: 'text' as const, text: JSON.stringify({
          status: row.bootstrap_status, workflow_id: row.bootstrap_workflow_id,
          message: 'Bootstrap already started',
        }) }] }
      }

      const instance = await env.BOOTSTRAP_WORKFLOW.create({
        params: { tenantId, skipInterview: !!(input as { skip_interview?: boolean }).skip_interview },
      })

      const now = Date.now()
      await env.D1_US.batch([
        env.D1_US.prepare(
          "UPDATE tenants SET bootstrap_status = 'interview_in_progress', bootstrap_workflow_id = ?, updated_at = ? WHERE id = ?",
        ).bind(instance.id, now, tenantId),
        env.D1_US.prepare(
          `INSERT INTO memory_audit (id, tenant_id, created_at, operation, memory_type, domain, provenance, salience_tier)
           VALUES (?, ?, ?, 'bootstrap.started', 'semantic', 'general', 'system', 1)`,
        ).bind(crypto.randomUUID(), tenantId, now),
      ])

      const interviewState = createInitialState()
      ctx.setInterviewState(interviewState)

      return { content: [{ type: 'text' as const, text: JSON.stringify({
        status: 'interview_in_progress', workflow_id: instance.id,
        first_question: currentQuestion(interviewState),
        domain: currentDomain(interviewState),
        total_questions: totalQuestions(),
      }) }] }
    })

  server.tool('brain_v1_bootstrap_interview_next', 'Answer a bootstrap interview question',
    { answer: z.string().min(1) },
    async (input) => {
      const env = ctx.getEnv()
      const tenantId = ctx.getTenantId()
      const tmk = ctx.getTmk()
      let state = ctx.getInterviewState()

      if (!state) state = createInitialState()
      if (!tmk) {
        return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'TMK not available' }) }] }
      }

      const answer = (input as { answer: string }).answer
      const result = await recordAnswer(state, answer, tenantId, tmk, env)
      ctx.setInterviewState(result.state)

      if (result.complete) {
        const now = Date.now()
        await env.D1_US.batch([
          env.D1_US.prepare(
            "UPDATE tenants SET bootstrap_status = 'interview_complete', interview_completed_at = ?, updated_at = ? WHERE id = ?",
          ).bind(now, now, tenantId),
          env.D1_US.prepare(
            `INSERT INTO memory_audit (id, tenant_id, created_at, operation, memory_type, domain, provenance, salience_tier)
             VALUES (?, ?, ?, 'bootstrap.interview_complete', 'semantic', 'general', 'system', 1)`,
          ).bind(crypto.randomUUID(), tenantId, now),
        ])
      }

      return { content: [{ type: 'text' as const, text: JSON.stringify({
        complete: result.complete,
        next_question: result.nextQuestion,
        domain: result.complete ? null : currentDomain(result.state),
        progress: `${answeredCount(result.state)}/${totalQuestions()}`,
      }) }] }
    })
}
