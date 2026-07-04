// src/agents/execution/model-io.ts
// Workers AI response readers for the execution tool loop, extracted from
// tool-loop.ts for the file line limit. The tool_calls parser is deliberately
// tolerant: Workers AI models emit both the flat {name, arguments} shape and
// the OpenAI-nested {function: {name, arguments}} shape, with arguments as an
// object OR a JSON string (llama-3.3 has been observed returning numeric
// params as strings, too — callers coerce).

interface RawToolCall { name?: string; arguments?: unknown; function?: { name?: string; arguments?: unknown } }

export function parseToolCalls(result: unknown): Array<{ name: string; args: Record<string, unknown> }> {
  const calls = (result as { tool_calls?: RawToolCall[] })?.tool_calls
  if (!Array.isArray(calls)) return []
  return calls.flatMap((call) => {
    const name = call.name ?? call.function?.name
    if (!name) return []
    let raw = call.arguments ?? call.function?.arguments ?? {}
    if (typeof raw === 'string') {
      try { raw = JSON.parse(raw) } catch { raw = {} }
    }
    return [{ name, args: (raw ?? {}) as Record<string, unknown> }]
  })
}

export function readResponseText(result: unknown): string {
  if (typeof result === 'string') return result.trim()
  const r = result as { response?: unknown }
  return typeof r?.response === 'string' ? r.response.trim() : ''
}
