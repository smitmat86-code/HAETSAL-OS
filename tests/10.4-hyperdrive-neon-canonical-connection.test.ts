import { describe, expect, it } from 'vitest'
import {
  createPostgresStatement,
  getCanonicalPostgresConnectionString,
} from '../src/services/postgres-sql'
import type { Env } from '../src/types/env'

function testEnv(input: Partial<Env>): Env {
  return input as Env
}

function hyperdrive(connectionString: string): Hyperdrive {
  return { connectionString } as Hyperdrive
}

describe('10.4 Hyperdrive Neon canonical connection', () => {
  it('prefers the canonical Hyperdrive connection over direct local fallback secrets', () => {
    const connectionString = getCanonicalPostgresConnectionString(testEnv({
      HYPERDRIVE_CANONICAL: hyperdrive(' postgresql://hyperdrive.example/brain '),
      CANONICAL_POSTGRES_CONNECTION_STRING: 'postgresql://local.example/brain',
      NEON_CONNECTION_STRING: 'postgresql://hindsight.example/brain',
    }))

    expect(connectionString).toBe('postgresql://hyperdrive.example/brain')
  })

  it('keeps a dedicated canonical direct URL as a local fallback only', () => {
    const connectionString = getCanonicalPostgresConnectionString(testEnv({
      CANONICAL_POSTGRES_CONNECTION_STRING: ' postgresql://local.example/brain ',
      NEON_CONNECTION_STRING: 'postgresql://hindsight.example/brain',
    }))

    expect(connectionString).toBe('postgresql://local.example/brain')
  })

  it('does not fall back to the Hindsight Neon secret for canonical access', () => {
    expect(() => getCanonicalPostgresConnectionString(testEnv({
      NEON_CONNECTION_STRING: 'postgresql://hindsight.example/brain',
    }))).toThrow(/HYPERDRIVE_CANONICAL/)
  })

  it('builds parameterized pg statements for tagged canonical queries', () => {
    const statement = createPostgresStatement`
      SELECT *
      FROM haetsal_canonical.canonical_captures
      WHERE tenant_id = ${'tenant-1'} AND created_at >= ${42}
    `

    expect(statement.text).toContain('tenant_id = $1')
    expect(statement.text).toContain('created_at >= $2')
    expect(statement.values).toEqual(['tenant-1', 42])
  })
})
