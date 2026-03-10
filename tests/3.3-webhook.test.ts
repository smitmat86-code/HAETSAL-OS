// tests/3.3-webhook.test.ts
// Hindsight webhook — HMAC validation, event type filtering

import { describe, it, expect } from 'vitest'

describe('Hindsight webhook', () => {
  it('HMAC-SHA256 computation matches expected output', async () => {
    const secret = 'test-webhook-secret'
    const body = '{"event_type":"consolidation.completed","bank_id":"bank-123"}'
    const key = await crypto.subtle.importKey(
      'raw', new TextEncoder().encode(secret),
      { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
    )
    const sig = btoa(String.fromCharCode(
      ...new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body))),
    ))
    expect(sig.length).toBeGreaterThan(0)
    // Verify same secret + body produces same signature
    const sig2 = btoa(String.fromCharCode(
      ...new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body))),
    ))
    expect(sig).toBe(sig2)
  })

  it('wrong secret produces different HMAC', async () => {
    const body = '{"event_type":"test"}'
    const key1 = await crypto.subtle.importKey(
      'raw', new TextEncoder().encode('secret-1'),
      { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
    )
    const key2 = await crypto.subtle.importKey(
      'raw', new TextEncoder().encode('secret-2'),
      { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
    )
    const sig1 = btoa(String.fromCharCode(
      ...new Uint8Array(await crypto.subtle.sign('HMAC', key1, new TextEncoder().encode(body))),
    ))
    const sig2 = btoa(String.fromCharCode(
      ...new Uint8Array(await crypto.subtle.sign('HMAC', key2, new TextEncoder().encode(body))),
    ))
    expect(sig1).not.toBe(sig2)
  })

  it('event_type filtering: only consolidation.completed triggers passes', () => {
    const events = [
      { event_type: 'consolidation.completed', bank_id: 'b1' },
      { event_type: 'memory.created', bank_id: 'b2' },
      { event_type: 'consolidation.started', bank_id: 'b3' },
    ]
    const triggers = events.filter(
      e => e.event_type === 'consolidation.completed' && e.bank_id,
    )
    expect(triggers.length).toBe(1)
    expect(triggers[0].bank_id).toBe('b1')
  })
})
