import { neon } from '@neondatabase/serverless'
import type { Env } from '../types/env'
import {
  InMemoryCompiledSynthesisStore,
  NeonCompiledSynthesisStore,
  type CompiledSynthesisStore,
} from './compiled-synthesis-repository'

const COMPILED_SYNTHESIS_STORE = Symbol.for('haetsal.compiledSynthesisStore')

type EnvWithStore = Env & { [COMPILED_SYNTHESIS_STORE]?: CompiledSynthesisStore }

export function installCompiledSynthesisStore(
  env: Env,
  store: CompiledSynthesisStore,
): CompiledSynthesisStore {
  Object.defineProperty(env, COMPILED_SYNTHESIS_STORE, {
    value: store,
    enumerable: true,
    configurable: true,
    writable: true,
  })
  return store
}

export function installCompiledSynthesisTestStore(env: Env): CompiledSynthesisStore {
  const existing = (env as EnvWithStore)[COMPILED_SYNTHESIS_STORE]
  if (existing) return existing
  return installCompiledSynthesisStore(env, new InMemoryCompiledSynthesisStore())
}

export function getCompiledSynthesisStore(env: Env): CompiledSynthesisStore {
  const scopedEnv = env as EnvWithStore
  if (scopedEnv[COMPILED_SYNTHESIS_STORE]) return scopedEnv[COMPILED_SYNTHESIS_STORE]!

  const connectionString = env.CANONICAL_POSTGRES_CONNECTION_STRING?.trim()
    || env.NEON_CONNECTION_STRING?.trim()
  if (!connectionString) {
    throw new Error('Compiled synthesis Postgres connection string is required')
  }

  return installCompiledSynthesisStore(env, new NeonCompiledSynthesisStore(neon(connectionString, {
    fetchOptions: { cache: 'no-store' },
  })))
}
