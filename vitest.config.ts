import path from 'node:path'
import { defineWorkersConfig, readD1Migrations } from '@cloudflare/vitest-pool-workers/config'

export default defineWorkersConfig(async () => {
  const migrationsPath = path.join(__dirname, 'migrations')
  const migrations = await readD1Migrations(migrationsPath)

  return {
    test: {
      setupFiles: ['./tests/apply-migrations.ts'],
      poolOptions: {
        workers: {
          singleWorker: true,
          wrangler: { configPath: './wrangler.test.toml' },
          miniflare: {
            bindings: {
              TEST_MIGRATIONS: migrations,
              // Test secrets — NOT production values
              CF_ACCESS_AUD: 'test-aud-brain-access',
              CF_ACCESS_TEAM: 'test-team',
              HMAC_SECRET: 'test-hmac-secret-not-production',
              TELNYX_PUBLIC_KEY: 'test-telnyx-public-key-hex',
            },
            // Stub HINDSIGHT service binding — Container not running locally
            // Returns a plausible retain response for ingestion pipeline tests
            serviceBindings: {
              HINDSIGHT: (request: Request) => {
                const url = new URL(request.url)
                if (url.pathname === '/api/retain') {
                  return new Response(
                    JSON.stringify({ memory_id: crypto.randomUUID(), status: 'retained' }),
                    { status: 200, headers: { 'Content-Type': 'application/json' } },
                  )
                }
                if (url.pathname === '/api/recall') {
                  return new Response(
                    JSON.stringify({ results: [] }),
                    { status: 200, headers: { 'Content-Type': 'application/json' } },
                  )
                }
                return new Response(
                  JSON.stringify({ status: 'ok' }),
                  { status: 200, headers: { 'Content-Type': 'application/json' } },
                )
              },
            },
          },
        },
      },
    },
  }
})
