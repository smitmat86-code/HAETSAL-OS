import { applyD1Migrations, env } from 'cloudflare:test'
import { installCanonicalMemoryTestStore } from '../src/services/canonical-postgres'

await applyD1Migrations(env.D1_US, env.TEST_MIGRATIONS)
installCanonicalMemoryTestStore(env as never)
