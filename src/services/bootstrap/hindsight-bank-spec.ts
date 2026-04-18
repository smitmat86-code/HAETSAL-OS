import { createHash } from 'node:crypto'

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

export interface HindsightBankProvisioningSpec {
  bankConfig: Record<string, unknown>
  mentalModels: Array<Record<string, unknown>>
  webhook: {
    url: string
    secret: string
    event_types: string[]
    enabled: boolean
  }
}

export function buildHindsightBankProvisioningSpec(
  workerDomain: string,
  webhookSecret: string,
): HindsightBankProvisioningSpec {
  return {
    bankConfig: {
      retain_mission: `Focus on: career decisions and professional milestones, health patterns and habits, relationship dynamics, learning and growth moments, financial decisions, faith and values. Deprioritize: logistics, scheduling details, generic pleasantries, one-off administrative tasks.`,
      observations_mission: `Synthesize durable facts about professional trajectory, key relationships, recurring behavioral tendencies, and domain expertise. Observations should be stable claims accurate in 6 months. Ignore one-off events. Focus on patterns and durable facts.`,
      enable_observations: true,
    },
    mentalModels: DOMAINS.map((domain) => ({
      id: `mental-model-${domain.id}`,
      name: domain.name,
      source_query: domain.query,
      tags: [`domain:${domain.id}`],
      max_tokens: 2048,
      trigger: { refresh_after_consolidation: true },
    })),
    webhook: {
      url: `https://${workerDomain}/hindsight/webhook`,
      secret: webhookSecret,
      event_types: ['consolidation.completed'],
      enabled: true,
    },
  }
}

export function computeHindsightConfigVersion(spec: HindsightBankProvisioningSpec): string {
  const canonical = JSON.stringify(sortKeys(spec))
  return createHash('sha256').update(canonical).digest('hex')
}

export const MENTAL_MODEL_DOMAINS = DOMAINS.map((domain) => domain.id)

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, sortKeys(nested)]),
    )
  }
  return value
}
