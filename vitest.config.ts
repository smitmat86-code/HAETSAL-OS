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
            // Stub HINDSIGHT service binding — Container not running locally.
            // Emulates the official bank-scoped v1 API surface used in Landing 1.
            serviceBindings: {
              HINDSIGHT: (request: Request) => {
                const url = new URL(request.url)
                const path = url.pathname

                if (/^\/v1\/default\/banks\/[^/]+\/memories$/.test(path)) {
                  return new Response(
                    JSON.stringify({
                      success: true,
                      bank_id: path.split('/')[4],
                      items_count: 1,
                      async: false,
                    }),
                    { status: 200, headers: { 'Content-Type': 'application/json' } },
                  )
                }

                if (/^\/v1\/default\/banks\/[^/]+\/operations\/[^/]+$/.test(path)) {
                  return new Response(
                    JSON.stringify({
                      operation_id: path.split('/')[6],
                      status: 'completed',
                      operation_type: 'retain',
                      created_at: new Date().toISOString(),
                      updated_at: new Date().toISOString(),
                      completed_at: new Date().toISOString(),
                      error_message: null,
                    }),
                    { status: 200, headers: { 'Content-Type': 'application/json' } },
                  )
                }

                if (/^\/v1\/default\/banks\/[^/]+\/memories\/recall$/.test(path)) {
                  return new Response(
                    JSON.stringify({
                      results: [{
                        id: crypto.randomUUID(),
                        text: 'Stub memory result',
                        type: 'experience',
                        confidence: 0.8,
                        relevance: 0.8,
                      }],
                    }),
                    { status: 200, headers: { 'Content-Type': 'application/json' } },
                  )
                }

                if (/^\/v1\/default\/banks\/[^/]+\/mental-models/.test(path)) {
                  return new Response(
                    JSON.stringify({ content: 'Stub mental model' }),
                    { status: 200, headers: { 'Content-Type': 'application/json' } },
                  )
                }

                if (/^\/v1\/default\/banks\/[^/]+\/webhooks$/.test(path) && request.method === 'GET') {
                  return new Response(
                    JSON.stringify({ items: [] }),
                    { status: 200, headers: { 'Content-Type': 'application/json' } },
                  )
                }

                if (/^\/v1\/default\/banks\/[^/]+\/reflect$/.test(path)) {
                  return new Response(
                    JSON.stringify({ text: 'Stub reflect response' }),
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
