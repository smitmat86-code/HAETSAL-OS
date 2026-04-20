import path from 'node:path'
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers'
import { defineConfig } from 'vitest/config'
import { buildMiniflareServiceBindings } from './tests/support/miniflare-service-bindings'

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
  for (const stream of [process.stdout, process.stderr]) {
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
}

installFilteredTestOutput()

export default defineConfig(async () => {
  const migrations = await readD1Migrations(path.join(__dirname, 'migrations'))
  return {
    plugins: [
      cloudflareTest({
        singleWorker: true,
        wrangler: { configPath: './wrangler.test.toml' },
        miniflare: {
          bindings: {
            TEST_MIGRATIONS: migrations,
            CF_ACCESS_AUD: 'test-aud-brain-access',
            CF_ACCESS_TEAM: 'test-team',
            HMAC_SECRET: 'test-hmac-secret-not-production',
            TELNYX_PUBLIC_KEY: 'test-telnyx-public-key-hex',
            GRAPHITI_RUNTIME_MODE: 'container',
          },
          serviceBindings: buildMiniflareServiceBindings(),
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
