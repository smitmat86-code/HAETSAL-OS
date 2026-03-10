// tests/1.2-websocket.test.ts
// WebSocket integration tests
// Tests upgrade handling and connected message
// NOTE: Full WebSocket testing in vitest-pool-workers is limited
// — these test the response mechanics, not a live WS connection

import { env, SELF } from 'cloudflare:test'
import { describe, it, expect } from 'vitest'

describe('1.2 WebSocket — Upgrade Handling', () => {

  it('rejects /ws without JWT — returns 401', async () => {
    const response = await SELF.fetch('http://localhost/ws', {
      headers: { Upgrade: 'websocket' },
    })
    expect(response.status).toBe(401)
  })

  it('rejects /mcp without JWT — returns 401', async () => {
    const response = await SELF.fetch('http://localhost/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    })
    expect(response.status).toBe(401)
  })

  it('security headers present on non-WS responses', async () => {
    const response = await SELF.fetch('http://localhost/mcp', {
      method: 'POST',
      body: '{}',
    })
    // Even on 401, security headers should be set
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff')
    expect(response.headers.get('X-Frame-Options')).toBe('DENY')
    expect(response.headers.get('Referrer-Policy')).toBe('no-referrer')
  })
})
