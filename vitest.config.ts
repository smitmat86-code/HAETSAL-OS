import path from 'node:path'
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers'
import { defineConfig } from 'vitest/config'

const TEST_OUTPUT_FILTER_FLAG = Symbol.for('haetsal.testOutputFilterInstalled')
const QUIET_TEST_LOG_PREFIXES = [
  'RETAIN_CONTENT_START',
  'RETAIN_CONTENT_CANONICAL_PIPELINE_DONE',
  'RETAIN_CONTENT_DEDUP_HIT',
  'INGESTION_RETAIN_ARTIFACT_START',
  'INGESTION_RETAIN_ARTIFACT_DONE',
  'MCP_RETAIN_START',
  'MCP_RETAIN_DONE',
]
const QUIET_TEST_OUTPUT_PATTERNS = [
  /^\[vpw:debug\] Adding `enable_nodejs_/,
  /^\[vpw:info\] Starting runtime for /,
  /^Sourcemap for ".*node_modules\/@cloudflare\/containers\/dist\/.*" points to missing source files$/,
]

function installFilteredTestOutput(): void {
  const state = globalThis as typeof globalThis & { [TEST_OUTPUT_FILTER_FLAG]?: boolean }
  if (state[TEST_OUTPUT_FILTER_FLAG]) return
  state[TEST_OUTPUT_FILTER_FLAG] = true

  const wrapWrite = (
    stream: NodeJS.WriteStream,
  ): void => {
    const originalWrite = stream.write.bind(stream)
    stream.write = ((chunk: string | Uint8Array, encoding?: BufferEncoding | ((error?: Error | null) => void), callback?: (error?: Error | null) => void) => {
      const text = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8')
      if (QUIET_TEST_OUTPUT_PATTERNS.some(pattern => pattern.test(text.trim()))) {
        if (typeof encoding === 'function') encoding()
        else callback?.()
        return true
      }
      if (typeof encoding === 'function') return originalWrite(chunk, encoding)
      return originalWrite(chunk, encoding, callback)
    }) as typeof stream.write
  }

  wrapWrite(process.stdout)
  wrapWrite(process.stderr)
}

installFilteredTestOutput()

export default defineConfig(async () => {
  const migrationsPath = path.join(__dirname, 'migrations')
  const migrations = await readD1Migrations(migrationsPath)

  return {
    plugins: [
      cloudflareTest({
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
              const requestPath = url.pathname

              if (/^\/v1\/default\/banks\/[^/]+\/memories$/.test(requestPath)) {
                return new Response(
                  JSON.stringify({
                    success: true,
                    bank_id: requestPath.split('/')[4],
                    items_count: 1,
                    async: false,
                  }),
                  { status: 200, headers: { 'Content-Type': 'application/json' } },
                )
              }

              if (/^\/v1\/default\/banks\/[^/]+\/operations\/[^/]+$/.test(requestPath)) {
                return new Response(
                  JSON.stringify({
                    operation_id: requestPath.split('/')[6],
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

              if (/^\/v1\/default\/banks\/[^/]+\/memories\/recall$/.test(requestPath)) {
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

              if (/^\/v1\/default\/banks\/[^/]+\/mental-models/.test(requestPath)) {
                return new Response(
                  JSON.stringify({ content: 'Stub mental model' }),
                  { status: 200, headers: { 'Content-Type': 'application/json' } },
                )
              }

              if (/^\/v1\/default\/banks\/[^/]+\/webhooks$/.test(requestPath) && request.method === 'GET') {
                return new Response(
                  JSON.stringify({ items: [] }),
                  { status: 200, headers: { 'Content-Type': 'application/json' } },
                )
              }

              if (/^\/v1\/default\/banks\/[^/]+\/reflect$/.test(requestPath)) {
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
      }),
    ],
    test: {
      setupFiles: ['./tests/apply-migrations.ts'],
      fileParallelism: false,
      maxWorkers: 1,
      minWorkers: 1,
      onConsoleLog(log) {
        return !QUIET_TEST_LOG_PREFIXES.some(prefix => log.startsWith(prefix))
      },
    },
  }
})
