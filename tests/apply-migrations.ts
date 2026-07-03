import { applyD1Migrations, env } from 'cloudflare:test'
import { installCompiledSynthesisTestStore } from '../src/services/compiled-synthesis-postgres'
import { installCanonicalGovernanceTestStore } from '../src/services/canonical-governance-memory'
import { installCanonicalMemoryTestStore } from '../src/services/canonical-postgres'

await applyD1Migrations(env.D1_US, env.TEST_MIGRATIONS)
installCanonicalMemoryTestStore(env as never)
installCompiledSynthesisTestStore(env as never)
// Governance store (Phase 1/2): without this, broker recall traces would fall
// back to the Postgres store and trip pg module resolution inside workerd.
installCanonicalGovernanceTestStore(env as never)
