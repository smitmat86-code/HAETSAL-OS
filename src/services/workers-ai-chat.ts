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

export async function runGatewayChat(
  env: Env,
  messages: ChatMessage[],
  maxTokens = 512,
): Promise<string | null> {
  const result = await (env.AI as { run: (model: string, input: unknown, options?: unknown) => Promise<unknown> }).run(
    CHAT_MODEL,
    { messages, max_tokens: maxTokens },
    { gateway: { id: env.AI_GATEWAY_ID, collectLog: false } },
  )
  const text = readChatText(result)
  if (text === null) {
    // Diagnostic: log the SHAPE of the response so we can distinguish
    // string/array/null/refusal without leaking user content. Truncate
    // hard so nothing large slips into logs.
    const r = (result ?? {}) as Record<string, unknown>
    const choice = (r.choices as Array<Record<string, unknown>> | undefined)?.[0]
    const message = choice?.message as Record<string, unknown> | undefined
    const content = message?.content
    // Law 2 (Phase 13): shape metadata only — model output may echo tenant
    // content, so no previews in logs.
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
  return text
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
