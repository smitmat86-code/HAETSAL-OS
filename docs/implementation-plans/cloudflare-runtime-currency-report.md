# Cloudflare Runtime Currency Report

Date: 2026-06-01
Spec: `specs/active/10.2-cloudflare-runtime-currency-upgrade.md`
Implementation tree: `C:\Users\matth\Documents\HAETSAL OS 11.4 deploy`
Branch: `codex/post-hindsight-cloudflare-reconciliation`

## 1. Scope

This pass updated HAETSAL's Cloudflare-facing package and Worker runtime
baseline only. It did not remove Hindsight, add Hyperdrive, add AI Search,
change Agents Sessions/Think behavior, change schemas, deploy, or change memory
read/write behavior.

Pre-existing dirty runtime work was preserved. It was still present after this
session:

- `MANIFEST.md`
- `src/services/bootstrap/hindsight-bank-spec.ts`
- `src/services/canonical-postgres-repository.ts`
- `src/services/external-client-memory-write.ts`
- `src/services/external-client-memory.ts`
- `src/services/hindsight-transport.ts`
- `tests/9.4-brain-memory-external-client-rollout.test.ts`
- `docs/implementation-plans/cloudflare-modernization-assessment-2026-06-01.md`
- `docs/implementation-plans/cloudflare-modernization-execution-plan-2026-06-01.md`

## 2. Package Currency

Versions checked with `npm view` on 2026-06-01.

| Package | Before range | Latest observed | After range | Installed after `npm install` | Notes |
|---|---:|---:|---:|---:|---|
| `wrangler` | `^4.83.0` | `4.95.0` | `^4.95.0` | `4.95.0` | Updated to current latest. |
| `@cloudflare/workers-types` | `^4.20250303.0` | `4.20260601.1` | `^4.20260601.1` | `4.20260601.1` | Updated to current latest. |
| `@cloudflare/vitest-pool-workers` | `^0.14.7` | `0.16.10` | `^0.16.10` | `0.16.10` | Updated to current latest. |
| `@cloudflare/containers` | `^0.3.2` | `0.3.5` | `^0.3.5` | `0.3.5` | Updated to current latest. |
| `@cloudflare/puppeteer` | `^1.0.6` | `1.1.0` | `^1.1.0` | `1.1.0` | Updated to current latest. |
| `agents` | `^0.7.5` | `0.13.3` | `^0.7.9` | `0.7.9` | Latest Zod-3-compatible line. `0.8.0+` requires `zod@^4`; this spec avoided a major non-Cloudflare dependency upgrade. |
| `@neondatabase/serverless` | `^1.1.0` | `1.1.0` | `^1.1.0` | `1.1.0` | Unchanged. |
| `ai` | `^6.0.116` | `6.0.193` | `^6.0.116` | `6.0.168` | Manifest unchanged. Local install resolved within the existing range through the ignored lockfile. |

`npm install` succeeded after narrowing `agents` to `^0.7.9`. The first attempt
with `agents@^0.13.3` failed because `agents@0.13.3` has a peer dependency on
`zod@^4.0.0`, while HAETSAL currently declares `zod@^3.25.76`.

`npm install` changed ignored local dependency artifacts only:

- `node_modules/`
- `package-lock.json`

`package-lock.json` remains ignored by `.gitignore` and untracked by Git. This
session did not force-add it or change the lockfile policy.

NPM reported `6 vulnerabilities (4 moderate, 2 high)` after install. No
`npm audit fix` was run because that would expand the package scope beyond this
runtime-currency spec.

## 3. Compatibility Date

| Setting | Before | After |
|---|---:|---:|
| `compatibility_date` | `2025-01-01` | `2026-06-01` |
| `compatibility_flags` | `["nodejs_compat"]` | `["nodejs_compat"]` |

`nodejs_compat` remains enabled. The updated date follows the execution date
for this session and keeps HAETSAL on Cloudflare's current Workers runtime
baseline before later Hyperdrive, AI Search, and Agents Sessions evaluation.

## 4. Wrangler Validation And Types

Added:

```json
"cf:types": "wrangler types src/types/cloudflare-env.generated.d.ts --include-runtime false"
```

Generated:

- `src/types/cloudflare-env.generated.d.ts`

The generated file includes the current Wrangler bindings for KV, R2, D1,
Vectorize, Analytics Engine, queues, Browser Rendering, AI, Durable Objects,
Container-backed Durable Objects, Workflows, and current `vars`.

Manual `src/types/env.ts` was intentionally left unchanged. Adoption or
replacement of the manual Env type should be a separate refactor because the
manual type includes secret-only fields that are not represented by Wrangler
`vars` and are loaded from `.dev.vars` / Cloudflare secrets.

`npx wrangler deploy --dry-run` was attempted with Wrangler `4.95.0`. Wrangler
bundled the Worker and then stopped because Docker could not be launched to
build the existing configured Container images, even in dry-run mode. No deploy
was performed. Per the spec fallback, `npx wrangler types --help`, `npm run
cf:types`, tests, and postflight were used as the local validation signal.

Official Cloudflare references checked during execution:

- Wrangler `types` command:
  `https://developers.cloudflare.com/workers/wrangler/commands/workers/#types`
- Multi-environment `wrangler types` changelog:
  `https://developers.cloudflare.com/changelog/post/2026-01-13-wrangler-types-multi-environment/`
- Compatibility flags and `nodejs_compat`:
  `https://developers.cloudflare.com/workers/configuration/compatibility-flags/`

## 5. Deferred Product Decisions

Hyperdrive is deferred to the next data-plane spec because adding a binding
changes runtime env shape and should land with canonical Postgres connection
code. No `[[hyperdrive]]` binding was added.

AI Search is deferred to retrieval/indexing specs because instance boundaries,
projection freshness, and retrieval-broker behavior need a product decision
before a binding exists. No AI Search binding was added.

Agents Sessions and Think are deferred to agent-context specs. This session did
not add `@cloudflare/think`, `@cloudflare/ai-chat`, or any session-memory
integration. The current `agents` package was only advanced to the newest line
compatible with the current Zod major.

Hindsight removal is deferred to the removal/replacement specs. Existing
Hindsight containers, bindings, service code, tests, docs, and memory behavior
were not removed.

Containers, Sandboxes, and Workers Mesh were not adopted. Containers remain only
because existing Hindsight and Graphiti runtime paths still reference them.

## 6. Verification

| Command | Result | Notes |
|---|---|---|
| `git status --short --branch` | Passed | On `codex/post-hindsight-cloudflare-reconciliation`; pre-existing dirty runtime work present. |
| `git log -8 --oneline` | Passed | Confirmed 10.2 spec commit on top of reconciliation branch. |
| `npm view ... version` checks | Passed | Current external versions recorded above. |
| `git ls-files package-lock.json` | Passed | Empty output; lockfile remains untracked. |
| `npm install` | Passed after adjustment | `agents@^0.13.3` required Zod 4; `agents@^0.7.9` installed cleanly. |
| `npx wrangler deploy --dry-run` | Blocked by local Docker | Wrangler bundled, then failed because Docker CLI/daemon was unavailable for configured Container image builds. |
| `npx wrangler types --help` | Passed | Confirmed current `wrangler types` options. |
| `npm run cf:types` | Passed | Generated `src/types/cloudflare-env.generated.d.ts`. |
| `npm test` | Passed | 71 test files, 406 passed, 1 skipped. |
| `npx vitest run --dir tests` | Passed | 71 test files, 406 passed, 1 skipped. |
| `npm run postflight` | Passed | `All checks passed - no violations found.` |

## 7. Session-Owned Files

Session-owned changes:

- `package.json`
- `wrangler.toml`
- `src/types/cloudflare-env.generated.d.ts`
- `docs/implementation-plans/cloudflare-runtime-currency-report.md`
- `specs/active/10.2-cloudflare-runtime-currency-upgrade.md`

Ignored local artifacts changed by install:

- `node_modules/`
- `package-lock.json`

