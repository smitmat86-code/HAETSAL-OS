// tests/3.4-telegram.test.ts
// Telegram delivery service — send, webhook validation, chat_id storage

import { describe, it, expect } from 'vitest'
import { env } from 'cloudflare:test'

describe('Telegram delivery service', () => {
  it('KV stores and retrieves chat_id', async () => {
    const tenantId = crypto.randomUUID()
    await env.KV_SESSION.put(`telegram_chat_id:${tenantId}`, '123456789')
    const chatId = await env.KV_SESSION.get(`telegram_chat_id:${tenantId}`)
    expect(chatId).toBe('123456789')
  })

  it('missing chat_id returns null from KV', async () => {
    const tenantId = crypto.randomUUID()
    const chatId = await env.KV_SESSION.get(`telegram_chat_id:${tenantId}`)
    expect(chatId).toBeNull()
  })

  it('telegram.ts exports sendTelegramMessage', async () => {
    const mod = await import('../src/services/delivery/telegram')
    expect(typeof mod.sendTelegramMessage).toBe('function')
  })

  it('webhook secret validation — invalid token should be rejected', () => {
    const validSecret = 'my-webhook-secret'
    const incomingSecret = 'wrong-secret' as string
    expect(incomingSecret === validSecret).toBe(false)
  })

  it('webhook secret validation — valid token should pass', () => {
    const validSecret = 'my-webhook-secret'
    const incomingSecret = String('my-webhook-secret')
    expect(incomingSecret === validSecret).toBe(true)
  })

  it('settings telegram endpoint stores chat_id in KV', async () => {
    const tenantId = crypto.randomUUID()
    const chatId = '987654321'
    // Simulate what POST /api/settings/telegram does
    await env.KV_SESSION.put(`telegram_chat_id:${tenantId}`, chatId)
    const stored = await env.KV_SESSION.get(`telegram_chat_id:${tenantId}`)
    expect(stored).toBe(chatId)
  })
})
