// src/services/prompts/registry.ts
// Phase 14: single source of truth for system prompts. Editable entries can
// be overridden per-tenant from the dashboard (sealed, versioned — see
// overrides.ts); read-only entries are surfaced for introspection. Defaults
// live HERE so the call sites and the System panel can never drift.

import { DREAM_EXTRACT_PROMPT } from '../dream/extract'
import { WRITE_POLICY_CLASSIFIER_PROMPT } from '../ingestion/write-policy'

export interface SystemPromptEntry {
  key: string
  title: string
  usedBy: string
  editable: boolean
  /** Placeholders (e.g. {channel}) substituted at use time; overrides may use them too. */
  vars?: string[]
  defaultText: string
  dormant?: boolean
}

export const PERSONA_CHAT_DEFAULT =
  'You are Haetsal (해살), a warm and capable personal AI assistant. You communicate via {channel}. '
  + 'Keep responses concise and conversational — this is a chat, not email. Be helpful, natural, '
  + 'and brief. If asked to do something you can\'t do yet, be honest about it.'

export const GROUNDED_REPLY_DEFAULT =
  'You are Haetsal, a warm and capable personal AI assistant reached over {channel}. Keep replies '
  + 'concise and conversational. Ground answers in the provided memories when relevant; if a needed '
  + 'source (like Gmail or calendar) is not connected yet, say so honestly.'

export const EXECUTION_PREAMBLE_DEFAULT =
  'You are a focused execution agent for HAETSAL, the user\'s personal brain. Complete the task '
  + 'using the available tools, then give a final plain-text answer.'

export const SYSTEM_PROMPT_REGISTRY: SystemPromptEntry[] = [
  {
    key: 'persona.chat',
    title: 'Chat persona',
    usedBy: 'Quick channel replies (Telegram/SMS) without memory grounding',
    editable: true,
    vars: ['channel'],
    defaultText: PERSONA_CHAT_DEFAULT,
  },
  {
    key: 'persona.grounded_reply',
    title: 'Grounded reply persona',
    usedBy: 'Memory-grounded channel replies (retrieved memories + session context are appended by code)',
    editable: true,
    vars: ['channel'],
    defaultText: GROUNDED_REPLY_DEFAULT,
  },
  {
    key: 'agent.execution_preamble',
    title: 'Sub-agent preamble',
    usedBy: 'Spawned execution agents (tool rules and task framing are appended by code)',
    editable: true,
    defaultText: EXECUTION_PREAMBLE_DEFAULT,
  },
  {
    key: 'dream.extract',
    title: 'Dream extraction pass',
    usedBy: 'Nightly consolidation (STRICT JSON contract — read-only to protect the parser)',
    editable: false,
    defaultText: DREAM_EXTRACT_PROMPT,
  },
  {
    key: 'ingestion.write_policy',
    title: 'Write-policy classifier',
    usedBy: 'Memory-type classification on capture (fixed two-word contract — read-only)',
    editable: false,
    defaultText: WRITE_POLICY_CLASSIFIER_PROMPT,
  },
  {
    key: 'persona.career_coach',
    title: 'Career Coach (dormant)',
    usedBy: 'Not currently instantiated; prompt is built at session open from live context',
    editable: false,
    dormant: true,
    defaultText: '(dynamic — see src/agents/career-coach.ts systemPrompt())',
  },
  {
    key: 'persona.chief_of_staff',
    title: 'Chief of Staff (dormant)',
    usedBy: 'Not currently instantiated; prompt is built at session open from live context',
    editable: false,
    dormant: true,
    defaultText: '(dynamic — see src/agents/chief-of-staff.ts systemPrompt())',
  },
]

export function promptEntry(key: string): SystemPromptEntry | undefined {
  return SYSTEM_PROMPT_REGISTRY.find((e) => e.key === key)
}

export function substitutePromptVars(text: string, vars?: Record<string, string>): string {
  if (!vars) return text
  let out = text
  for (const [name, value] of Object.entries(vars)) out = out.replaceAll(`{${name}}`, value)
  return out
}
