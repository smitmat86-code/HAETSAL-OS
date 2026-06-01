import { SELF } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import { hasCanonicalHyperdriveBinding } from '../src/workers/mcpagent/routes/canary'
import type { Env } from '../src/types/env'

function envWithHyperdrive(connectionString?: string): Env {
  return {
    HYPERDRIVE_CANONICAL: connectionString === undefined
      ? undefined
      : { connectionString } as Hyperdrive,
  } as Env
}

describe('10.6 production deploy Hyperdrive canary', () => {
  it('detects a resolved canonical Hyperdrive binding without exposing it', () => {
    expect(hasCanonicalHyperdriveBinding(envWithHyperdrive(' postgres://example/db '))).toBe(true)
  })

  it('treats a missing or blank canonical Hyperdrive binding as unavailable', () => {
    expect(hasCanonicalHyperdriveBinding(envWithHyperdrive())).toBe(false)
    expect(hasCanonicalHyperdriveBinding(envWithHyperdrive('  '))).toBe(false)
  })

  it('exposes a HEAD-only canary route outside auth without writing memory', async () => {
    const response = await SELF.fetch('http://localhost/_canary/hyperdrive', {
      method: 'HEAD',
    })

    expect(response.status).toBe(503)
    expect(response.status).not.toBe(401)
  })
})
