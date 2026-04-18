import type { Env } from '../../types/env'
import {
  createMentalModel,
  createWebhook,
  listMentalModels,
  listWebhooks,
  updateBankConfiguration,
  updateMentalModel,
} from '../hindsight'
import { resolveHindsightBankId } from '../hindsight-transport'
import {
  buildHindsightBankProvisioningSpec,
  computeHindsightConfigVersion,
  MENTAL_MODEL_DOMAINS,
} from './hindsight-bank-spec'

export { MENTAL_MODEL_DOMAINS } from './hindsight-bank-spec'

export async function configureHindsightBank(
  bankRef: string,
  env: Env,
  bankConfig = defaultSpec(env).bankConfig,
): Promise<void> {
  const res = await updateBankConfiguration(bankRef, bankConfig, env)
  if (!res.ok) throw new Error(`Bank config failed: ${res.status}`)
}

export async function createMentalModels(
  bankRef: string,
  env: Env,
  models = defaultSpec(env).mentalModels,
): Promise<void> {
  const list = await listMentalModels(bankRef, env).catch(() => ({ items: [] }))
  const items = Array.isArray(list.items) ? list.items : []
  const existing = new Set(items.map((item) => item.id))
  const results = await Promise.allSettled(models.map(async (model) => {
    const res = existing.has(String(model.id))
      ? await updateMentalModel(bankRef, String(model.id), model, env)
      : await createMentalModel(bankRef, model, env)
    if (!res.ok && res.status !== 409) throw new Error(`Mental model ${model.id}: ${res.status}`)
  }))
  const failures = results.filter((result) => result.status === 'rejected')
  if (failures.length > 0) console.error('Mental model creation failures', failures)
}

export async function registerConsolidationWebhook(
  bankRef: string,
  env: Env,
  webhook = defaultSpec(env).webhook,
): Promise<void> {
  const hooks = await listWebhooks(bankRef, env).catch(() => ({ items: [] }))
  const items = Array.isArray(hooks.items) ? hooks.items : []
  if (items.some((item) => item.url === webhook.url && item.enabled)) return
  const res = await createWebhook(bankRef, webhook, env)
  if (!res.ok) throw new Error(`Webhook registration failed: ${res.status}`)
}

export async function ensureHindsightBankConfigured(
  bankRef: string,
  tenantId: string,
  env: Env,
): Promise<void> {
  const bankId = await resolveHindsightBankId(bankRef, env)
  const spec = defaultSpec(env)
  const configVersion = computeHindsightConfigVersion(spec)
  const existing = await env.D1_US.prepare(
    'SELECT config_version FROM hindsight_bank_config WHERE bank_id = ?',
  ).bind(bankId).first<{ config_version: string | null }>()
  if (existing?.config_version === configVersion) return

  await configureHindsightBank(bankId, env, spec.bankConfig)
  await createMentalModels(bankId, env, spec.mentalModels)
  await registerConsolidationWebhook(bankId, env, spec.webhook)

  const now = Date.now()
  await env.D1_US.prepare(
    `INSERT INTO hindsight_bank_config
       (bank_id, tenant_id, config_version, config_json, mental_model_count, webhook_url, applied_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(bank_id) DO UPDATE SET
       tenant_id = excluded.tenant_id,
       config_version = excluded.config_version,
       config_json = excluded.config_json,
       mental_model_count = excluded.mental_model_count,
       webhook_url = excluded.webhook_url,
       applied_at = excluded.applied_at,
       updated_at = excluded.updated_at`,
  ).bind(
    bankId,
    tenantId,
    configVersion,
    JSON.stringify(spec),
    spec.mentalModels.length,
    spec.webhook.url,
    now,
    now,
  ).run()
}

function defaultSpec(env: Env) {
  return buildHindsightBankProvisioningSpec(
    env.WORKER_DOMAIN || 'the-brain.workers.dev',
    env.HINDSIGHT_WEBHOOK_SECRET || '',
  )
}
