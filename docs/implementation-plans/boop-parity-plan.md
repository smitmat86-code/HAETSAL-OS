# boop-agent Feature Parity Plan (Plan B)

Date: 2026-05-31
Status: Planning — awaiting approval
Reference: github.com/raroque/boop-agent. Companion: `docs/implementation-plans/cloudflare-modernization-plan.md` (Plan A).

## Purpose

Reach **like-for-like-or-better** user-facing capability versus boop-agent,
**without regressing** anything HAETSAL already does better. boop is the
capability checklist, not the architecture.

- **In scope:** new product behavior — reasoning quality, real external actions,
  integration breadth, new channel, user automations, sub-agents, memory
  features, multimodal input, operability surfaces.
- **Out of scope:** infrastructure currency and primitive adoption — that is
  **Plan A**. This plan consumes Plan A primitives but does not specify them.

## Separation Principle

Plan A = "modern substrate, same behavior." Plan B (this doc) = "new behavior."
Where a workstream needs a primitive (sub-agents, scheduling, durable approval),
it references the Plan A workstream that delivers it.

## Locked Decisions (2026-05-31)

1. **Integrations = Hybrid.** First-party encrypted-token custody for sensitive
   toolkits; Composio only for low-sensitivity, behind a documented Law 2
   carve-out; ALL integrations stay behind the action authorization gate.
2. **Models = Tiered via AI Gateway.** Cheap Workers AI for routing; strong
   Workers AI for consolidation; **frontier (Claude/OpenAI) via gateway + Secrets
   Store BYOK** for high-stakes reasoning. Cloudflare Agents SDK is the framework
   (NOT the Claude Agent SDK).
3. **Subscription economics live in the interactive lane.** Autonomous/serverless
   work uses API/Workers AI via gateway (metered); the existing `brain-memory`
   external-client surface (specs 9.3/9.4) lets you drive Claude Code/Codex under
   your own subscription against the same brain.

## What HAETSAL Already Exceeds boop On (DO NOT regress)

| Area | HAETSAL advantage |
|---|---|
| Memory | Hindsight 4 epistemic types + Graphiti graph + 4-pass consolidation |
| Security | CF Access JWT, TMK/KEK, zero-knowledge AES-GCM, multi-tenant, Laws |
| Action safety | GREEN/YELLOW/RED + HMAC + TOCTOU + 5-min undo + approval UI |
| Ops | Serverless edge (no laptop), spec lifecycle, governance |
| Persistence | D1 + R2 + KV + Vectorize + Queues + Workflows + Containers |

These are the crown jewels. Every workstream below must preserve them.

## Parity Gap Summary (boop has, HAETSAL lacks/partial)

Reasoning quality · real external actions (stubs) · integration breadth ·
user-defined automations · memory decay · multimodal image input · richer
operability dashboard · working cost surfacing · live agent cancel/retry ·
Sendblue/iMessage channel.

---

## WS1 — Reasoning quality (frontier tier)

boop runs Claude/GPT-class reasoning; HAETSAL runs one open model.

- **[MODIFY]** extend Plan A's `selectModel(task, stakes)` so high-stakes agent
  turns (Chief of Staff, Career Coach) route to **frontier (Claude/OpenAI) via
  `haetsal-brain-gateway`** with Secrets Store BYOK + budget caps.
- **Law 2:** only minimal decrypted-in-DO context leaves the DO; never raw
  encrypted memory.
- **Depends on:** Plan A WS3 (gateway hardening + selectModel seam).
- **Acceptance:** Chief-of-Staff turn measurably better on a fixed eval; budget
  ceilings enforced; cheap tier still handles routing.

## WS2 — Real external actions (wire the stubs)

Per as-built inventory, `act_send_message`, `act_draft`, `act_search`,
`act_remind`, `act_run_playbook` are STUBS (calendar create/modify + browse are real).

- **[MODIFY]** wire real executors behind the existing auth gate:
  - email send + draft (first-party Gmail; OAuth tokens already encrypted in KV)
  - SMS send (channel layer)
  - web search (`act_search`)
  - reminders (`act_remind`) via Plan A WS5 scheduling
- **KEEP:** authorization gate, HMAC, TOCTOU, undo — actions ride the existing
  safety rail, not around it.
- **Depends on:** Plan A WS6 (durable approval/delay) for IRREVERSIBLE classes.
- **Acceptance:** each tool performs a real, audited, reversible-where-applicable action.

## WS3 — Integration breadth (hybrid)

- **[NEW]** `docs/adr/00xx-composio-law2-carveout.md` — formal Law 2 carve-out:
  Composio sees only low-sensitivity toolkit data; never TMK-encrypted memory,
  core PII, or first-party token material.
- **[NEW]** integration sensitivity tag; sensitive → first-party encrypted-token
  (Slack, messaging, anything touching memory/PII); low-sensitivity → Composio.
- **[NEW]** first-party connectors for the sensitive core (start: Slack); Composio
  adapter for the low-sensitivity set, all routed through the auth gate.
- **Depends on:** Plan A WS3 (Secrets Store for tokens).
- **Acceptance:** ≥1 first-party + ≥1 Composio integration live, both gated; ADR merged.

## WS4 — Sendblue messaging channel (boop's approach)

boop uses Sendblue (iMessage + RCS/SMS fallback, no A2P registration).

- **[NEW]** `src/services/delivery/sendblue.ts` + `POST /sendblue/webhook` ingress,
  folded into the existing channel abstraction (`processInboundMessage(..., 'sendblue')`).
- **Law 2:** not a regression vs Telnyx — both see plaintext in transit; at-rest
  encryption boundary unchanged.
- **Decision flag:** add Sendblue as primary personal channel; keep Telnyx/Telegram
  via the same abstraction (no rip-out).
- **Depends on:** Plan A WS3 (Secrets Store for Sendblue key).
- **Acceptance:** inbound iMessage routes through the brain; outbound replies deliver.

## WS5 — User-defined automations

boop lets the user create recurring tasks by chat; HAETSAL has only fixed crons.

- **[NEW]** automation CRUD tools (`create_automation`, `list`, `toggle`, `delete`)
  on `this.schedule()` (Plan A WS5), timezone-aware, each firing a scoped agent run.
- **Depends on:** Plan A WS5 (scheduling primitive), WS6 (sub-agents) optional.
- **Acceptance:** "every Monday 9am, brief me on X" creates a durable per-tenant schedule.

## WS6 — Sub-agent spawn + cancel/retry

HAETSAL delegation is a text signal, not a real spawn; no live cancel/retry.

- **[MODIFY]** replace `parseDelegation()` signal with native `subAgent()` spawn +
  per-spawn tool scoping; expose cancel/retry.
- **Depends on:** Plan A WS1 (0.13.x `subAgent`/`agentTool`).
- **Acceptance:** Chief of Staff programmatically spawns a scoped domain agent;
  running agents are cancellable/retryable.

## WS7 — Memory decay + per-turn extraction

boop has adaptive decay/forgetting + post-turn fact extraction; HAETSAL has neither
(confirmed: Hindsight retains internally, no active forgetting).

- **[NEW]** decay/forgetting pass (importance + access-count reinforcement;
  archive/prune thresholds), respecting Law 2 (operate on metadata + encrypted refs).
- **[NEW]** optional real-time per-turn extraction into the canonical capture path
  (complements nightly consolidation).
- **Depends on:** none hard.
- **Acceptance:** low-value memories decay/archive; per-turn facts captured.

## WS8 — Multimodal image input

boop ingests photos and extracts image-description memories.

- **[NEW]** Telegram (and Sendblue) photo ingestion → vision model
  (`kimi-k2.6` / `gemma-4-26b`) → canonical capture.
- **Depends on:** WS1 (model selection) for a vision-capable model.
- **Acceptance:** a texted photo produces a provenance-tagged memory.

## WS9 — Operability parity

boop's dashboard has 8 panels; HAETSAL's Pages UI has 3 (approval-focused).

- **[NEW]** dashboard panels: memory browser + graph, agent timeline (with
  cancel/retry from WS6), consolidation reasoning viewer, automations manager
  (WS5), connections/integrations manager (WS3).
- **[MODIFY]** surface the populated cost data (Plan A WS3) in a usage panel.
- **Depends on:** Plan A WS3 (cost data), WS6 (agent control), WS5 (automations).
- **Acceptance:** operator can see/manage memory, agents, automations, connections, cost.

---

## Dependencies on Plan A

| Plan B WS | Needs from Plan A |
|---|---|
| WS1 reasoning | WS3 gateway + selectModel |
| WS2 actions | WS6 durable approval; WS3 Secrets Store |
| WS3 integrations | WS3 Secrets Store |
| WS4 Sendblue | WS3 Secrets Store |
| WS5 automations | WS5 scheduling |
| WS6 sub-agents | WS1 SDK 0.13.x |
| WS8 multimodal | WS1 reasoning (vision model) |
| WS9 dashboard | WS3 cost data; WS5; WS6 |

Plan B can begin WS3/WS4/WS7 with minimal Plan A; WS1/WS5/WS6/WS9 are materially
cheaper after Plan A lands. Recommended: Plan A WS0–WS3 first, then interleave.

## Out of Scope (→ Plan A)

Agents SDK upgrade, native primitive adoption, data-plane modernization,
compatibility date, Vectorize V2, Neon/VPC, observability rewrite, Browser Run
migration. Those are substrate and belong to Plan A.
