# 4. Nights & weekends: what it does on its own

> **In plain terms:** The brain has a clock. Every minute it checks your
> Obsidian drop folder; every night at 2am it "dreams" — reviewing the
> day's memories, proposing cleanups, flagging contradictions for you (it
> never silently rewrites anything); at 7am it sends your morning brief
> including what it did overnight; Friday afternoon it writes a weekly
> reflection; and every hour it runs a self-check so *it* notices
> breakage before you do.

## The schedule

| When (default tz) | What | What you see |
|---|---|---|
| Every minute | Obsidian `/to-brain/` folder poll | Dropped notes appear in memory within ~1 min |
| Every 15 min | Obsidian vault scan for `brain: true` notes | Tagged notes stay in sync |
| Hourly (the :00 tick of the 15-min slot) | **Canary sweep** — 6 self-probes | Nothing, unless something breaks |
| Every 30 min, 8am–8pm | Predictive heartbeat | Occasional proactive nudges |
| **2:00 am daily** | **Dream cycle** | Review inbox items + tomorrow's brief section |
| **7:00 am daily** | **Morning brief** | The brief, in Telegram |
| 5:00 pm Friday | Weekly synthesis | A reflective weekly write-up |

Your **automations** run on their own timers, separate from this table —
each one is its own alarm, timezone-correct (America/Los_Angeles default,
DST-safe), firing exactly when you asked.

## The dream cycle (2am)

The nightly consolidation does four things, in order, as a durable
workflow (it survives restarts mid-run):

1. **Extract**: review recent captures for consolidation-worthy patterns.
2. **Propose**: file proposals — merges, contradictions, gap-fills — into
   the **review inbox**. Nothing is applied. A contradiction between two
   memories becomes a question for you, not a coin-flip by the model.
   Proposals you've already decided are never re-filed.
3. **Report**: write "what I did last night" as a governed memory — this
   becomes the **"While You Slept"** section of the morning brief.
4. **Decay pass**: re-score recent memories (importance × access — see
   [chapter 6](06-memory-model.md)); rarely-used old cron-noise sinks,
   things you actually retrieve get reinforced. Soft states only — nothing
   is deleted.

## The canaries (hourly)

Six probes exercise the real paths end-to-end: capture, recall, graph,
contradiction-surface, compiled-page read, session-evidence retrieval.
Results land as content-free pass/fail rows you can check on demand
(`/api/dream/canary/latest`). This is the "is the brain actually working
right now?" answer that doesn't wait for you to notice a bad reply.

---

## Under the hood

- **Dispatch**: one `scheduled()` handler
  (`src/workers/mcpagent/runtime.ts:30`) switches on the cron expression —
  six triggers configured in `wrangler.toml [triggers]`. The canary sweep
  piggybacks the `*/15` slot and self-gates to the top-of-hour tick
  (`src/cron/canary.ts`).
- **Dream cycle**: `src/workflows/dream-cycle.ts`, a Cloudflare Workflow
  (`brain-dream-cycle`). Law 2 shaped its structure: Workflows persist
  every `step.do()` return value into engine storage, so **all plaintext
  handling lives inside a single step** whose return is counts/ids only,
  and the run is flagged `sensitive: 'output'`. The report body is sealed
  under the **Cron KEK** (the scheduled-job key — [chapter 7](07-security.md));
  run metadata goes to D1 `dream_runs`. The decay step runs in its own
  try/catch so a decay failure can't kill a completed dream.
- **Why 2am is a workflow but automations are DO alarms**: the dream is
  one heavy, multi-step, must-complete job (durable workflow); automations
  are many small, per-user timers — each automation re-arms a one-shot
  Durable Object alarm (`src/workers/mcpagent/do/automation-runtime.ts`),
  computing the *next* local-time occurrence each fire. One-shot re-arming
  (not fixed UTC cron) is what makes them DST-correct.
- **Morning brief**: `src/cron/morning-brief.ts` assembles sections
  (including `src/services/dream/brief-section.ts` reading last night's
  completed run) and delivers via your primary channel; the brief itself
  is archived to memory.
- **Heartbeat**: `src/cron/heartbeat.ts` — bounded to 8am–8pm so the brain
  doesn't nudge you at 3am.
- **Canary results**: D1 `canary_runs` — probe name + ok + latency only
  (the `note` field carries only synthetic status strings and is excluded
  from persistence regardless).

## Why it's built this way

Two principles. **Report, don't rewrite**: overnight autonomy is safe
because it's *proposal-only* — the value of consolidation with none of
the "the AI quietly rewrote my memory" risk. **Self-checking beats
monitoring**: the canary probes test the same code paths your real
queries use, per-tenant, hourly — so "memory is broken" is a dashboard
fact within the hour, not a discovery you make mid-conversation a week
later.
