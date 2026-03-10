// src/services/bootstrap/hindsight-config.ts
// 2.4a addendum: Hindsight bank config, mental models, webhook registration
// Called by BootstrapWorkflow.completeBootstrap() via step.do()

import type { Env } from '../../types/env'

const DOMAINS = [
  { id: 'career', name: 'Career & Professional',
    query: 'Key patterns, goals, current challenges, and trajectory in career and professional life? Include: role, ambitions, key relationships, recurring themes, significant decisions.' },
  { id: 'health', name: 'Health & Wellness',
    query: 'Health habits, fitness patterns, wellness commitments, and physical/mental health context? Include: routines, goals, challenges, trajectory.' },
  { id: 'relationships', name: 'Relationships & Social',
    query: 'Most important people in this person\'s life, nature of those relationships? Include: family, friends, mentors, key professional contacts. Focus on quality and dynamics.' },
  { id: 'learning', name: 'Learning & Growth',
    query: 'What is this person actively learning, curious about, or developing? Include: formal learning, self-directed study, intellectual interests, skills being built.' },
  { id: 'finance', name: 'Financial',
    query: 'Financial goals, constraints, significant decisions, and overall trajectory? Focus on goals and patterns — not specific account details.' },
  { id: 'general', name: 'General & Cross-Domain',
    query: 'Overarching themes, values, and priorities that cut across all areas of this person\'s life? Include: core values, life philosophy, recurring tensions, what they optimize for.' },
] as const

/** Step 1: Configure bank observations_mission + retain_mission */
export async function configureHindsightBank(
  bankId: string, env: Env,
): Promise<void> {
  const res = await env.HINDSIGHT.fetch(
    `http://hindsight/v1/default/banks/${bankId}`,
    {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        retain_mission: `Focus on: career decisions and professional milestones, health patterns and habits, relationship dynamics, learning and growth moments, financial decisions, faith and values. Deprioritize: logistics, scheduling details, generic pleasantries, one-off administrative tasks.`,
        observations_mission: `Synthesize durable facts about professional trajectory, key relationships, recurring behavioral tendencies, and domain expertise. Observations should be stable claims accurate in 6 months. Ignore one-off events. Focus on patterns and durable facts.`,
        enable_observations: true,
      }),
    },
  )
  if (!res.ok) throw new Error(`Bank config failed: ${res.status}`)
}

/** Step 2: Create 6 mental models (one per domain), idempotent via 409 */
export async function createMentalModels(
  bankId: string, env: Env,
): Promise<void> {
  const results = await Promise.allSettled(
    DOMAINS.map(domain =>
      env.HINDSIGHT.fetch(
        `http://hindsight/v1/default/banks/${bankId}/mental-models`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            id: `mental-model-${domain.id}`,
            name: domain.name,
            source_query: domain.query,
            tags: [`domain:${domain.id}`],
            max_tokens: 2048,
            trigger: { refresh_after_consolidation: true },
          }),
        },
      ).then(res => {
        if (!res.ok && res.status !== 409) throw new Error(`Mental model ${domain.id}: ${res.status}`)
      }),
    ),
  )
  const failures = results.filter(r => r.status === 'rejected')
  if (failures.length > 0) {
    console.error(`Mental model creation: ${failures.length}/${DOMAINS.length} failed`, failures)
  }
}

/** Step 3: Register consolidation.completed webhook, idempotent */
export async function registerConsolidationWebhook(
  bankId: string, env: Env,
): Promise<void> {
  const listRes = await env.HINDSIGHT.fetch(
    `http://hindsight/v1/default/banks/${bankId}/webhooks`,
  )
  if (listRes.ok) {
    const { items } = await listRes.json() as { items: Array<{ url: string; enabled: boolean }> }
    if (items?.some(w => w.url.includes('/hindsight/webhook') && w.enabled)) return
  }
  const res = await env.HINDSIGHT.fetch(
    `http://hindsight/v1/default/banks/${bankId}/webhooks`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: `https://${env.WORKER_DOMAIN}/hindsight/webhook`,
        secret: env.HINDSIGHT_WEBHOOK_SECRET,
        event_types: ['consolidation.completed'],
        enabled: true,
      }),
    },
  )
  if (!res.ok) throw new Error(`Webhook registration failed: ${res.status}`)
}

/** Exported DOMAINS for test verification of stable IDs */
export const MENTAL_MODEL_DOMAINS = DOMAINS.map(d => d.id)
