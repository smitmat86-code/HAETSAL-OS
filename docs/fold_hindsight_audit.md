# Fold Hindsight Audit: vs Official Docs & Best Practices

> [!NOTE]
> This is an honest comparison of Fold's implementation against the same Hindsight documentation, leaderboard, and best practices used in the HAETSAL postmortem. Fold is NOT assumed to be correct — it's audited independently.

---

## Scorecard: Fold vs Hindsight Best Practices

| Dimension | Status | Evidence |
|---|---|---|
| **API Routes** | ✅ Correct | `/v1/default/banks/${bankId}/memories` (retain), `/memories/recall`, `/reflect` |
| **Port** | ✅ Correct | `HINDSIGHT_PORT = 8888` in container.ts and env.ts |
| **Plaintext Content** | ✅ Correct | `content: string` — no encryption anywhere in the pipeline |
| **Container Lifecycle** | ✅ Correct | `startAndWaitForPorts` with 3 retries, 5s delay |
| **Reflect Tool** | ✅ Exists | `brain_reflect` registered, routes to `/reflect` |
| **Tags** | ✅ Correct | Tags in retain, recall, and reflect; `tags_match` modes supported |
| **Tag DSL** | ✅ Correct | Full recursive AND/OR/NOT tree (`tag_groups`) typed |
| **Document ID** | ✅ Correct | `document_id` field on RetainItem |
| **Context Field** | ✅ Correct | `context` field on RetainItem |
| **Timestamp** | ✅ Correct | `timestamp` field on RetainItem |
| **Budget** | ✅ Correct | `low/mid/high` enum, defaults to `mid` for recall, `low` for reflect |
| **Fact Types** | ✅ Correct | `world/experience/observation` (not the invented `episodic/semantic/procedural`) |
| **Queue-Based Async** | ✅ Correct | `RETAIN_QUEUE.send()` → `retain-consumer.ts` processes batches |
| **Neon Direct URL** | ✅ Correct | `NEON_DIRECT_URL` injected as `HINDSIGHT_API_DATABASE_URL` |
| **Error Handling** | ✅ Correct | `HindsightClientError` with status + body; queue retries on transient errors |
| **Bank Missions** | ❌ Missing | No `createBank`, no `retain_mission`, no `observations_mission`, no `reflect_mission` |
| **Disposition** | ❌ Missing | No `skepticism`, `literalism`, `empathy` configuration |
| **Entity Labels** | ❌ Missing | No `entity_labels` configuration |
| **Mental Models** | ❌ Missing | No `createMentalModel` or mental model management |
| **Observation Scopes** | ❌ Missing | No `observation_scopes` configuration |
| **Per-Operation LLM Override** | ❌ Missing | Uses single `HINDSIGHT_API_LLM_MODEL` for all operations |
| **LLM Model Choice** | ⚠️ Suboptimal | Uses `@cf/openai/gpt-oss-120b` via CF AI Gateway — NOT the leaderboard winner |
| **Docker Pin** | ⚠️ Risky | `FROM ghcr.io/vectorize-io/hindsight:latest` — unpinned |
| **`include` Options** | ❌ Missing | No `include.entities`, `include.chunks`, `include.source_facts` on recall |
| **`response_schema`** | ❌ Missing | No structured output on reflect |
| **`query_timestamp`** | ⚠️ Passed through | Schema typed but recall doesn't default to `now()` |

---

## What Fold Gets Right (That HAETSAL Gets Wrong)

### 1. Correct API Contract
Fold's [client.ts](file:///c:/Users/matth/Documents/Fold/apps/brain/src/hindsight/client.ts) hits the **real** Hindsight API:
```typescript
// Fold (CORRECT)
retain(bankId: string, body: RetainRequest): Promise<HindsightJson> {
    return this.post(`/v1/default/banks/${encodeURIComponent(bankId)}/memories`, body);
}

// HAETSAL (WRONG — 404)
getHindsightStub(tenantId, env).fetch('http://hindsight/api/retain', { ... })
```

### 2. Correct Type System
Fold's [types.ts](file:///c:/Users/matth/Documents/Fold/apps/brain/src/hindsight/types.ts) matches the real API:
```typescript
// Fold (CORRECT)
export interface RetainItem {
    content: string;        // plaintext!
    context?: string;       // extraction quality signal
    document_id?: string;   // stable upsert ID
    timestamp?: string;     // ISO 8601
    tags?: string[];        // multi-tenant isolation
    metadata?: Record<string, unknown>;
}

// HAETSAL (FABRICATED)
export interface HindsightRetainRequest {
    content_encrypted: string;  // NOT REAL
    memory_type: 'episodic' | 'semantic' | 'procedural';  // NOT REAL
    domain: string;             // NOT REAL
    salience_tier: number;      // NOT REAL
}
```

### 3. Correct Container Config
```typescript
// Fold (CORRECT)
const HINDSIGHT_PORT = 8888;
export class HindsightContainer extends Container<Env> {
    defaultPort = HINDSIGHT_PORT;
    async fetch(request: Request) {
        await this.startAndWaitForPorts({ ports: HINDSIGHT_PORT, ... });
        return this.containerFetch(request, HINDSIGHT_PORT);
    }
}

// HAETSAL (WRONG)
defaultPort = 8080; // Hindsight is on 8888
// No startAndWaitForPorts, no retry logic
```

### 4. Queue-Based Async Retain
Fold correctly separates the tool response from Hindsight processing:
- Tool → validates → `RETAIN_QUEUE.send()` → returns `"queued"` immediately
- Queue consumer → `client.retain()` → ack/retry

This follows the best practice: "Do not retain and recall in the same turn."

### 5. Layer A/B Governance
Fold adds financial-domain-specific gates that Hindsight doesn't provide natively:
- **Layer A**: Procedural memory gate (blocks rules from being retained)
- **Layer B**: PII detection, vocabulary tagging, access control

---

## Where Fold Has Gaps

### ❌ Gap 1: No Bank Configuration (CRITICAL)

> "Misconfigured missions are the **single biggest cause of low-quality memories**." — [Best Practices](https://hindsight.vectorize.io/best-practices)

Fold creates banks implicitly (auto-created on first use) but **never configures them**. Zero search results for `createBank`, `retain_mission`, `observations_mission`, `reflect_mission`, or `disposition` anywhere in the Fold codebase.

**Impact**: The LLM has no domain-specific guidance for fact extraction. It doesn't know:
- What facts to extract vs ignore
- What patterns to synthesize as observations
- What persona to adopt for reflect responses

**Fix**: Add a bank provisioning step that runs before first retain per company/user:
```typescript
await client.createBank(bankId, {
    retain_mission: "Extract financial decisions, budget constraints, revenue targets, client preferences, and deal stage changes. Ignore pleasantries and scheduling logistics.",
    observations_mission: "Identify evolving deal patterns, pipeline shifts, recurring objections, and contradictions with prior forecasts.",
    reflect_mission: "You are a senior financial analyst with full context of this company's deal history. Be direct, data-driven, and opinionated about forecast accuracy.",
    disposition: { skepticism: 4, literalism: 4, empathy: 2 },
});
```

---

### ❌ Gap 2: No Per-Operation LLM Override

Fold uses a **single model for everything** (`@cf/openai/gpt-oss-120b` via Cloudflare AI Gateway). The env builder only passes:
```typescript
const HINDSIGHT_OPTIONAL_ENV = [
    "HINDSIGHT_API_LLM_PROVIDER",
    "HINDSIGHT_API_LLM_API_KEY",
    "HINDSIGHT_API_LLM_MODEL",
    "HINDSIGHT_API_LLM_EXTRA_BODY",
] as const;
```

**Missing**: `HINDSIGHT_API_RETAIN_LLM_*` and `HINDSIGHT_API_REFLECT_LLM_*` overrides.

**Impact**: Retain (structured extraction) and reflect (synthesis) have different quality profiles. The leaderboard shows:
- **Retain #1**: `openai/gpt-oss-20b` (smaller, faster, cheaper = 91.7 cost score)
- **Reflect #1**: `openai/gpt-oss-120b` (larger, better quality = 94.2%)

Fold is currently using the expensive 120b model for all operations when the smaller 20b is actually **ranked higher for retain**.

---

### ⚠️ Gap 3: LLM Model Choice Is Suboptimal

Fold uses:
```toml
HINDSIGHT_API_LLM_PROVIDER = "openai"
HINDSIGHT_API_LLM_MODEL = "@cf/openai/gpt-oss-120b"
```

This routes through Cloudflare's AI Gateway (`provider=openai` + `base_url=CF API`), **not through Groq directly**. The leaderboard benchmarks were run against Groq infrastructure. Cloudflare's AI Gateway may add latency and could have different model versions.

Also, the `@cf/` prefix is a Workers AI convention — it's unclear if Hindsight handles this prefix correctly (the docs show model names without it: `openai/gpt-oss-120b`).

**Recommendation**: Use `provider=groq` with direct Groq API key for leaderboard-benchmarked performance, or at minimum verify the `@cf/` prefix works.

---

### ❌ Gap 4: No Entity Labels

Hindsight's entity labels provide **controlled vocabulary auto-classification** — the LLM classifies facts into your defined taxonomy and writes them as filterable tags. This is a perfect fit for Fold's financial domain:

```json
{
    "entity_labels": [
        {
            "key": "deal_stage",
            "type": "value",
            "tag": true,
            "values": [
                {"value": "prospecting", "description": "Early-stage lead qualification"},
                {"value": "negotiation", "description": "Active deal negotiation"},
                {"value": "closed_won", "description": "Deal successfully closed"}
            ]
        },
        {
            "key": "financial_metric",
            "type": "multi-values",
            "tag": true,
            "values": [
                {"value": "revenue", "description": "Revenue figures or targets"},
                {"value": "margin", "description": "Profit margin data"},
                {"value": "churn", "description": "Customer churn metrics"}
            ]
        }
    ]
}
```

**Impact**: Without entity labels, all memories are undifferentiated. You can't filter recall to "only deal_stage:negotiation memories" at the database level.

---

### ❌ Gap 5: No Mental Models

Mental models are **pre-computed reflect responses** that return in sub-100ms. Perfect for Fold's use case:

```typescript
// "Company Profile" - refreshed after each consolidation
await client.createMentalModel(bankId, {
    name: "Company Financial Profile",
    source_query: "Summarize this company's financial position, active deals, revenue targets, and key risks.",
    tags: [`company:${companyId}`],
    trigger: { refresh_after_consolidation: true },
});
```

**Impact**: Every reflect call currently hits the full LLM pipeline. For common queries ("What's the pipeline status?"), mental models would be instant.

---

### ⚠️ Gap 6: Unpinned Docker Image

```dockerfile
FROM ghcr.io/vectorize-io/hindsight:latest  # ← breaks on any release
```

HAETSAL at least pinned to `0.4.16-slim` (wrong version, but at least stable). Fold uses `latest`, which means any Hindsight release could silently change behavior.

**Fix**: Pin to `ghcr.io/vectorize-io/hindsight:0.5.2-slim` (or whatever the current stable is).

---

### ❌ Gap 7: No `include` Options on Recall

Fold's `RecallRequest` doesn't expose `include.entities`, `include.chunks`, or `include.source_facts`. These return rich metadata with recalled memories:
- `include.entities` — returns extracted entity values with each memory
- `include.source_facts` — returns the raw facts that matched
- `include.chunks` — returns the original content chunks

**Impact**: Fold gets back bare memory text without the entity graph. For financial use cases, knowing which entities (companies, metrics, deal stages) matched would be valuable for UI display and downstream processing.

---

## Summary: Fold vs HAETSAL vs Best Practice

| Capability | HAETSAL | Fold | Best Practice |
|---|:---:|:---:|:---:|
| Correct API routes | ❌ | ✅ | `/v1/default/banks/{id}/memories` |
| Correct port (8888) | ❌ | ✅ | 8888 |
| Plaintext content | ❌ | ✅ | Required |
| Container retry logic | ❌ | ✅ | `startAndWaitForPorts` |
| Reflect tool | ❌ | ✅ | First-class operation |
| Tags & tag_groups | ❌ | ✅ | Multi-tenant isolation |
| document_id (dedup) | ❌ | ✅ | Stable session IDs |
| context field | ❌ | ✅ | "Always set it" |
| Budget control | ❌ | ✅ | low/mid/high |
| Queue-based async | ❌ | ✅ | Don't retain+recall same turn |
| Official SDK | ❌ | ⚠️ Custom client | `@vectorize-io/hindsight-client` |
| Bank missions | ❌ | ❌ | "Single biggest cause of low-quality" |
| Entity labels | ❌ | ❌ | Controlled vocabulary classification |
| Mental models | ❌ | ❌ | Sub-100ms pre-computed answers |
| Per-operation LLM | ❌ | ❌ | Different models for retain vs reflect |
| Leaderboard LLM choice | ❌ | ⚠️ Close | Groq direct, not via CF Gateway |
| Observation scopes | ❌ | ❌ | Per-tag pattern synthesis |
| include options (recall) | ❌ | ❌ | Entities, chunks, source facts |
| response_schema (reflect) | ❌ | ❌ | Structured output |
| Pinned Docker version | ⚠️ Pinned wrong | ❌ | Pin to specific version |

---

## Verdict

**Fold gets the fundamentals right** — it talks to the real API, sends plaintext, uses the correct port, has retry logic, and implements all three operations (retain/recall/reflect). It avoided every single one of HAETSAL's 7 fatal violations.

**But Fold is ~60% of what a production Hindsight integration should be.** The gaps cluster around **configuration and optimization**, not connectivity:

1. **Bank missions** — the most impactful gap. Without them, fact extraction quality is generic.
2. **Per-operation LLM override** — leaving performance and cost on the table.
3. **Entity labels** — the feature Fold's financial domain needs most.
4. **Mental models** — the feature that would make Fold's reflect blazing fast.

These are all additive — Fold's existing code doesn't need to be rewritten, just extended. HAETSAL needs a ground-up rebuild.
