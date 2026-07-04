// scripts/mission-phase9-live-smoke.ts
// Phase 9 gate live smoke: demo clauses 3+4 mechanism — an external MCP
// client (this script speaks Streamable HTTP JSON-RPC, exactly what Claude
// Code / Codex clients do) writes a memory via capture_memory and reads it
// back via search_memory (composed) with provenance/citation, within 30s.
// Plus the Phase 9 session surface (window read + close endpoint live).
// Run: npx tsx scripts/mission-phase9-live-smoke.ts

const BASE = 'https://haetsalos.specialdarksystems.com'
const clientId = process.env.CF_ACCESS_CLIENT_ID
const clientSecret = process.env.CF_ACCESS_CLIENT_SECRET
if (!clientId || !clientSecret) { console.error('SMOKE ABORT: service-token env missing'); process.exit(2) }

const results: Array<{ step: string; ok: boolean; note: string }> = []
const record = (step: string, ok: boolean, note: string) => {
  results.push({ step, ok, note })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${step} — ${note}`)
}

let mcpSession: string | null = null
let rpcId = 0

async function mcp<T>(method: string, params: Record<string, unknown>): Promise<T | null> {
  const headers: Record<string, string> = {
    'CF-Access-Client-Id': clientId!, 'CF-Access-Client-Secret': clientSecret!,
    'Content-Type': 'application/json', Accept: 'application/json, text/event-stream',
  }
  if (mcpSession) headers['mcp-session-id'] = mcpSession
  const res = await fetch(`${BASE}/mcp`, {
    method: 'POST', headers,
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }),
  })
  mcpSession = res.headers.get('mcp-session-id') ?? mcpSession
  const text = await res.text()
  // Streamable HTTP may answer as SSE frames; take the last data: line.
  const dataLine = text.split('\n').filter(l => l.startsWith('data:')).pop()
  const payload = dataLine ? dataLine.slice(5).trim() : text
  try {
    const parsed = JSON.parse(payload) as { result?: T; error?: { message?: string } }
    if (parsed.error) { console.log(`  (rpc error: ${parsed.error.message?.slice(0, 120)})`); return null }
    return parsed.result ?? null
  } catch { return null }
}

function toolText(result: unknown): string {
  const content = (result as { content?: Array<{ type: string; text?: string }> })?.content
  return content?.filter(c => c.type === 'text').map(c => c.text ?? '').join('\n') ?? ''
}

async function main(): Promise<void> {
  const marker = `phase9-roundtrip-${crypto.randomUUID().slice(0, 8)}`

  // 1. MCP initialize (fresh external client, exactly like Claude Code/Codex).
  const init = await mcp<{ serverInfo?: { name?: string } }>('initialize', {
    protocolVersion: '2025-03-26',
    capabilities: {},
    clientInfo: { name: 'phase9-smoke-client', version: '1.0.0' },
  })
  record('mcp-initialize', init?.serverInfo?.name === 'haetsal', `server=${init?.serverInfo?.name}`)
  await mcp('notifications/initialized', {})

  // 2. capture_memory writes a governed memory.
  const captured = await mcp('tools/call', {
    name: 'capture_memory',
    arguments: { content: `Round-trip check ${marker}: the external client wrote this via MCP.`, scope: 'general' },
  })
  const capturedText = toolText(captured)
  record('capture_memory', capturedText.length > 0 && !capturedText.toLowerCase().includes('error'),
    `receipt=${capturedText.slice(0, 100).replace(/\s+/g, ' ')}`)

  // 3. search_memory (composed) cites it back with provenance within 30s.
  let found = ''
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline && !found.includes(marker)) {
    const searched = await mcp('tools/call', {
      name: 'search_memory',
      arguments: { query: `round-trip check ${marker}`, mode: 'composed' },
    })
    found = toolText(searched)
    if (!found.includes(marker)) await new Promise(r => setTimeout(r, 4000))
  }
  record('search_memory-composed', found.includes(marker), found.includes(marker) ? 'cited within 30s' : 'not cited within 30s')
  const provenance = /"(sourceSystem|source_system|provenance|citation|trustState|trust_state)"/.test(found)
  record('provenance-fields', provenance, provenance ? 'result carries provenance/citation fields' : 'no provenance fields in result')

  // 4. Session surface live (window read on a fresh key + close endpoint).
  const headers = { 'CF-Access-Client-Id': clientId!, 'CF-Access-Client-Secret': clientSecret! }
  const windowRes = await fetch(`${BASE}/api/session/telegram:0/window`, { headers })
  const windowJson = await windowRes.json().catch(() => null) as { window?: string } | null
  record('session-window-endpoint', windowRes.status === 200 && windowJson !== null && typeof windowJson.window === 'string',
    `status=${windowRes.status}, window="${(windowJson?.window ?? '').slice(0, 40)}"`)
  const closeRes = await fetch(`${BASE}/api/session/telegram:0/close`, { method: 'POST', headers })
  record('session-close-endpoint', closeRes.status === 200, `status=${closeRes.status}`)

  const failed = results.filter(r => !r.ok)
  console.log(`\nSMOKE ${failed.length === 0 ? 'GREEN' : 'RED'}: ${results.length - failed.length}/${results.length} checks passed`)
  process.exit(failed.length === 0 ? 0 : 1)
}

main().catch((error) => { console.error('SMOKE CRASH:', error instanceof Error ? error.message : String(error)); process.exit(1) })
