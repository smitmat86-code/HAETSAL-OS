// Mission Phase 10: compiled pages — person/project/topic kinds ride the
// existing compiler, pages re-render from PERSISTED canonical views with
// frontmatter (ids, source count, freshness, review status), registry
// list/rebuild/delete lifecycle, rebuild overwrites.

import { beforeAll, describe, expect, it } from 'vitest'
import { env } from 'cloudflare:test'
import {
  deleteCompiledPage, listCompiledPages, rebuildCompiledPage, renderCompiledPage,
} from '../src/services/compiled/page'
import { readCompiledDossier } from '../src/services/compiled-synthesis-read'
import { installCanonicalMemoryTestStore } from '../src/services/canonical-postgres'
import { installCanonicalGovernanceTestStore } from '../src/services/canonical-governance-memory'
import { installCompiledSynthesisTestStore } from '../src/services/compiled-synthesis-postgres'
import { retainContent } from '../src/services/ingestion/retain'
import type { Env } from '../src/types/env'

const SUITE = crypto.randomUUID()
const TENANT = `test-tenant-mission-100-${SUITE}`
installCanonicalMemoryTestStore(env as unknown as Env)
installCanonicalGovernanceTestStore(env as unknown as Env)
installCompiledSynthesisTestStore(env as unknown as Env)

async function testTmk(): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(`m100-${SUITE}`), { name: 'HKDF' }, false, ['deriveKey'])
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: new TextEncoder().encode('m100'), info: new TextEncoder().encode('m100') },
    material, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
}

beforeAll(async () => {
  const now = Date.now()
  await env.D1_US.prepare(
    `INSERT OR IGNORE INTO tenants
     (id, created_at, updated_at, data_region, primary_channel, hindsight_tenant_id, ai_cost_reset_at)
     VALUES (?, ?, ?, 'us', 'sms', ?, ?)`,
  ).bind(TENANT, now, now, `hindsight-${TENANT}`, now).run()
  const tmk = await testTmk()
  // Seed canonical truth the compiler selects from.
  await retainContent({
    tenantId: TENANT, content: `Alice leads the HAETSAL project roadmap and prefers async updates. ${SUITE}`,
    source: 'telegram', memoryType: 'episodic', domain: 'general', occurredAt: now - 1000,
  }, tmk, env as unknown as Env)
  await retainContent({
    tenantId: TENANT, content: `HAETSAL project: sub-agent orchestration shipped; dashboard is next. ${SUITE}`,
    source: 'telegram', memoryType: 'episodic', domain: 'general', occurredAt: now - 500,
  }, tmk, env as unknown as Env)
})

describe('mission 10.0 — compiled pages', () => {
  it('builds person/project/topic pages, kind threads to the dossier record', async () => {
    const tmk = await testTmk()
    const person = await rebuildCompiledPage(env as unknown as Env, tmk, TENANT,
      { kind: 'person', key: 'alice', name: 'Alice', keywords: ['alice'] })
    const project = await rebuildCompiledPage(env as unknown as Env, tmk, TENANT,
      { kind: 'project', key: 'haetsal', name: 'HAETSAL', keywords: ['haetsal', 'project'] })
    const topic = await rebuildCompiledPage(env as unknown as Env, tmk, TENANT,
      { kind: 'topic', key: 'roadmap', name: 'Roadmap', keywords: ['roadmap'] })
    expect(person.stableKey).toBe('person:alice')
    expect(project.stableKey).toBe('project:haetsal')
    expect(topic.stableKey).toBe('topic:roadmap')
    const dossier = await readCompiledDossier(TENANT, 'dossier:project:person-alice', env as unknown as Env)
    expect(dossier?.dossier.subjectType).toBe('person')
    expect(dossier?.dossier.dossierKind).toBe('person_dossier')
  })

  it('same slug under different kinds compiles to distinct documents', async () => {
    const tmk = await testTmk()
    await rebuildCompiledPage(env as unknown as Env, tmk, TENANT,
      { kind: 'project', key: 'alice', name: 'Project Alice', keywords: ['alice'] })
    const personDoc = await readCompiledDossier(TENANT, 'dossier:project:person-alice', env as unknown as Env)
    const projectDoc = await readCompiledDossier(TENANT, 'dossier:project:project-alice', env as unknown as Env)
    expect(personDoc?.dossier.subjectType).toBe('person')
    expect(projectDoc?.dossier.subjectType).toBe('project')
    expect(personDoc?.document.id).not.toBe(projectDoc?.document.id)
  })

  it('renders markdown with the mission frontmatter fields', async () => {
    const markdown = await renderCompiledPage(env as unknown as Env, TENANT, 'project', 'haetsal')
    expect(markdown).not.toBeNull()
    expect(markdown!).toMatch(/^---\n/)
    for (const field of ['title:', 'kind: project', 'stable_key: project:haetsal',
      'compiled_document_id:', 'source_count:', 'freshness:', 'review_status:', 'regenerable: true']) {
      expect(markdown!).toContain(field)
    }
    expect(markdown!).toContain('# HAETSAL')
  })

  it('lists pages, delete deregisters, rebuild restores (regenerable)', async () => {
    const tmk = await testTmk()
    const before = await listCompiledPages(env as unknown as Env, TENANT)
    expect(before.length).toBeGreaterThanOrEqual(3)
    expect(await deleteCompiledPage(env as unknown as Env, TENANT, 'topic', 'roadmap')).toBe(true)
    const after = await listCompiledPages(env as unknown as Env, TENANT)
    expect(after.find(p => p.stableKey === 'topic:roadmap')).toBeUndefined()
    const rebuilt = await rebuildCompiledPage(env as unknown as Env, tmk, TENANT,
      { kind: 'topic', key: 'roadmap', name: 'Roadmap', keywords: ['roadmap'] })
    expect(rebuilt.stableKey).toBe('topic:roadmap')
    expect((await listCompiledPages(env as unknown as Env, TENANT)).find(p => p.stableKey === 'topic:roadmap')).toBeDefined()
  })

  it('unknown pages 404 honestly (null)', async () => {
    expect(await renderCompiledPage(env as unknown as Env, TENANT, 'person', 'nobody')).toBeNull()
  })
})
