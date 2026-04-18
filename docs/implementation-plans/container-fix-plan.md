# Hindsight Container Fix + Deployment

## Goal

Fix the Hindsight container binding to match Cloudflare's Container architecture (DO-backed, not service-binding `Fetcher`) and deploy the full stack.

---

## The Problem

The codebase currently treats `HINDSIGHT` as a `Fetcher` (simple service binding):
```typescript
// env.ts
HINDSIGHT: Fetcher

// Callers (48+ locations):
env.HINDSIGHT.fetch('http://hindsight/...')
```

But **Cloudflare Containers are backed by Durable Objects**. The correct pattern is:
```typescript
// Container class
export class HindsightContainer extends Container { defaultPort = 8080 }

// Binding is a DurableObjectNamespace, not Fetcher
HINDSIGHT: DurableObjectNamespace

// Callers go through DO stub
const id = env.HINDSIGHT.idFromName(tenantId)
const stub = env.HINDSIGHT.get(id) as DurableObjectStub & Container
return await stub.fetch(request)
```

---

## User Review Required

> [!IMPORTANT]
> **Architecture decision**: Each Hindsight container instance is backed by a DO. This means:
> - We can route to a **per-tenant container** via `idFromName(tenantId)` — natural isolation
> - The Container class handles boot/sleep lifecycle automatically (`sleepAfter` config)
> - BUT: all 48+ call sites that use `env.HINDSIGHT.fetch()` need to resolve the tenant's container stub first
>
> **Recommended approach**: Create a thin `getHindsightStub(tenantId, env)` helper that returns the typed stub. Callers change from `env.HINDSIGHT.fetch(url)` to `getHindsightStub(tenantId, env).fetch(url)`. Minimal diff.

> [!WARNING]
> **Cron callers**: Cron functions (consolidation, morning brief, weekly synthesis) don't have a DO context — they iterate tenants from D1. They already have `tenantId` or `hindsightTenantId` available, so they can call `getHindsightStub()` directly.

---

## Proposed Changes

### 1. Install `@cloudflare/containers`

```bash
npm install @cloudflare/containers
```

---

### 2. Container DO Class

#### [NEW] [HindsightContainer.ts](file:///c:/Users/matth/Documents/HAETSAL%20OS/src/workers/mcpagent/do/HindsightContainer.ts) (~20 lines)

```typescript
import { Container } from '@cloudflare/containers'

export class HindsightContainer extends Container {
  defaultPort = 8080
  sleepAfter = '5m'   // Sleep after 5 min idle — scale-to-zero

  override onStart() { console.log('Hindsight container started') }
  override onStop()  { console.log('Hindsight container stopped') }
  override onError(error: unknown) { console.error('Hindsight container error:', error) }
}
```

---

### 3. Fix wrangler.toml

#### [MODIFY] [wrangler.toml](file:///c:/Users/matth/Documents/HAETSAL%20OS/wrangler.toml)

```diff
 [[containers]]
-name = "HINDSIGHT"
-image = "./hindsight"
+class_name = "HindsightContainer"
+image = "./hindsight"
 max_instances = 3

+[[durable_objects.bindings]]
+name = "HINDSIGHT"
+class_name = "HindsightContainer"

 [[migrations]]
-tag = "v1"
-new_sqlite_classes = ["McpAgentDO"]
+tag = "v2"
+new_sqlite_classes = ["HindsightContainer"]
```

> [!NOTE]
> The existing `v1` migration for `McpAgentDO` stays. We add a `v2` migration for the new `HindsightContainer` class.

---

### 4. Update env.ts binding

#### [MODIFY] [env.ts](file:///c:/Users/matth/Documents/HAETSAL%20OS/src/types/env.ts)

```diff
-HINDSIGHT: Fetcher
+HINDSIGHT: DurableObjectNamespace
```

---

### 5. Hindsight Stub Helper

#### [NEW] [hindsight.ts](file:///c:/Users/matth/Documents/HAETSAL%20OS/src/services/hindsight.ts) (~15 lines)

```typescript
import type { Env } from '../types/env'

/** Get a routable Hindsight container stub for a tenant */
export function getHindsightStub(tenantId: string, env: Env) {
  const id = env.HINDSIGHT.idFromName(tenantId)
  return env.HINDSIGHT.get(id)
}
```

---

### 6. Update all callers

Every `env.HINDSIGHT.fetch(...)` call becomes `getHindsightStub(tenantId, env).fetch(...)`.

**Affected files** (non-exhaustive — grep found 48+ references):

| File | Change |
|------|--------|
| `src/services/tenant.ts` | `registerHindsightTenant()` — needs tenantId for stub |
| `src/tools/recall.ts` | `recallViaService()` — already has tenantId param |
| `src/services/ingestion/retain.ts` | `retainContent()` — has tenantId in artifact |
| `src/agents/base-agent.ts` | `open()` — mental model fetch |
| `src/cron/passes/pass1-contradiction.ts` | Has bankId/tenantId |
| `src/cron/passes/pass2-bridges.ts` | Has bankId/tenantId |
| `src/cron/passes/pass4-gaps.ts` | Has bankId/tenantId |
| `src/services/bootstrap/hindsight-config.ts` | Has bankId |

### 7. Export HindsightContainer from index.ts

#### [MODIFY] [index.ts](file:///c:/Users/matth/Documents/HAETSAL%20OS/src/workers/mcpagent/index.ts)

```typescript
export { HindsightContainer } from './do/HindsightContainer'
```

---

## Deployment Prerequisites

Before `npx wrangler deploy`:

| Prerequisite | Command/Action |
|-------------|----------------|
| Docker running locally | `docker info` |
| D1 database created | `npx wrangler d1 create brain-us` → copy ID to wrangler.toml |
| KV namespace created | `npx wrangler kv namespace create KV_SESSION` → copy ID |
| Vectorize index created | `npx wrangler vectorize create brain-memory --dimensions=768 --metric=cosine` |
| Hyperdrive created | `npx wrangler hyperdrive create brain-neon --connection-string="<NEON_URL>"` → copy ID |
| AI Gateway created | Dashboard → AI → Gateway → `brain-gateway` |
| R2 buckets created | `npx wrangler r2 bucket create brain-artifacts` + `brain-observability` |
| Queues created | `npx wrangler queues create brain-priority-high` (etc. for all 5) |
| Secrets set | `npx wrangler secret put CF_ACCESS_AUD` (etc. for all secrets) |
| D1 migrations | `npx wrangler d1 migrations apply brain-us --remote` |

---

## Verification Plan

### Automated Tests

```bash
npx tsc --noEmit          # Type check passes with new DurableObjectNamespace
npx vitest run             # All existing tests pass
```

### Manual Verification

1. `docker info` — confirm Docker is running
2. `npx wrangler deploy --dry-run` — confirm wrangler config is valid
3. `npx wrangler deploy` — watch for container build + push
4. Wait 2-3 min for container provisioning
5. Test a simple HTTP call to the deployed worker

---

## Constraints

| Constraint | Enforcement |
|-----------|------------|
| All callers use `getHindsightStub()` | Grep for raw `env.HINDSIGHT.fetch` after changes |
| `HindsightContainer.ts` ≤ 30 lines | Simple passthrough class |
| Existing test mocks continue to work | `HINDSIGHT` mock in tests updated to DO namespace pattern |
