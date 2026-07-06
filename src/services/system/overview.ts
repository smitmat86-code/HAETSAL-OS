// src/services/system/overview.ts
// Phase 14: one JSON view of the machine — agents, live prompts (resolved
// override-or-default), models, tool scopes, cron schedule, task toggles,
// action preferences. Introspection of system CONFIG, not tenant content;
// prompt text crosses the wire only to the authenticated dashboard.

import type { Env } from '../../types/env'
import { MODEL_CHAT, MODEL_DEEP, MODEL_EMBEDDING, MODEL_VISION } from '../../config/models'
import { PROFILE_TOOLS } from '../../agents/execution/types'
import { SYSTEM_PROMPT_REGISTRY } from '../prompts/registry'
import { resolveSystemPrompt } from '../prompts/overrides'
import { activeOverrideMeta } from '../prompts/override-history'
import { listTaskStates } from './tasks'
import { readTenantSettings } from '../action/preferences'

const AGENTS = [
  { key: 'interaction', title: 'Interaction agent (your session DO)', model: MODEL_CHAT, promptKeys: ['persona.chat', 'persona.grounded_reply'], notes: 'Chat replies, tool registry host, spawn/cancel/retry parent' },
  { key: 'execution', title: 'Execution sub-agent (spawned facets)', model: MODEL_DEEP, promptKeys: ['agent.execution_preamble'], notes: 'Profiles scope tools per spawn; 15-min budget, 5-min stuck reaper' },
  { key: 'dream', title: 'Dream cycle (nightly workflow)', model: MODEL_DEEP, promptKeys: ['dream.extract'], notes: 'Report-only proposals into the review inbox' },
  { key: 'career_coach', title: 'Career Coach persona', model: MODEL_DEEP, promptKeys: ['persona.career_coach'], notes: 'DORMANT — not instantiated' },
  { key: 'chief_of_staff', title: 'Chief of Staff persona', model: MODEL_DEEP, promptKeys: ['persona.chief_of_staff'], notes: 'DORMANT — not instantiated' },
]

const ACT_TOOLS = [
  { tool: 'brain_v1_act_search', capabilityClass: 'READ', gate: 'GREEN floor — immediate' },
  { tool: 'brain_v1_act_browse', capabilityClass: 'READ', gate: 'GREEN floor — immediate' },
  { tool: 'brain_v1_act_draft', capabilityClass: 'WRITE_INTERNAL', gate: 'GREEN floor — immediate' },
  { tool: 'brain_v1_act_remind', capabilityClass: 'WRITE_INTERNAL', gate: 'GREEN floor — immediate' },
  { tool: 'brain_v1_act_create_event', capabilityClass: 'WRITE_EXTERNAL_REVERSIBLE', gate: 'YELLOW floor — approval' },
  { tool: 'brain_v1_act_modify_event', capabilityClass: 'WRITE_EXTERNAL_REVERSIBLE', gate: 'YELLOW floor — approval' },
  { tool: 'brain_v1_act_send_message', capabilityClass: 'WRITE_EXTERNAL_IRREVERSIBLE', gate: 'YELLOW floor — approval + 120s delay' },
  { tool: 'brain_v1_act_run_playbook', capabilityClass: 'WRITE_EXTERNAL_IRREVERSIBLE', gate: 'YELLOW floor — approval + 120s delay' },
]

const CRONS = [
  { schedule: 'Every 1 min', job: 'Obsidian /to-brain/ folder poll' },
  { schedule: 'Every 15 min', job: 'Obsidian vault scan (brain: true); hourly canary sweep on the :00 tick' },
  { schedule: 'Every 30 min (8am–8pm)', job: 'Predictive heartbeat' },
  { schedule: 'Daily 2:00 am', job: 'Dream cycle + decay pass' },
  { schedule: 'Daily 7:00 am', job: 'Morning brief' },
  { schedule: 'Friday 5:00 pm', job: 'Weekly synthesis (dormant no-op)' },
]

export async function buildSystemOverview(env: Env, tenantId: string): Promise<Record<string, unknown>> {
  const prompts = await Promise.all(SYSTEM_PROMPT_REGISTRY.map(async (entry) => {
    const [resolved, active] = await Promise.all([
      // No vars: placeholders like {channel} display verbatim in the editor.
      resolveSystemPrompt(env, tenantId, entry.key),
      entry.editable ? activeOverrideMeta(env, tenantId, entry.key) : Promise.resolve(null),
    ])
    return {
      key: entry.key, title: entry.title, usedBy: entry.usedBy,
      editable: entry.editable, dormant: entry.dormant ?? false, vars: entry.vars ?? [],
      source: resolved.source, text: resolved.text, active,
    }
  }))
  const [tasks, preferences] = await Promise.all([
    listTaskStates(env, tenantId),
    readTenantSettings(tenantId, env).catch(() => null),
  ])
  return {
    agents: AGENTS,
    prompts,
    models: { chat: MODEL_CHAT, vision: MODEL_VISION, deep: MODEL_DEEP, embedding: MODEL_EMBEDDING },
    profiles: PROFILE_TOOLS,
    actTools: ACT_TOOLS,
    crons: CRONS,
    tasks,
    preferences,
  }
}
