# 14.4: Chat model swap + LLM classifier removal (research-driven)

Date: 2026-07-06. Prompted by the same-day 258-second reply incident
(`docs/lessons/phase-14-telegram-incident.md`).

## The finding

A 5.6M-token deep-research pass (105 agents, 25 verified claims) confirmed
the hypothesis: **reasoning models legitimately return empty responses**
when hidden `<think>` tokens exhaust `max_tokens`. Documented across
OpenAI o-series (official docs), Claude extended thinking, Gemini
thinking, DeepSeek R1 — same class as `gemma-4-26b-a4b-it`.
OpenAI's guide states verbatim: "This might occur before any visible
output tokens are produced." That's exactly what our
`GATEWAY_CHAT_EMPTY` logs record.

The research also flagged a **structural anti-pattern** in our pipeline:
LLM-based classifier calls (intent/delegation) sit **inside** a pipeline
that already knows its own intent. Semantic routing belongs at the front
door of a general assistant where requests are unlabeled — not bolted
onto internal fan-out. TrueFoundry: *"if the caller can set a header
like x-task=classify, that is free, deterministic, and better."* Every
gateway blip on the classifier call multiplied by the number of
classifiers in the chain — direct cause of the 258 s wall clock (three
empties × ~one minute of retries each).

## The change

Two files, both surgical:

- **`src/config/models.ts`**: `MODEL_CHAT` = `llama-3.3-70b-instruct-fp8-fast`
  (standard instruction-tuned, function calling, 24 K context,
  production-labeled). Now equals `MODEL_DEEP` by intent — the
  "cheap chat tier vs deep tier" distinction was premature optimization.
  Comment records the reasoning-model empty-response failure mode.
- **`src/services/agents/delegation.ts`**: `decideDelegation` is now pure
  synchronous pattern-only (regex → delegate; else inline). LLM
  classifier fallback deleted. Header comment records the removal date +
  rationale.

## What we deliberately did NOT change

Following the research's "ladder" principle — each rung justified by
measured benefit, not adopted for its own sake:

- **`MODEL_VISION` stays `gemma-4-26b-a4b-it`**: research recommended
  `llama-3.2-11b-vision-instruct`, but that model is on `RETIRED_MODELS`
  (Cloudflare pulled it 2026-05-30; postflight would reject the swap).
  Photo path rides `waitUntil` (latency not user-facing) and has zero
  measured empty-response failures. Re-evaluate when a production-
  labeled vision-specialized replacement lands.
- **`MODEL_DEEP` unchanged**: dream cycle isn't user-facing; swap to a
  reasoning specialist (DeepSeek R1) is a follow-up when we measure the
  quality gap on synthesis.
- **`max_tokens` default unchanged**: 512 was tight *because gemma-4
  burned budget on `<think>` tokens*. Non-reasoning primary shouldn't
  have that problem. Raise only if we measure it.
- **No fallback cascade** to `MODEL_DEEP` on empty: adding this before
  measuring the failure rate on the new primary would be engineering
  a fix for a problem we've probably already solved.

## Contract

Delegation is now honest: **pattern-first with no LLM fallback**. Long
ambiguous asks default INLINE (conservative). If the pattern set proves
too narrow after a week of use, the right move is to widen the regexes
(free, deterministic, measurable) or — if truly needed — put semantic
routing at the *webhook* front door, once, before enqueue.

## Expected effect

- One inbound message → **one model call** (grounded reply), not three.
- Non-reasoning primary → no `<think>`-token exhaustion → `GATEWAY_CHAT_EMPTY`
  should approach zero on the chat path.
- Wall time from message to reply: expected seconds, not minutes.

Verify by sending a Telegram message and checking that only one
`brain-priority-high` invocation fires per user message with no
`GATEWAY_CHAT_EMPTY` warnings.
