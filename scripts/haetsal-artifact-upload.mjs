#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { open, stat } from 'node:fs/promises'
import { extname, resolve } from 'node:path'

const DEFAULT_BASE = 'https://haetsalos.specialdarksystems.com'
const LOCAL_MAX_BYTES = 25 * 1024 * 1024

function argument(name) {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}

function flag(name) {
  return process.argv.includes(name)
}

function fail(code) {
  process.stderr.write(`${JSON.stringify({ status: 'failed', error_code: code })}\n`)
  process.exit(1)
}

function inferMime(filePath) {
  const known = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.pdf': 'application/pdf',
    '.txt': 'text/plain',
    '.md': 'text/plain',
    '.json': 'text/plain',
    '.csv': 'text/plain',
  }
  return known[extname(filePath).toLowerCase()] ?? 'application/octet-stream'
}

async function sha256File(filePath) {
  const hash = createHash('sha256')
  const handle = await open(filePath, 'r')
  try {
    for await (const chunk of handle.createReadStream()) hash.update(chunk)
  } finally {
    await handle.close().catch(() => undefined)
  }
  return hash.digest('hex')
}

function parseMcpResponse(text) {
  if (!text.trim()) return null
  const data = text.split(/\r?\n/).filter(line => line.startsWith('data:')).pop()
  return JSON.parse(data ? data.slice(5).trim() : text)
}

class McpHttpClient {
  constructor(base, headers, clientName) {
    this.base = base
    this.headers = headers
    this.clientName = clientName
    this.sessionId = null
    this.id = 0
  }

  async rpc(method, params) {
    const headers = { ...this.headers, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }
    if (this.sessionId) headers['mcp-session-id'] = this.sessionId
    const response = await fetch(`${this.base}/mcp`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ jsonrpc: '2.0', id: ++this.id, method, params }),
    })
    this.sessionId = response.headers.get('mcp-session-id') ?? this.sessionId
    const text = await response.text()
    if (!response.ok) throw new Error(`mcp_http_${response.status}`)
    return parseMcpResponse(text)
  }

  async connect() {
    await this.rpc('initialize', {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: `haetsal-artifact-upload-${this.clientName}`, version: '1.0.0' },
    })
    await this.rpc('notifications/initialized', {})
  }

  async listTools() {
    const response = await this.rpc('tools/list', {})
    return response?.result?.tools ?? []
  }

  async callTool(name, args) {
    const response = await this.rpc('tools/call', { name, arguments: args })
    const result = response?.result
    const text = (result?.content ?? []).filter(item => item.type === 'text').map(item => item.text ?? '').join('\n')
    const parsed = text ? JSON.parse(text) : null
    if (result?.isError || parsed?.status === 'failed') throw new Error(parsed?.error_code ?? 'tool_call_failed')
    return parsed
  }
}

async function main() {
  const client = argument('--client')
  if (client !== 'codex' && client !== 'claude') fail('invalid_client')
  const clientId = process.env.HAETSAL_CF_CLIENT_ID
  const clientSecret = process.env.HAETSAL_CF_CLIENT_SECRET
  const base = (process.env.HAETSAL_MCP_BASE_URL || DEFAULT_BASE).replace(/\/$/, '')
  const accessHeaders = {
    'CF-Access-Client-Id': clientId,
    'CF-Access-Client-Secret': clientSecret,
  }

  if (flag('--proof')) {
    if (!clientId || !clientSecret) fail('credentials_unavailable')
    const mcp = new McpHttpClient(base, accessHeaders, client)
    await mcp.connect()
    const names = (await mcp.listTools()).map(tool => tool.name)
    const required = ['reserve_artifact_upload', 'finalize_artifact_capture', 'artifact_intake_status']
    const missing = required.filter(name => !names.includes(name))
    if (missing.length > 0) {
      process.stderr.write(`${JSON.stringify({
        status: 'failed', error_code: 'artifact_tools_unavailable', missing_tools: missing,
      })}\n`)
      process.exit(1)
    }
    process.stdout.write(`${JSON.stringify({ status: 'ready', client_name: client, artifact_tools: required.length })}\n`)
    return
  }

  const suppliedPath = argument('--path')
  if (!suppliedPath) fail('path_required')
  const filePath = resolve(suppliedPath)
  const fileStat = await stat(filePath).catch(() => null)
  if (!fileStat?.isFile()) fail('regular_file_required')
  if (fileStat.size <= 0) fail('raw_bytes_unavailable')
  if (fileStat.size > LOCAL_MAX_BYTES) fail('bulk_import_required')
  const plaintextSha256 = await sha256File(filePath)
  const declaredMimeType = argument('--mime') || inferMime(filePath)
  const idempotencyKey = argument('--idempotency-key') || `local-${client}-${plaintextSha256}`

  if (flag('--dry-run')) {
    process.stdout.write(`${JSON.stringify({
      status: 'dry_run',
      client_name: client,
      byte_length: fileStat.size,
      plaintext_sha256: plaintextSha256,
      declared_mime_type: declaredMimeType,
    })}\n`)
    return
  }
  if (!clientId || !clientSecret) fail('credentials_unavailable')

  const mcp = new McpHttpClient(base, accessHeaders, client)
  await mcp.connect()
  const names = (await mcp.listTools()).map(tool => tool.name)
  for (const required of ['reserve_artifact_upload', 'artifact_intake_status']) {
    if (!names.includes(required)) fail('artifact_tools_unavailable')
  }
  const reserved = await mcp.callTool('reserve_artifact_upload', {
    idempotency_key: idempotencyKey,
    byte_length: fileStat.size,
    plaintext_sha256: plaintextSha256,
    declared_mime_type: declaredMimeType,
  })
  if (fileStat.size > Number(reserved.max_bytes ?? 0)) fail('bulk_import_required')
  if (reserved.status !== 'finalized') {
    const response = await fetch(`${base}${reserved.upload_path}`, {
      method: 'PUT',
      headers: {
        ...accessHeaders,
        'Content-Type': declaredMimeType,
        'Content-Length': String(fileStat.size),
      },
      body: createReadStream(filePath),
      duplex: 'half',
    })
    const upload = await response.json().catch(() => null)
    if (!response.ok || upload?.status === 'failed') throw new Error(upload?.error_code ?? `upload_http_${response.status}`)
  }
  const receipt = await mcp.callTool('artifact_intake_status', { upload_id: reserved.uploadId })
  process.stdout.write(`${JSON.stringify({
    status: receipt.status,
    operation_id: receipt.operationId,
    upload_id: receipt.uploadId,
    artifact_id: receipt.artifactId,
    byte_length: receipt.byteLength,
    plaintext_sha256: receipt.plaintextSha256,
    ciphertext_sha256: receipt.ciphertextSha256,
    encryption_family: receipt.encryptionFamily,
    tenant_binding: receipt.tenant_binding,
    client_name: receipt.client_name,
    agent_identity: receipt.agent_identity,
  })}\n`)
}

main().catch(error => fail(error instanceof Error ? error.message : 'invalid_state'))
