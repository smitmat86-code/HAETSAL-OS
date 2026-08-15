import { beforeAll, describe, expect, it, vi } from 'vitest'
import { env } from 'cloudflare:test'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { deriveTmk } from '../src/middleware/auth'
import {
  downloadHostedArtifactFile,
  type ArtifactDownloadLimits,
  type ArtifactDownloadNetwork,
  type ArtifactDownloadResponse,
} from '../src/services/artifact-intake/download'
import { getArtifactIntakeOperation } from '../src/services/artifact-intake/operations'
import { getCanonicalDocument, searchCanonicalMemory } from '../src/services/canonical-memory-query'
import { getCanonicalMemoryStore } from '../src/services/canonical-postgres'
import { registerArtifactIntakeTools } from '../src/tools/artifact-intake'
import {
  CHATGPT_ARTIFACT_CAPTURE_UI_HTML,
  CHATGPT_ARTIFACT_CAPTURE_UI_URI,
} from '../src/tools/artifact-intake-chatgpt-ui'

const SUITE_ID = crypto.randomUUID()
const TENANT = `session-4-chatgpt-${SUITE_ID}`
const SUBJECT = `session-4-human-${SUITE_ID}`
const AUDIENCE = 'test-aud-brain-access'
const LIMITS: ArtifactDownloadLimits = { maxBytes: 64, timeoutMs: 25, maxRedirects: 2 }

type ToolResponse = { isError?: boolean; content: Array<{ text: string }>; structuredContent?: unknown }
type ToolHandler = (input: unknown) => Promise<ToolResponse>

function stream(...chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk)
      controller.close()
    },
  })
}

function response(args: {
  status?: number
  headers?: Record<string, string>
  chunks?: Uint8Array[]
  remoteAddress?: string
  onCancel?: () => void
} = {}): ArtifactDownloadResponse {
  return {
    status: args.status ?? 200,
    headers: new Headers(args.headers),
    body: args.chunks ? stream(...args.chunks) : null,
    remoteAddress: args.remoteAddress ?? '93.184.216.34',
    cancel: args.onCancel ?? (() => undefined),
  }
}

function network(args: {
  resolutions?: string[][]
  responses?: ArtifactDownloadResponse[]
  request?: ArtifactDownloadNetwork['request']
}) {
  const resolutions = [...(args.resolutions ?? [['93.184.216.34']])]
  const responses = [...(args.responses ?? [])]
  const requests: Array<{ url: string; pinnedAddress: string }> = []
  let resolveIndex = 0
  const value: ArtifactDownloadNetwork = {
    resolve: vi.fn(async () => resolutions[Math.min(resolveIndex++, resolutions.length - 1)]!),
    request: vi.fn(async (url, pinnedAddress, signal) => {
      requests.push({ url: url.href, pinnedAddress })
      if (args.request) return args.request(url, pinnedAddress, signal)
      return responses.shift() ?? response()
    }),
  }
  return { value, requests }
}

function registry(args: {
  key: CryptoKey | null
  identity?: { clientName: string | null; agentIdentity: string | null }
  downloader?: Parameters<typeof registerArtifactIntakeTools>[1]['downloadHostedFile']
}) {
  const handlers = new Map<string, ToolHandler>()
  const configs = new Map<string, Record<string, unknown>>()
  const resources = new Map<string, { config: Record<string, unknown>; read: () => Promise<unknown> }>()
  const server = {
    tool(name: string, _description: string, _shape: object, _annotations: object, handler: ToolHandler) {
      handlers.set(name, handler)
    },
    registerTool(name: string, config: Record<string, unknown>, handler: ToolHandler) {
      configs.set(name, config)
      handlers.set(name, handler)
    },
    registerResource(name: string, _uri: string, config: Record<string, unknown>, read: () => Promise<unknown>) {
      resources.set(name, { config, read })
    },
  } as unknown as McpServer
  registerArtifactIntakeTools(server, {
    getEnv: () => env,
    getTenantId: () => TENANT,
    getTmk: () => args.key,
    getClientIdentity: () => args.identity ?? {
      clientName: 'ChatGPT', agentIdentity: 'chatgpt-developer-mode',
    },
    downloadHostedFile: args.downloader,
  })
  return { handlers, configs, resources }
}

async function call(reg: ReturnType<typeof registry>, input: unknown) {
  const result = await reg.handlers.get('capture_artifact_file')!(input)
  return { result, body: JSON.parse(result.content[0]!.text) as Record<string, unknown> }
}

beforeAll(async () => {
  const now = Date.now()
  await env.D1_US.prepare(
    `INSERT OR IGNORE INTO tenants
     (id, created_at, updated_at, data_region, primary_channel, hindsight_tenant_id, ai_cost_reset_at)
     VALUES (?, ?, ?, 'us', 'sms', ?, ?)`,
  ).bind(TENANT, now, now, `hindsight-${TENANT}`, now).run()
})

describe('12.7 Session 4 ChatGPT hosted attachment downloader', () => {
  it('registers the current official four-field file parameter descriptor', async () => {
    const reg = registry({ key: await deriveTmk(SUBJECT, AUDIENCE) })
    const config = reg.configs.get('capture_artifact_file') as {
      inputSchema: { shape: Record<string, { shape?: Record<string, unknown> }> }
      annotations: Record<string, boolean>
      _meta: Record<string, unknown>
    }
    expect(config._meta).toEqual({
      'openai/fileParams': ['file'],
      ui: { visibility: ['model', 'app'] },
      'openai/widgetAccessible': true,
    })
    expect(config.annotations).toEqual({
      readOnlyHint: false, destructiveHint: false, openWorldHint: false,
    })
    expect(Object.keys(config.inputSchema.shape.file!.shape!).sort()).toEqual([
      'download_url', 'file_id', 'file_name', 'mime_type',
    ])
  })

  it('registers a decoupled MCP Apps picker bridge without exposing selected file metadata', async () => {
    const reg = registry({ key: await deriveTmk(SUBJECT, AUDIENCE) })
    const config = reg.configs.get('prepare_artifact_file_capture') as {
      annotations: Record<string, boolean>
      _meta: Record<string, unknown>
    }
    expect(config.annotations).toEqual({
      readOnlyHint: false, destructiveHint: false, openWorldHint: false,
    })
    expect(config._meta).toMatchObject({
      ui: { resourceUri: CHATGPT_ARTIFACT_CAPTURE_UI_URI, visibility: ['model', 'app'] },
      'openai/outputTemplate': CHATGPT_ARTIFACT_CAPTURE_UI_URI,
      'openai/widgetAccessible': true,
      'openai/fileParams': ['file'],
    })

    const prepared = await reg.handlers.get('prepare_artifact_file_capture')!({
      searchable_content: 'model-produced extraction',
      title: 'Safe title',
      model_runtime: 'ChatGPT',
    })
    expect(prepared.structuredContent).toEqual({
      status: 'selection_required',
      searchable_content: 'model-produced extraction',
      title: 'Safe title',
      scope: 'general',
      model_runtime: 'ChatGPT',
    })
    expect(JSON.parse(prepared.content[0]!.text)).toEqual({ status: 'selection_required' })

    const resource = await reg.resources.get('haetsal-artifact-capture')!.read() as {
      contents: Array<Record<string, unknown>>
    }
    expect(resource.contents[0]).toMatchObject({
      uri: CHATGPT_ARTIFACT_CAPTURE_UI_URI,
      mimeType: 'text/html;profile=mcp-app',
      _meta: { ui: { prefersBorder: true, csp: { connectDomains: [], resourceDomains: [] } } },
    })
    expect(CHATGPT_ARTIFACT_CAPTURE_UI_HTML).toContain('openai.selectFiles()')
    expect(CHATGPT_ARTIFACT_CAPTURE_UI_HTML).toContain("request('tools/call'")
    expect(CHATGPT_ARTIFACT_CAPTURE_UI_HTML).toContain("openai.callTool('prepare_artifact_file_capture', args)")
    expect(CHATGPT_ARTIFACT_CAPTURE_UI_HTML).toContain("return 'host_tool_call_failed'")
    expect(CHATGPT_ARTIFACT_CAPTURE_UI_HTML).toContain('classifyHostError(error)')
    expect(CHATGPT_ARTIFACT_CAPTURE_UI_HTML).toContain('classifyHostError(requestError)')
    expect(CHATGPT_ARTIFACT_CAPTURE_UI_HTML).toContain("window.addEventListener('openai:set_globals'")
    expect(CHATGPT_ARTIFACT_CAPTURE_UI_HTML).toContain('candidates.find(candidate =>')
    expect(CHATGPT_ARTIFACT_CAPTURE_UI_HTML).toContain("allowed.has(value) ? value : 'capture_failed'")
    expect(CHATGPT_ARTIFACT_CAPTURE_UI_HTML).toContain("'download_timeout','download_unavailable'")
    expect(CHATGPT_ARTIFACT_CAPTURE_UI_HTML).not.toContain('fileName:')
    expect(CHATGPT_ARTIFACT_CAPTURE_UI_HTML).not.toContain('imageIds: [selected.fileId]')

  })

  it('revalidates each redirect and pins the connection-time public address', async () => {
    const pdf = new TextEncoder().encode('%PDF-1.7\nredirect proof')
    const net = network({
      resolutions: [['93.184.216.34'], ['93.184.216.34'], ['151.101.1.69'], ['151.101.1.69']],
      responses: [
        response({ status: 302, headers: { location: 'https://cdn.example.net/final' } }),
        response({ headers: { 'content-type': 'application/pdf' }, chunks: [pdf], remoteAddress: '151.101.1.69' }),
      ],
    })
    const downloaded = await downloadHostedArtifactFile({
      download_url: 'https://files.example.com/temporary', file_id: 'file_redirect', mime_type: 'application/pdf',
    }, net.value, LIMITS)
    expect(downloaded.detectedMimeType).toBe('application/pdf')
    expect(downloaded.redirectCount).toBe(1)
    expect(net.requests).toEqual([
      { url: 'https://files.example.com/temporary', pinnedAddress: '93.184.216.34' },
      { url: 'https://cdn.example.net/final', pinnedAddress: '151.101.1.69' },
    ])
    expect(net.value.resolve).toHaveBeenCalledTimes(4)
  })

  it('blocks private URLs, private DNS answers, and DNS rebinding before a request', async () => {
    const unused = network({ responses: [] })
    await expect(downloadHostedArtifactFile({
      download_url: 'https://127.0.0.1/private', file_id: 'file_private',
    }, unused.value, LIMITS)).rejects.toMatchObject({ code: 'ssrf_url_blocked' })
    expect(unused.value.request).not.toHaveBeenCalled()

    const rebind = network({ resolutions: [['93.184.216.34'], ['169.254.169.254']] })
    await expect(downloadHostedArtifactFile({
      download_url: 'https://files.example.com/rebind', file_id: 'file_rebind',
    }, rebind.value, LIMITS)).rejects.toMatchObject({ code: 'ssrf_url_blocked' })
    expect(rebind.value.request).not.toHaveBeenCalled()
  })

  it('aborts streaming oversize bodies and rejects declared/detected MIME mismatches', async () => {
    let cancelled = false
    const oversize = network({ responses: [response({
      chunks: [new Uint8Array(64), new Uint8Array(1)],
      onCancel: () => { cancelled = true },
    })] })
    await expect(downloadHostedArtifactFile({
      download_url: 'https://files.example.com/large', file_id: 'file_large',
    }, oversize.value, LIMITS)).rejects.toMatchObject({ code: 'bulk_import_required' })
    expect(cancelled).toBe(true)

    const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    const mismatch = network({ responses: [response({
      headers: { 'content-type': 'image/png' }, chunks: [png],
    })] })
    await expect(downloadHostedArtifactFile({
      download_url: 'https://files.example.com/image', file_id: 'file_mismatch', mime_type: 'image/jpeg',
    }, mismatch.value, LIMITS)).rejects.toMatchObject({ code: 'mime_mismatch' })
  })

  it('returns content-free failures for expired URLs and aborts timed-out requests', async () => {
    const expired = network({ responses: [response({ status: 410 })] })
    await expect(downloadHostedArtifactFile({
      download_url: 'https://files.example.com/expired', file_id: 'file_expired',
    }, expired.value, LIMITS)).rejects.toMatchObject({ code: 'raw_bytes_unavailable' })

    let sawAbort = false
    const stalled = network({ request: (_url, _address, signal) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => {
        sawAbort = true
        reject(new Error('aborted'))
      }, { once: true })
    }) })
    await expect(downloadHostedArtifactFile({
      download_url: 'https://files.example.com/stalled', file_id: 'file_timeout',
    }, stalled.value, LIMITS)).rejects.toMatchObject({ code: 'download_timeout' })
    expect(sawAbort).toBe(true)
  })
})

describe('12.7 Session 4 ChatGPT hosted attachment integration', () => {
  it('downloads, seals, finalizes, attributes, and searches image and PDF extractions without metadata leaks', async () => {
    const key = await deriveTmk(SUBJECT, AUDIENCE)
    const image = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])
    const pdf = new TextEncoder().encode('%PDF-1.7\nSession four text document')
    const downloads = new Map([
      ['file_image_private_id', { bytes: image, detectedMimeType: 'image/png', declaredMimeType: 'image/png', redirectCount: 0 }],
      ['file_pdf_private_id', { bytes: pdf, detectedMimeType: 'application/pdf', declaredMimeType: 'application/pdf', redirectCount: 0 }],
    ])
    const reg = registry({
      key,
      downloader: async descriptor => downloads.get(descriptor.file_id)!,
    })
    const queueCalls: unknown[] = []
    const logCalls: unknown[] = []
    const spies = [
      vi.spyOn(env.QUEUE_HIGH, 'send').mockImplementation(async (value: unknown) => { queueCalls.push(value) }),
      vi.spyOn(env.QUEUE_NORMAL, 'send').mockImplementation(async (value: unknown) => { queueCalls.push(value) }),
      vi.spyOn(env.QUEUE_BULK, 'send').mockImplementation(async (value: unknown) => { queueCalls.push(value) }),
      vi.spyOn(console, 'log').mockImplementation((...value) => { logCalls.push(value) }),
      vi.spyOn(console, 'warn').mockImplementation((...value) => { logCalls.push(value) }),
      vi.spyOn(console, 'error').mockImplementation((...value) => { logCalls.push(value) }),
    ]
    const cases = [
      {
        file: {
          download_url: 'https://files.example.com/secret-image-url', file_id: 'file_image_private_id',
          mime_type: 'image/png', file_name: 'private-image-name.png',
        },
        searchable_content: `vision extraction s4image${SUITE_ID} shows a blue governance seal`,
        title: 'Model-generated vision summary',
      },
      {
        file: {
          download_url: 'https://files.example.com/secret-pdf-url', file_id: 'file_pdf_private_id',
          mime_type: 'application/pdf', file_name: 'private-document-name.pdf',
        },
        searchable_content: `document extraction s4pdf${SUITE_ID} describes governed attachment intake`,
        title: 'Model-generated document summary',
      },
    ]
    try {
      for (const input of cases) {
        const result = await call(reg, { ...input, scope: 'research', model_runtime: 'chatgpt-live-test' })
        expect(result.result.isError).not.toBe(true)
        expect(result.body).toMatchObject({
          status: 'finalized', clientName: 'ChatGPT', agentIdentity: 'chatgpt-developer-mode',
          client_name: 'ChatGPT', agent_identity: 'chatgpt-developer-mode',
        })
        const artifacts = result.body.artifacts as Array<Record<string, unknown>>
        expect(artifacts).toHaveLength(1)
        expect(artifacts[0]).toMatchObject({ role: 'source', parentArtifactId: null, primary: true })

        const document = await getCanonicalDocument({
          tenantId: TENANT, documentId: String(result.body.documentId),
        }, env, TENANT, { tmk: key })
        expect(document.body).toBe(input.searchable_content)
        expect(document.sourceSystem).toBe('file')
        expect(document.sourceRef).toBeNull()
        expect(document.artifacts).toHaveLength(1)
        expect(document.artifacts[0]!.filename).toBeNull()

        const search = await searchCanonicalMemory({
          tenantId: TENANT, query: input.searchable_content.split(' ')[2]!, mode: 'raw', limit: 5,
        }, env, TENANT, { tmk: key })
        expect(search.items.some(item => item.captureId === result.body.captureId)).toBe(true)

        const uploadId = String(artifacts[0]!.uploadId)
        const operation = await getArtifactIntakeOperation(env, TENANT, uploadId)
        const stored = await env.R2_ARTIFACTS.get(operation!.r2_key)
        const ciphertext = new TextDecoder().decode(await stored!.arrayBuffer())
        expect(ciphertext.startsWith('TMK1:')).toBe(true)
        expect(ciphertext).not.toContain(input.searchable_content)
        const capture = await getCanonicalMemoryStore(env).getCapture(TENANT, String(result.body.captureId))
        expect(capture).toMatchObject({
          source_system: 'file', source_ref: null, agent_identity: 'chatgpt-developer-mode',
          provenance_note: 'chatgpt_hosted_attachment',
        })
      }

      const d1 = await env.D1_US.prepare(
        `SELECT * FROM artifact_intake_operations WHERE tenant_id = ?`,
      ).bind(TENANT).all<Record<string, unknown>>()
      const d1Finalizations = await env.D1_US.prepare(
        `SELECT * FROM artifact_intake_finalizations WHERE tenant_id = ?`,
      ).bind(TENANT).all<Record<string, unknown>>()
      const operational = JSON.stringify([d1.results, d1Finalizations.results, queueCalls, logCalls])
      for (const forbidden of [
        'secret-image-url', 'secret-pdf-url', 'file_image_private_id', 'file_pdf_private_id',
        'private-image-name.png', 'private-document-name.pdf', 'vision extraction', 'document extraction',
      ]) expect(operational).not.toContain(forbidden)
    } finally {
      for (const spy of spies) spy.mockRestore()
    }
  })

  it('fails closed for missing attachments, malformed descriptors, and unauthorized clients', async () => {
    const key = await deriveTmk(SUBJECT, AUDIENCE)
    const goodDownload = async () => ({
      bytes: new TextEncoder().encode('safe'), detectedMimeType: 'text/plain', declaredMimeType: 'text/plain', redirectCount: 0,
    })
    const authorized = registry({ key, downloader: goodDownload })
    expect((await call(authorized, { searchable_content: 'no attachment' })).body)
      .toEqual({ status: 'failed', error_code: 'raw_bytes_unavailable' })
    expect((await call(authorized, {
      file: '/mnt/data/not-a-descriptor', searchable_content: 'path-shaped attachment',
    })).body).toEqual({ status: 'failed', error_code: 'raw_bytes_unavailable' })
    expect((await call(authorized, {
      file: 'file_not_a_descriptor', searchable_content: 'id-shaped attachment',
    })).body).toEqual({ status: 'failed', error_code: 'raw_bytes_unavailable' })
    const malformed = await call(authorized, {
      file: { download_url: 'https://files.example.com/value' }, searchable_content: 'malformed',
    })
    expect(malformed.result.isError).toBe(true)
    expect(malformed.body).toEqual({ status: 'failed', error_code: 'invalid_manifest' })

    const noKey = await call(registry({ key: null, downloader: goodDownload }), {
      file: { download_url: 'https://files.example.com/value', file_id: 'file_auth' }, searchable_content: 'auth',
    })
    expect(noKey.body).toEqual({ status: 'failed', error_code: 'encryption_key_unavailable' })
    const unknownService = await call(registry({
      key, identity: { clientName: null, agentIdentity: null }, downloader: goodDownload,
    }), {
      file: { download_url: 'https://files.example.com/value', file_id: 'file_unknown_service' },
      searchable_content: 'auth',
    })
    expect(unknownService.body).toEqual({ status: 'failed', error_code: 'client_identity_unavailable' })
    expect(JSON.stringify([malformed.body, noKey.body, unknownService.body])).not.toContain('files.example.com')
  })
})
