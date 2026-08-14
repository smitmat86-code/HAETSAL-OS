import { beforeAll, describe, expect, it } from 'vitest'
import { env, SELF } from 'cloudflare:test'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { deriveTenantId, deriveTmk } from '../src/middleware/auth'
import { resolveAccessPrincipal, resolveDelegatedClientIdentity } from '../src/middleware/cf-access'
import { sha256Bytes } from '../src/services/artifact-intake/crypto'
import {
  getArtifactIntakeOperation,
  reserveArtifactUpload,
  uploadArtifactBytes,
} from '../src/services/artifact-intake/operations'
import { registerArtifactIntakeTools } from '../src/tools/artifact-intake'
import { artifactContent } from '../src/workers/mcpagent/routes/artifact-content'
import { installCfAccessMock } from './support/cf-access'

const SUITE_ID = crypto.randomUUID()
const AUDIENCE = 'test-aud-brain-access'
const HUMAN_SUBJECT = `session-3-human-${SUITE_ID}`
const OTHER_SUBJECT = `session-3-other-${SUITE_ID}`
let humanTenant = ''
let otherTenant = ''

type ToolResponse = { isError?: boolean; content: Array<{ text: string }> }
type ToolHandler = (input: unknown) => Promise<ToolResponse>

async function ensureTenant(tenantId: string): Promise<void> {
  const now = Date.now()
  await env.D1_US.prepare(
    `INSERT OR IGNORE INTO tenants
     (id, created_at, updated_at, data_region, primary_channel, hindsight_tenant_id, ai_cost_reset_at)
     VALUES (?, ?, ?, 'us', 'sms', ?, ?)`,
  ).bind(tenantId, now, now, `hindsight-${tenantId}`, now).run()
}

function registry(tmk: CryptoKey | null, identity = {
  clientName: 'Codex', agentIdentity: 'codex-local',
}) {
  const handlers = new Map<string, ToolHandler>()
  const annotations = new Map<string, Record<string, boolean>>()
  const server = {
    tool(
      name: string,
      _description: string,
      _shape: object,
      hints: Record<string, boolean>,
      handler: ToolHandler,
    ) {
      annotations.set(name, hints)
      handlers.set(name, handler)
    },
  } as unknown as McpServer
  registerArtifactIntakeTools(server, {
    getEnv: () => env,
    getTenantId: () => humanTenant,
    getTmk: () => tmk,
    getClientIdentity: () => identity,
  })
  return { handlers, annotations }
}

async function callTool(reg: ReturnType<typeof registry>, name: string, input: unknown) {
  const response = await reg.handlers.get(name)!(input)
  return { response, body: JSON.parse(response.content[0]!.text) as Record<string, unknown> }
}

async function reserveText(idempotencyKey: string, body: string) {
  const bytes = new TextEncoder().encode(body)
  const plaintextSha256 = await sha256Bytes(bytes)
  const reserved = await reserveArtifactUpload({
    tenantId: humanTenant,
    idempotencyKey,
    byteLength: bytes.byteLength,
    plaintextSha256,
    declaredMimeType: 'text/plain',
  }, env)
  return { bytes, plaintextSha256, reserved }
}

beforeAll(async () => {
  humanTenant = await deriveTenantId(HUMAN_SUBJECT, AUDIENCE)
  otherTenant = await deriveTenantId(OTHER_SUBJECT, AUDIENCE)
  await Promise.all([ensureTenant(humanTenant), ensureTenant(otherTenant)])
})

describe('12.6 Session 3 MCP and local binary transport', () => {
  it('registers the three annotated tools without caller-controlled tenant input', () => {
    const reg = registry(null)
    expect([...reg.handlers.keys()]).toEqual([
      'reserve_artifact_upload',
      'finalize_artifact_capture',
      'artifact_intake_status',
    ])
    expect(reg.annotations.get('reserve_artifact_upload')).toEqual({
      readOnlyHint: false, destructiveHint: false, openWorldHint: false,
    })
    expect(reg.annotations.get('artifact_intake_status')?.readOnlyHint).toBe(true)
  })

  it('fails closed before reservation when the TMK or delegated client identity is unavailable', async () => {
    const missingKey = await callTool(registry(null), 'reserve_artifact_upload', {
      idempotency_key: `missing-key-${SUITE_ID}`,
      byte_length: 10,
      plaintext_sha256: 'a'.repeat(64),
      declared_mime_type: 'text/plain',
    })
    expect(missingKey.response.isError).toBe(true)
    expect(missingKey.body).toEqual({ status: 'failed', error_code: 'encryption_key_unavailable' })

    const missingIdentity = await callTool(registry(await deriveTmk(HUMAN_SUBJECT, AUDIENCE), {
      clientName: null, agentIdentity: null,
    }), 'reserve_artifact_upload', {
      idempotency_key: `missing-identity-${SUITE_ID}`,
      byte_length: 10,
      plaintext_sha256: 'a'.repeat(64),
      declared_mime_type: 'text/plain',
    })
    expect(missingIdentity.body).toEqual({ status: 'failed', error_code: 'client_identity_unavailable' })
  })

  it('binds distinct delegated client provenance to one human tenant', () => {
    const delegation = JSON.stringify({
      'codex-client.access': HUMAN_SUBJECT,
      'claude-client.access': HUMAN_SUBJECT,
    })
    const identities = JSON.stringify({
      'codex-client.access': { client_name: 'Codex', agent_identity: 'codex-local' },
      'claude-client.access': { client_name: 'Claude Code', agent_identity: 'claude-code-local' },
    })
    const codexPayload = { sub: '', type: 'app', common_name: 'codex-client.access' }
    const claudePayload = { sub: '', type: 'app', common_name: 'claude-client.access' }
    expect(resolveAccessPrincipal(codexPayload, delegation).tenantPrincipalId)
      .toBe(resolveAccessPrincipal(claudePayload, delegation).tenantPrincipalId)
    expect(resolveDelegatedClientIdentity(codexPayload, identities)).toEqual({
      clientName: 'Codex', agentIdentity: 'codex-local',
    })
    expect(resolveDelegatedClientIdentity(claudePayload, identities)).toEqual({
      clientName: 'Claude Code', agentIdentity: 'claude-code-local',
    })
  })

  it('uploads exact bytes once, stores only TMK ciphertext, and makes PUT retry idempotent', async () => {
    const marker = `session-3-route-marker-${SUITE_ID}`
    const pending = await reserveText(`route-idempotent-${SUITE_ID}`, marker)
    const auth = await installCfAccessMock(HUMAN_SUBJECT)
    try {
      const request = () => SELF.fetch(`http://localhost/api/artifacts/${pending.reserved.uploadId}/content`, {
        method: 'PUT',
        headers: {
          'CF-Access-Jwt-Assertion': auth.jwt,
          'Content-Type': 'text/plain',
          'Content-Length': String(pending.bytes.byteLength),
        },
        body: pending.bytes,
      })
      const first = await request()
      expect(first.status).toBe(200)
      const firstReceipt = await first.json() as { status: string; ciphertextSha256: string }
      expect(firstReceipt.status).toBe('sealed')
      const second = await request()
      expect(second.status).toBe(200)
      const secondReceipt = await second.json() as { ciphertextSha256: string }
      expect(secondReceipt.ciphertextSha256).toBe(firstReceipt.ciphertextSha256)

      const operation = await getArtifactIntakeOperation(env, humanTenant, pending.reserved.uploadId)
      const object = await env.R2_ARTIFACTS.get(operation!.r2_key)
      const ciphertext = new TextDecoder().decode(await object!.arrayBuffer())
      expect(ciphertext.startsWith('TMK1:')).toBe(true)
      expect(ciphertext).not.toContain(marker)
    } finally {
      auth.restore()
    }
  })

  it('makes foreign and absent uploads indistinguishable and content-free', async () => {
    const pending = await reserveText(`foreign-route-${SUITE_ID}`, `private-${SUITE_ID}`)
    const auth = await installCfAccessMock(OTHER_SUBJECT)
    try {
      const response = await SELF.fetch(`http://localhost/api/artifacts/${pending.reserved.uploadId}/content`, {
        method: 'PUT',
        headers: {
          'CF-Access-Jwt-Assertion': auth.jwt,
          'Content-Type': 'text/plain',
        },
        body: pending.bytes,
      })
      expect(response.status).toBe(404)
      expect(await response.json()).toEqual({ status: 'failed', error_code: 'not_found' })
    } finally {
      auth.restore()
    }
  })

  it('rejects missing key configuration and oversize bodies at the upload boundary', async () => {
    const uploadId = crypto.randomUUID()
    const noKey = await artifactContent.request(`/${uploadId}/content`, {
      method: 'PUT', body: 'private-body', headers: { 'Content-Type': 'text/plain' },
    }, { ...env, CF_ACCESS_AUD: '' })
    expect(noKey.status).toBe(503)
    expect(await noKey.json()).toEqual({ status: 'failed', error_code: 'encryption_key_unavailable' })

    const pending = await reserveText(`oversize-route-${SUITE_ID}`, 'x')
    const auth = await installCfAccessMock(HUMAN_SUBJECT)
    try {
      const oversize = await SELF.fetch(`http://localhost/api/artifacts/${pending.reserved.uploadId}/content`, {
        method: 'PUT', body: 'x', headers: {
          'CF-Access-Jwt-Assertion': auth.jwt,
          'Content-Type': 'text/plain',
          'Content-Length': String(25 * 1024 * 1024 + 1),
        },
      })
      expect(oversize.status).toBe(413)
      expect(await oversize.json()).toEqual({ status: 'failed', error_code: 'bulk_import_required' })
    } finally {
      auth.restore()
    }
  })

  it('refuses finalization when an intentional derivative is omitted from the expected manifest', async () => {
    const key = await deriveTmk(HUMAN_SUBJECT, AUDIENCE)
    const source = await reserveText(`tool-source-${SUITE_ID}`, 'source bytes')
    const derivative = await reserveText(`tool-derivative-${SUITE_ID}`, 'derivative bytes')
    for (const entry of [source, derivative]) {
      await uploadArtifactBytes({
        tenantId: humanTenant,
        uploadId: entry.reserved.uploadId,
        bytes: entry.bytes,
        detectedMimeType: 'text/plain',
        declaredMimeType: 'text/plain',
        encryptionFamily: 'tmk',
        key,
      }, env)
    }
    const finalized = await callTool(registry(key), 'finalize_artifact_capture', {
      searchable_content: 'safe searchable extraction',
      scope: 'research',
      idempotency_key: `tool-finalize-${SUITE_ID}`,
      expected_artifact_count: 2,
      declared_derivative_upload_ids: [derivative.reserved.uploadId],
      artifacts: [{
        upload_id: source.reserved.uploadId,
        role: 'source',
        primary: true,
        detected_mime_type: 'text/plain',
        byte_length: source.bytes.byteLength,
        plaintext_sha256: source.plaintextSha256,
      }],
    })
    expect(finalized.response.isError).toBe(true)
    expect(finalized.body).toEqual({ status: 'failed', error_code: 'missing_declared_derivative' })
  })
})
