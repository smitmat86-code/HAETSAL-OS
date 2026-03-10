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
            },
            // Stub HINDSIGHT service binding — Container not running locally
            serviceBindings: {
              HINDSIGHT: () => new Response(
                JSON.stringify({ status: 'ok' }),
                {
                  status: 200,
                  headers: { 'Content-Type': 'application/json' },
                },
              ),
            },
          },
        },
      },
    },
  }
})
