// src/services/bootstrap/interview.ts
// Chief of Staff interview — domain-by-domain question flow
// Answers retained as memory_type: 'semantic', provenance: 'user_authored', salience_tier: 3
// State persisted in McpAgentDO SQLite (survives session drops)
// LESSON: InterviewSession is serializable for DO storage

import type { Env } from '../../types/env'
import type { InterviewState } from '../../types/bootstrap'
import { INTERVIEW_DOMAINS } from '../../types/bootstrap'
import { retainContent } from '../ingestion/retain'

export function createInitialState(): InterviewState {
  return { domainIndex: 0, questionIndex: 0, answers: [] }
}

export function currentQuestion(state: InterviewState): string | null {
  const domain = INTERVIEW_DOMAINS[state.domainIndex]
  if (!domain) return null
  return domain.questions[state.questionIndex] ?? null
}

export function currentDomain(state: InterviewState): string | null {
  return INTERVIEW_DOMAINS[state.domainIndex]?.domain ?? null
}

export function totalQuestions(): number {
  return INTERVIEW_DOMAINS.reduce((sum, d) => sum + d.questions.length, 0)
}

export function answeredCount(state: InterviewState): number {
  return state.answers.length
}

export async function recordAnswer(
  state: InterviewState,
  answer: string,
  tenantId: string,
  tmk: CryptoKey,
  env: Env,
): Promise<{ nextQuestion: string | null; complete: boolean; state: InterviewState }> {
  const domain = INTERVIEW_DOMAINS[state.domainIndex]
  if (!domain) return { nextQuestion: null, complete: true, state }

  const question = domain.questions[state.questionIndex]
  const newAnswers = [...state.answers, { domain: domain.domain, question, answer }]

  // Retain answer as semantic memory — highest trust (user_authored)
  await retainContent(
    {
      tenantId,
      source: 'mcp_retain',
      content: `Q: ${question}\nA: ${answer}`,
      occurredAt: Date.now(),
      memoryType: 'semantic',
      domain: domain.domain,
      provenance: 'user_authored',
      metadata: { bootstrap_interview: 'true', salience_override: 3 },
    },
    tmk,
    env,
  )

  // Advance question pointer
  let newDomainIdx = state.domainIndex
  let newQuestionIdx = state.questionIndex + 1
  if (newQuestionIdx >= domain.questions.length) {
    newDomainIdx++
    newQuestionIdx = 0
  }

  const newState: InterviewState = {
    domainIndex: newDomainIdx,
    questionIndex: newQuestionIdx,
    answers: newAnswers,
  }

  const nextQ = currentQuestion(newState)
  return { nextQuestion: nextQ, complete: nextQ === null, state: newState }
}
