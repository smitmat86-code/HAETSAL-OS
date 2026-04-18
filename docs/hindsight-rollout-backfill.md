# Hindsight Rollout And Backfill Notes

## Current State

HAETSAL's Hindsight integration was corrected to use the official bank-scoped v1 API, plaintext retain/recall/reflect payloads, and the current container port/runtime expectations.

This means new traffic now goes to the right Hindsight surface, but older Hindsight writes made through the fabricated `/api/*` contract should not be treated as trustworthy memory state.

## Operational Assumptions

- `tenants.hindsight_tenant_id` is the canonical Hindsight bank id.
- Live retain/recall/reflect now resolve `tenantId -> hindsight_tenant_id` before calling Hindsight.
- Weekly synthesis now uses Hindsight `reflect` rather than separate recall plus Workers AI summarization.
- HAETSAL-owned archival encryption remains valid for R2 STONE and observability traces.

## Legacy Data Risk

Treat pre-fix Hindsight content as invalid or incomplete for these reasons:

- older writes targeted fabricated `/api/retain`, `/api/recall`, and `/api/tenants` paths
- payloads were shaped as encrypted pseudo-contracts instead of official Hindsight requests
- bank provisioning and live memory traffic could drift into different ids

As a result, old Hindsight state may be missing, malformed, duplicated, or written to the wrong logical bank.

## Backfill Policy

Use source-of-truth rehydration rather than trying to salvage the broken Hindsight state.

Preferred backfill order:

1. Gmail history
2. Calendar history
3. Drive / Obsidian knowledge artifacts
4. New live ingress after cutover

Do not attempt blind re-import from encrypted R2 STONE artifacts unless there is a deliberate recovery workflow that can safely decrypt, validate provenance, and remap documents to the correct bank.

## Recommended Rollout Steps

1. Deploy the corrected Hindsight integration.
2. Verify tenant bootstrap provisions the configured bank and mental models successfully.
3. Run a smoke check for one tenant:
   retain -> recall -> reflect -> weekly synthesis.
4. Select a tenant for controlled rehydration from authoritative sources.
5. Compare recall quality before and after backfill.
6. Rehydrate remaining completed tenants in batches.

## Post-Deploy Smoke Prerequisites

The deployed worker exposes two different verification paths:

- public routes like `/hindsight/webhook` should be reachable and reject unsigned traffic with `403`
- protected routes like `/mcp` and `/ws` require a valid Cloudflare Access session, JWT, or service-token-backed path

That means an anonymous probe can confirm the worker is live and the webhook edge is enforcing HMAC, but it cannot complete the retain -> recall -> reflect flow by itself.

Before the final smoke run, have one of these available:

1. a valid `CF-Access-Jwt-Assertion` for a real tenant session
2. a browser session already authenticated through Cloudflare Access
3. a service-token path that is explicitly allowed to reach the protected worker routes

Until one of those is available, the post-deploy smoke step should stay marked as pending rather than silently assumed complete.

For the current `full + Neon + AI Gateway BYOK` runtime, also confirm:

1. Cloudflare AI Gateway `haetsal-brain-gateway` exists in account `d3f0a1c579945862edc9c6f6e36e448a`
2. the gateway has a BYOK Groq provider configured
3. the Worker secret `AI_GATEWAY_TOKEN` is set for gateway authentication
4. the Worker secret `NEON_CONNECTION_STRING` is set for direct container database access

Without those, the Hindsight container can start with local embeddings and reranker available, but LLM-backed retain and reflect operations will still fail.

Current runtime behavior is intentional:

- if `AI_GATEWAY_TOKEN` is present, Hindsight uses AI Gateway compat with Groq models
- if `AI_GATEWAY_TOKEN` is missing, Hindsight falls back to `LLM=none` so the container does not crash-loop during deploys
- `NEON_CONNECTION_STRING` is now the required production database path for the Hindsight container

## User-Facing Implication

Users may have incomplete historical memory continuity until backfill completes.

That should be described internally as a migration artifact, not as user error or random memory loss.

## Follow-Up Work

- add an operator-visible backfill checklist or runbook
- consider a per-tenant `hindsight_backfilled_at` marker in D1
- consider a temporary admin endpoint or workflow trigger for controlled rehydration
