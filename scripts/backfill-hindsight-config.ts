// scripts/backfill-hindsight-config.ts
// Run: npx tsx scripts/backfill-hindsight-config.ts
// 2.4a addendum: applies Hindsight bank config, mental models, and webhook
// to an already-bootstrapped tenant. Safe to re-run — all operations idempotent.
// Required .dev.vars: HINDSIGHT_URL, HINDSIGHT_BANK_ID, HINDSIGHT_WEBHOOK_SECRET, WORKER_DOMAIN

import { readFileSync, existsSync } from 'fs'
// Parse .dev.vars if present (KEY=VALUE lines, no dotenv dependency)
if (existsSync('.dev.vars')) {
  const vars = Object.fromEntries(
    readFileSync('.dev.vars', 'utf-8').split('\n')
      .map(l => l.trim()).filter(l => l && !l.startsWith('#'))
      .map(l => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1)] }),
  )
  Object.assign(process.env, vars)
}

const HINDSIGHT_URL = process.env.HINDSIGHT_URL!
const BANK_ID = process.env.HINDSIGHT_BANK_ID!
const WEBHOOK_SECRET = process.env.HINDSIGHT_WEBHOOK_SECRET!
const WORKER_DOMAIN = process.env.WORKER_DOMAIN!

async function hindsight(path: string, opts?: RequestInit): Promise<Response> {
  const res = await fetch(`${HINDSIGHT_URL}${path}`, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...(opts?.headers ?? {}) },
  })
  if (!res.ok && res.status !== 409) {
    const body = await res.text()
    throw new Error(`Hindsight ${path} → ${res.status}: ${body}`)
  }
  return res
}

const DOMAINS = [
  { id: 'career', query: 'Key patterns, goals, challenges, trajectory in career and professional life?' },
  { id: 'health', query: 'Health habits, fitness patterns, wellness commitments, trajectory?' },
  { id: 'relationships', query: 'Most important people, relationship quality, social dynamics?' },
  { id: 'learning', query: 'Active learning, intellectual interests, skills being built?' },
  { id: 'finance', query: 'Financial goals, constraints, significant decisions, trajectory?' },
  { id: 'general', query: 'Overarching themes, values, priorities, what this person optimizes for?' },
]

async function main() {
  if (!HINDSIGHT_URL || !BANK_ID || !WEBHOOK_SECRET || !WORKER_DOMAIN) {
    console.error('Missing required .dev.vars: HINDSIGHT_URL, HINDSIGHT_BANK_ID, HINDSIGHT_WEBHOOK_SECRET, WORKER_DOMAIN')
    process.exit(1)
  }

  console.log('Step 1: Configuring bank (observations_mission + retain_mission)...')
  await hindsight(`/v1/default/banks/${BANK_ID}`, {
    method: 'PUT',
    body: JSON.stringify({
      retain_mission: `Focus on: career decisions and professional milestones, health patterns and habits, relationship dynamics, learning and growth moments, financial decisions, faith and values. Deprioritize: logistics, scheduling details, generic pleasantries, one-off administrative tasks.`,
      observations_mission: `Synthesize durable facts about professional trajectory, key relationships, recurring behavioral tendencies, and domain expertise. Observations should be stable claims accurate in 6 months. Ignore one-off events. Focus on patterns and durable facts.`,
      enable_observations: true,
    }),
  })
  console.log('  ✓ Bank configured')

  console.log('Step 2: Creating mental models (6 domains)...')
  for (const d of DOMAINS) {
    await hindsight(`/v1/default/banks/${BANK_ID}/mental-models`, {
      method: 'POST',
      body: JSON.stringify({
        id: `mental-model-${d.id}`, name: `${d.id.charAt(0).toUpperCase() + d.id.slice(1)} Mental Model`,
        source_query: d.query, tags: [`domain:${d.id}`], max_tokens: 2048,
        trigger: { refresh_after_consolidation: true },
      }),
    })
    console.log(`  ✓ mental-model-${d.id}`)
  }

  console.log('Step 3: Registering consolidation webhook...')
  const listRes = await hindsight(`/v1/default/banks/${BANK_ID}/webhooks`)
  const { items } = await listRes.json() as { items: Array<{ url: string; enabled: boolean }> }
  if (items?.some(w => w.url.includes('/hindsight/webhook') && w.enabled)) {
    console.log('  ✓ Webhook already registered (skipped)')
  } else {
    await hindsight(`/v1/default/banks/${BANK_ID}/webhooks`, {
      method: 'POST',
      body: JSON.stringify({
        url: `https://${WORKER_DOMAIN}/hindsight/webhook`,
        secret: WEBHOOK_SECRET, event_types: ['consolidation.completed'], enabled: true,
      }),
    })
    console.log('  ✓ Webhook registered')
  }

  console.log('\n✅ 2.4a backfill complete.')
  console.log('   - Hindsight will extract domain-relevant facts on next retain')
  console.log('   - Mental models will auto-refresh after next consolidation')
  console.log('   - Webhook will trigger 3.3 passes on consolidation.completed')
}

main().catch(e => { console.error('❌ Backfill failed:', e); process.exit(1) })
