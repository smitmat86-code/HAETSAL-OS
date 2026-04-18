# Phase 3 — As-Built Record

Audit date: 2026-03-10 | All source files read and confirmed.

---

## 3.1 — BaseAgent + Chief of Staff + Layer 1 Router

### BaseAgent API ([base-agent.ts](file:///c:/Users/matth/Documents/HAETSAL%20OS/src/agents/base-agent.ts))

```typescript
export abstract class BaseAgent {
  abstract readonly domain: string
  abstract readonly agentIdentity: string
  protected env: Env
  protected tenantId: string
  protected tmk: CryptoKey
  protected hindsightTenantId: string
  protected traceId: string
  protected parentTraceId?: string
  protected context: AgentContext
  protected reasoningTrace: ReasoningTrace

  constructor(env: Env, tenantId: string, tmk: CryptoKey, hindsightTenantId: string)

  protected async open(): Promise<void>
  // Loads: mental model via GET /mental-models/mental-model-{domain} (plaintext)
  //        + episodic recall via recallViaService()
  //        + pending_actions from D1 (limit 5)

  protected async retain(
    content: string, memoryType: EpistemicMemoryType,
    domain: string, provenance: string
  ): Promise<{ memoryId: string } | null>
  // Law 3 structural gate: EpistemicMemoryType = 'episodic' | 'semantic' | 'world'
  // 'procedural' won't compile

  protected async agentLoop(input: string): Promise<string>
  // Max 10 turns. Workers AI llama-3.3-70b via brain-gateway.
  // Doom loop + context budget integrated.

  protected async close(sessionSummary: string): Promise<void>
  // Retains episodic synthesis, encrypts trace → R2_OBSERVABILITY, clears context.

  protected abstract systemPrompt(): string
  protected contextSummary(): string
  protected activeDomains(): string[]
}
```

### AgentContext ([types.ts](file:///c:/Users/matth/Documents/HAETSAL%20OS/src/agents/types.ts))

```typescript
interface AgentContext {
  memories: Array<{
    memory_id: string; content: string;
    memory_type: string; confidence: number; relevance: number
  }>
  pendingActions: Array<{
    id: string; tool_name: string; integration: string | null;
    capability_class: string; state: string; proposed_at: number
  }>
  parentTraceId?: string
}
```

### DoomLoopState

```typescript
interface DoomLoopState {
  calls: Array<{ toolName: string; inputHash: string }>
  warnCount: number
}
// checkDoomLoop(): 3x same hash → 'warn', 5x → 'break'
// Hash: SHA-256 of toolName + JSON.stringify(input), truncated to 16 chars
```

### Cron KEK Provisioning

Existing `provisionOrRenewKek()` in [tenant.ts](file:///c:/Users/matth/Documents/HAETSAL%20OS/src/services/tenant.ts) confirmed — provisions encrypted KEK on session init, renews when < 2h remaining. Raw KV bytes handled by 3.3 `kek.ts`.

### Layer 1 Router ([router.ts](file:///c:/Users/matth/Documents/HAETSAL%20OS/src/services/agents/router.ts))

```typescript
routeRequest(input: string, env: Env): Promise<AgentType>
// 5 regex patterns → fast path (~5ms)
// Fallback: llama-3.1-8b-instruct via brain-gateway (~200ms)
// Default: 'chief_of_staff'
```

---

## 3.2 — Career Coach + Memory Interface + Delegation

### DelegationSignal (exact shape)

```typescript
interface DelegationSignal {
  delegateTo: AgentType      // 'career_coach' | 'life_coach' | etc.
  reason: string             // Why delegation needed
  context: string            // Context to pass to target agent
}
```

### parseDelegation() — regex-based

```typescript
// In ChiefOfStaff:
parseDelegation(response: string): DelegationSignal | null
// Parses: [DELEGATE:career_coach|reason text|context text]
// Regex: /\[DELEGATE:(\w+)\|(.+?)\|(.+?)\]/
```

### handleDelegation() / instantiateAgent()

> [!CAUTION]
> **NOT IMPLEMENTED as standalone functions.** The plan proposed `handleDelegation()` and `instantiateAgent()` in McpAgent.ts, but neither exists. The as-built `ChiefOfStaff.parseDelegation()` returns a signal that the caller is responsible for acting on. There is no agent factory function. This is a Phase 3.1 design decision: delegation is signal-based (CoS returns a structured signal), not programmatic. The MCP session handler would need to instantiate the target agent manually.

### memory_search / memory_write tools ([memory.ts](file:///c:/Users/matth/Documents/HAETSAL%20OS/src/tools/memory.ts))

```typescript
registerMemoryTools(server: McpServer, ctx: MemoryToolContext): void
// Registers 'memory_search' and 'memory_write'

// memory_write schema:
z.object({
  content: z.string(),
  memory_type: z.enum(['episodic', 'semantic']),  // Excludes procedural AND world
  domain: z.string().optional(),
})
```

Registered in `McpAgent.init()` via `registerMemoryTools(this.server, ctx)`. Version bumped to `3.2.0`.

---

## 3.3 — Nightly Consolidation Cron

### 4-Pass Structure ✅ Confirmed

| Order | File | Export |
|-------|------|--------|
| 1 | [pass1-contradiction.ts](file:///c:/Users/matth/Documents/HAETSAL%20OS/src/cron/passes/pass1-contradiction.ts) | `runPass1(bankId, kek, env): Promise<number>` |
| 2 | [pass2-bridges.ts](file:///c:/Users/matth/Documents/HAETSAL%20OS/src/cron/passes/pass2-bridges.ts) | `runPass2(bankId, tenantId, kek, env): Promise<number>` |
| 3 | [pass3-patterns.ts](file:///c:/Users/matth/Documents/HAETSAL%20OS/src/cron/passes/pass3-patterns.ts) | `runPass3(bankId, tenantId, kek, env): Promise<number>` |
| 4 | [pass4-gaps.ts](file:///c:/Users/matth/Documents/HAETSAL%20OS/src/cron/passes/pass4-gaps.ts) | `runPass4(bankId, tenantId, runId, env): Promise<number>` |

Sequential: each `await`ed in [consolidation.ts](file:///c:/Users/matth/Documents/HAETSAL%20OS/src/cron/consolidation.ts) L62-65.

### consolidationRetain() — Module Boundary ✅ Confirmed

```typescript
// pass3-patterns.ts L16-28 — module-private, NOT exported
async function consolidationRetain(
  content: string, domain: string, provenance: string,
  tenantId: string, kek: CryptoKey, env: Env
): Promise<void>
// Uses 'procedural' as IngestionArtifact['memoryType'] — cast required
// Provenance: 'pass3_behavioral' ✅ (corrected from v1's 'pass4_behavioral')
```

### Cron KEK KV Key Name

> [!WARNING]
> **Deviation from plan**: KV key is **`cron_kek:{tenantId}`** — NOT `cron_kek_raw:{tenantId}`.
> See [kek.ts](file:///c:/Users/matth/Documents/HAETSAL%20OS/src/cron/kek.ts) line 24.

### Webhook Route ✅ Confirmed

```typescript
// index.ts L58-74 — before auth middleware
app.post('/hindsight/webhook', async (c) => {
  // HMAC-SHA256 validation via X-Hindsight-Signature
  // On consolidation.completed + bank_id present:
  //   waitUntil(runConsolidationPasses(payload.bank_id, env, ctx))
})
```

Tenant lookup in `consolidation.ts` L18-20:
```typescript
SELECT id FROM tenants WHERE hindsight_tenant_id = ?
```

### Consolidation Orchestrator — Dual Entry

```typescript
// Webhook entry:
runConsolidationPasses(hindsightTenantId: string, env: Env, ctx: ExecutionContext): Promise<void>

// Cron fallback:
handleNightlyConsolidation(env: Env, ctx: ExecutionContext): Promise<void>
// Iterates all tenants WHERE bootstrap_status = 'completed'
```

Dedup: `INSERT OR IGNORE` — relies on unique index `(tenant_id, started_at / 86400000)`.

---

## 3.4 — Morning Brief + Heartbeat + Weekly Synthesis

### Telegram Delivery ✅ Confirmed

```typescript
// telegram.ts
sendTelegramMessage(
  tenantId: string, message: string, env: Env,
  options?: { parseMode?: 'HTML' | 'MarkdownV2'; disablePreview?: boolean }
): Promise<boolean>
// KV key: telegram_chat_id:{tenantId}
// Silent skip if no chat_id → returns false
```

### Cron Schedule (index.ts L138-146)

| Cron | Handler |
|------|---------|
| `0 7 * * *` | `handleMorningBrief(env, ctx)` |
| `*/30 * * * *` | `runPredictiveHeartbeat(env, ctx)` |
| `0 17 * * 5` | `runWeeklySynthesis(env, ctx)` |
| `0 2 * * *` | `handleNightlyConsolidation(env, ctx)` |

### Weekly Synthesis — Workers AI (NOT reflect)

> [!NOTE]
> The weekly synthesis uses **direct Workers AI** (`llama-3.3-70b-instruct-fp8-fast` via brain-gateway) — NOT the Hindsight `/reflect` endpoint. This is correct: reflect is used in pass4-gaps only. Weekly synthesis recalls sessions then runs its own LLM prompt.

```typescript
// weekly-synthesis.ts
runWeeklySynthesis(env: Env, ctx: ExecutionContext): Promise<void>
// Recall: 'session week review decisions themes patterns', limit 20
// LLM: 200-word synthesis with themes, decisions, patterns, one prediction
// Delivery: Telegram + Obsidian (NOT Pages)
// Archive: semantic, provenance 'weekly_synthesis', metadata { is_weekly_synthesis: true }
```

### Env Secrets Added

```typescript
TELEGRAM_BOT_TOKEN: string
TELEGRAM_WEBHOOK_SECRET: string
BRAVE_API_KEY: string
HINDSIGHT_WEBHOOK_SECRET: string
```

---

## Plan vs. As-Built Deviations Summary

| # | Planned | As-Built | Impact |
|---|---------|----------|--------|
| 1 | KV key: `cron_kek_raw:{tenantId}` | `cron_kek:{tenantId}` | Low — key name is shorter. All references consistent. |
| 2 | `handleDelegation()` + `instantiateAgent()` in McpAgent.ts | NOT implemented — delegation is signal-based via `parseDelegation()` | Medium — caller must manually instantiate target agent. Phase 4+ concern. |
| 3 | `helpers.ts` not in plan | Extracted from base-agent.ts for line limits | Low — good split. |
| 4 | `brief-sections.ts` not in original plan | Extracted from morning-brief.ts | Low — same pattern as helpers.ts. |
| 5 | `memory.ts` in tools/ with `registerMemoryTools()` | As planned but cleaner — separate module from McpAgent.ts | Low — good separation. |
