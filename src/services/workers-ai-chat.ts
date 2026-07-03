// src/services/workers-ai-chat.ts
// Shared Workers AI chat/vision helper. The 2026-05-30 catalog removals
// killed @cf/meta/llama-3.1-8b-instruct and @cf/meta/llama-3.2-11b-vision-
// instruct in prod (error 5028); @cf/google/gemma-4-26b-a4b-it is the CF-
// recommended replacement and covers both text and vision with
// OpenAI-shaped output (choices[].message.content).
// G4: every call goes through the AI Gateway with collectLog: false.

import type { Env } from '../types/env'

export const CHAT_MODEL = '@cf/google/gemma-4-26b-a4b-it'

export type ChatContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string; detail?: 'auto' | 'low' | 'high' } }

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string | ChatContentPart[]
}

/** Reads assistant text from OpenAI-shaped or legacy Workers AI results. */
export function readChatText(result: unknown): string | null {
  if (typeof result === 'string') return result.trim() || null
  const r = result as { response?: string; choices?: Array<{ message?: { content?: string | null } }> }
  const text = r?.choices?.[0]?.message?.content ?? r?.response
  if (typeof text !== 'string') return null
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
  return readChatText(result)
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
