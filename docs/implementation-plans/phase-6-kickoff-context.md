# Phase 6 Kickoff Context (for the Fable session)

Date: 2026-07-03. Written at the end of an Opus session that completed Phases
0–5 + the full Cloudflare modernization sweep. Matt chose to do Phase 6 with
Fable given its complexity (sub-agent orchestration).

## Where things stand
- **Phases 0–5 complete and deployed.** Prod worker `the-brain`, current version
  `3ce1db87`. Branch `haetsal-mission`, HEAD `1b4e6f8`.
- **Agents SDK is on 0.17.0** (migrated this session) — the native sub-agent
  primitives Phase 6 needs are available.
- **Guardrails unchanged**: Three Laws (One Public Face / Zero-Knowledge /
  agents write episodic|semantic|world only). Single-user scope confirmed
  (see cloudflare-capability-review-2026-07-03.md). Commit to `haetsal-mission`
  only; never master/force-push/skip hooks. Gate protocol: checkout green →
  fresh-context verifier → Law-2 audit → prod deploy tagged → smoke.

## Phase 6 scope (from HAETSAL_MISSION.md)
- Replace text-parsed `parseDelegation()` signal with native `subAgent()` spawn
  (Agents SDK current API).
- Per-spawn tool scoping (execution agent only sees the tools it needs).
- Cancel + retry surface exposed to the dashboard.
- Heartbeat with 15-minute stuck-agent auto-fail (boop pattern).
- **Gate:** demo clause 6 (sub-agent visibility + cancel from dashboard) passes
  live.

## SDK-0.17 primitives to build on (verified this session)
- **`subAgent(ChildClass, "name")`** → typed RPC stub; child is a facet with its
  own SQLite/state/schedules inside the parent DO. `abortSubAgent`,
  `deleteSubAgent` for cancel/cleanup.
- **`runAgentTool(ChildClass, { input, maxBudgetMs, detached: { onFinish,
  notify, onMilestones } })`** → run a child as a tool; `detached` = background
  with durable completion; `cancelAgentTool(runId)`; `reportProgress({fraction,
  phase, message})` + durable milestones → maps directly to the dashboard
  cancel/retry + progress surface.
- **`keepAlive()` / `maxBudgetMs`** → the 15-min stuck-agent auto-fail
  (maxBudgetMs default 24h; set to 15m for the heartbeat pattern).
- **Project Think (`@cloudflare/think`)** — opinionated harness that wraps the
  agentic loop + context blocks + tool orchestration. DECISION: evaluate
  adopting it here as a *harness component* for the sub-agents, vs keeping the
  hand-rolled loop. It's Preview, so weigh stability. Do NOT adopt Flue.

## Current agent architecture (what Phase 6 replaces/builds on)
- `src/agents/base-agent.ts` — abstract BaseAgent, hand-rolled model/tool loop
  (callModel uses MODEL_DEEP via the registry), doom-loop guard, Law-3 write
  policy, context-flush budget.
- `src/agents/{chief-of-staff,career-coach,life-coach}.ts` — domain agents.
- `src/services/agents/router.ts` — pattern-first + gemma classifier routing to
  `chief_of_staff | career_coach | life_coach | inline`.
- `parseDelegation()` — the text-parsed delegation signal to replace with
  native `subAgent()`.
- Models are centralized in `src/config/models.ts` (registry) — pick per-spawn
  tiers there (e.g. MODEL_DEEP for reasoning; kimi-k2.7 is the current agentic
  best if tiering up).

## Phase 5 known limitations to keep in mind (not Phase 6 blockers)
- Approved IRREVERSIBLE actions execute immediately (no durable send-delay
  cancel window). Reminder delivery Telegram-first. Both deferred to Phase 13.

## Live-test note
Telegram is the working live channel (Matt's chat registered). Sendblue Free
Tier inbound is unreliable (their side) — use Telegram for live gates. Neon
cold-starts ~3s after idle; retrieval warms it on inbound.
