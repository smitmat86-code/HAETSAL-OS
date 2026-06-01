import type { Client as PgClient } from 'pg'
import type { Env } from '../types/env'

export interface PostgresStatement {
  text: string
  values: unknown[]
}

export interface PostgresSql {
  (strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown[]>
  query(statement: string): Promise<unknown[]>
  prepare(strings: TemplateStringsArray, ...values: unknown[]): PostgresStatement
  transaction(statements: PostgresStatement[]): Promise<void>
}

function createStatement(strings: TemplateStringsArray, values: unknown[]): PostgresStatement {
  let text = ''
  strings.forEach((part, index) => {
    text += part
    if (index < values.length) text += `$${index + 1}`
  })
  return { text, values }
}

async function withClient<T>(
  connectionString: string,
  run: (client: PgClient) => Promise<T>,
): Promise<T> {
  const { Client } = await import('pg')
  const client = new Client({ connectionString })
  await client.connect()
  try {
    return await run(client)
  } finally {
    await client.end()
  }
}

export function createPostgresStatement(
  strings: TemplateStringsArray,
  ...values: unknown[]
): PostgresStatement {
  return createStatement(strings, values)
}

export function createPostgresSql(connectionString: string): PostgresSql {
  const runStatement = (statement: PostgresStatement): Promise<unknown[]> =>
    withClient(connectionString, async (client) => {
      const result = await client.query(statement.text, statement.values)
      return result.rows
    })

  const sql = ((strings: TemplateStringsArray, ...values: unknown[]) =>
    runStatement(createStatement(strings, values))) as PostgresSql

  sql.query = (statement: string) =>
    withClient(connectionString, async (client) => {
      const result = await client.query(statement)
      return result.rows
    })

  sql.prepare = createPostgresStatement

  sql.transaction = async (statements: PostgresStatement[]): Promise<void> => {
    await withClient(connectionString, async (client) => {
      await client.query('BEGIN')
      try {
        for (const statement of statements) {
          await client.query(statement.text, statement.values)
        }
        await client.query('COMMIT')
      } catch (error) {
        await client.query('ROLLBACK')
        throw error
      }
    })
  }

  return sql
}

export function getCanonicalPostgresConnectionString(env: Env): string {
  const hyperdriveConnection = env.HYPERDRIVE_CANONICAL?.connectionString?.trim()
  if (hyperdriveConnection) return hyperdriveConnection

  const localConnection = env.CANONICAL_POSTGRES_CONNECTION_STRING?.trim()
  if (localConnection) return localConnection

  throw new Error('Canonical Postgres requires HYPERDRIVE_CANONICAL or CANONICAL_POSTGRES_CONNECTION_STRING')
}

export function createCanonicalPostgresSql(env: Env): PostgresSql {
  return createPostgresSql(getCanonicalPostgresConnectionString(env))
}
