import type { Env } from '../types/env'
import { InMemoryCanonicalMemoryStore, PostgresCanonicalMemoryStore, type CanonicalMemoryStore } from './canonical-postgres-repository'
import { createCanonicalPostgresSql } from './postgres-sql'

const CANONICAL_STORE = Symbol.for('haetsal.canonicalMemoryStore')

type EnvWithStore = Env & { [CANONICAL_STORE]?: CanonicalMemoryStore }

export function installCanonicalMemoryStore(
  env: Env,
  store: CanonicalMemoryStore,
): CanonicalMemoryStore {
  Object.defineProperty(env, CANONICAL_STORE, {
    value: store,
    enumerable: true,
    configurable: true,
    writable: true,
  })
  return store
}

export function installCanonicalMemoryTestStore(env: Env): CanonicalMemoryStore {
  const existing = (env as EnvWithStore)[CANONICAL_STORE]
  if (existing) return existing
  return installCanonicalMemoryStore(env, new InMemoryCanonicalMemoryStore())
}

export function getCanonicalMemoryStore(env: Env): CanonicalMemoryStore {
  const scopedEnv = env as EnvWithStore
  if (scopedEnv[CANONICAL_STORE]) return scopedEnv[CANONICAL_STORE]!

  return installCanonicalMemoryStore(env, new PostgresCanonicalMemoryStore(createCanonicalPostgresSql(env)))
}
