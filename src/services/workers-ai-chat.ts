// src/services/workers-ai-chat.ts
// Shared Workers AI chat/vision helper. Model ids come from the central
// registry (src/config/models.ts) so a catalog deprecation is a one-line
// change and the postflight scan can enforce currency. gemma-4 covers both
// text and vision with OpenAI-shaped output (choices[].message.content).
// G4: every call goes through the AI Gateway with collectLog: false.

import type { Env } from '../types/env'
import { MODEL_CHAT } from '../config/models'

export const CHAT_MODEL = MODEL_CHAT

export type ChatContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string; detail?: 'auto' | 'low' | 'high' } }

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string | ChatContentPart[]
}

type ContentPart = { type?: string; text?: string }
type ChoiceMessage = { content?: string | null | ContentPart[] }

/** Reads assistant text from OpenAI-shaped (string or content-parts array) or
 *  legacy Workers AI results. Vision replies from gemma often come back as
 *  a content-parts array even when the input used a plain user message. */
export function readChatText(result: unknown): string | null {
  if (typeof result === 'string') return trimOrNull(result)
  const r = result as { response?: string; choices?: Array<{ message?: ChoiceMessage }> }
  const content = r?.choices?.[0]?.message?.content
  if (typeof content === 'string') return trimOrNull(content)
  if (Array.isArray(content)) {
    const joined = content
      .filter((p) => p && (p.type === 'text' || p.type === undefined))
      .map((p) => p.text ?? '')
      .join('')
    if (joined) return trimOrNull(joined)
  }
  if (typeof r?.response === 'string') return trimOrNull(r.response)
  return null
}

function trimOrNull(text: string): string | null {
  const cleaned = text.replace(/<think>[\s\S]*?<\/think>/g, '').trim()
  return cleaned || null
}

// Two retries, exponential backoff — same live-observed rationale as the
// execution loop (tool-loop.ts): upstream InferenceUpstreamError blips
// cluster for a few seconds, so a lone quick retry can land inside the same
// blip. Covers ALL conversational surfaces (Telegram, SMS, router,
// delegation, vision, write-policy) through this one helper. Retries both
// thrown gateway errors and empty replies; after the last attempt the
// original semantics hold (final throw propagates, final empty returns null).
const CHAT_RETRY_BACKOFFS_MS = [800, 3200]

export async function runGatewayChat(
  env: Env,
  messages: ChatMessage[],
  maxTokens = 512,
): Promise<string | null> {
  for (let attempt = 0; ; attempt++) {
    try {
      const result = await (env.AI as { run: (model: string, input: unknown, options?: unknown) => Promise<unknown> }).run(
        CHAT_MODEL,
        { messages, max_tokens: maxTokens },
        { gateway: { id: env.AI_GATEWAY_ID, collectLog: false } },
      )
      const text = readChatText(result)
      if (text !== null) return text
      logEmptyChatShape(result)
      if (attempt >= CHAT_RETRY_BACKOFFS_MS.length) return null
    } catch (error) {
      // Law 2: error class name only — gateway errors can echo request detail.
      console.warn('GATEWAY_CHAT_ERROR', {
        attempt, name: error instanceof Error ? error.constructor.name : 'unknown',
      })
      if (attempt >= CHAT_RETRY_BACKOFFS_MS.length) throw error
    }
    await new Promise(resolve => setTimeout(resolve, CHAT_RETRY_BACKOFFS_MS[attempt]))
  }
}

// Diagnostic: log the SHAPE of an empty reply so string/array/null/refusal
// are distinguishable without leaking user content (Law 2: no previews —
// model output may echo tenant content).
function logEmptyChatShape(result: unknown): void {
  const r = (result ?? {}) as Record<string, unknown>
  const choice = (r.choices as Array<Record<string, unknown>> | undefined)?.[0]
  const message = choice?.message as Record<string, unknown> | undefined
  const content = message?.content
  const contentType = content === null ? 'null' : Array.isArray(content) ? 'array' : typeof content
  console.warn('GATEWAY_CHAT_EMPTY', {
    topKeys: Object.keys(r),
    choiceKeys: choice ? Object.keys(choice) : [],
    messageKeys: message ? Object.keys(message) : [],
    contentType,
    contentLength: typeof content === 'string' ? content.length : Array.isArray(content) ? content.length : 0,
    finishReason: choice?.finish_reason,
    refusal: typeof message?.refusal === 'string' ? 'present' : undefined,
  })
}

function toBase64(bytes: ArrayBuffer): string {
  const view = new Uint8Array(bytes)
  let binary = ''
  for (let i = 0; i < view.length; i += 0x8000) {
    binary += String.fromCharCode(...view.subarray(i, i + 0x8000))
  }
  return btoa(binary)
}

/** Vision call: the image goes inline as a data-URL content part. */
export async function runGatewayVision(
  env: Env,
  prompt: string,
  imageBytes: ArrayBuffer,
  mediaType: string,
): Promise<string | null> {
  return runGatewayChat(env, [{
    role: 'user',
    content: [
      { type: 'text', text: prompt },
      { type: 'image_url', image_url: { url: `data:${mediaType};base64,${toBase64(imageBytes)}` } },
    ],
  }])
}
