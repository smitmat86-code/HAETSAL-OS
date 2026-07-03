# Phase 0 — Baseline Reset Lessons

Date: 2026-07-02

1. **The June 2026 planning docs describe a pre-merge tree.** The baseline report
   (2026-06-01) and its blockers (lockfile drift, vitest contamination, tree choice)
   were all resolved by the 10.x/11.x sessions that followed; the 11.4 lineage was
   merged here via `3bf8006`. When a phase consults those docs, trust the code on
   disk first (`ARCHITECTURE.md` "Authoritative Sources" order applies to plans too).
   Current refreshed inventory: `docs/implementation-plans/mission-phase-0-inventory.md`.

2. **`npm run checkout` mechanics matter at every gate.** It hard-fails unless
   `SESSION_LOG.md` is dirty (append the session entry BEFORE running it), and if
   exactly one file other than `.gitkeep` sits in `specs/active/` it will treat it
   as the finished spec and try to move it to `specs/completed/` (failing if no
   `## As-Built Record`). Keep `specs/active/` empty during mission phases unless a
   phase deliberately carries a spec.

3. **CF API access works headless.** `CLOUDFLARE_API_TOKEN` is set in the shell
   environment; `wrangler whoami`, `wrangler secret list --name the-brain`, and
   direct `api.cloudflare.com` GETs (Access apps/policies) all authenticate. The
   403 recorded in the 2026-06-01 token-hygiene snapshot is stale. Use
   `Invoke-RestMethod` with the env var — never echo the token.

4. **Split-brain files need function-level severance.** `services/hindsight.ts`,
   `hindsight-client.ts`, `tools/memory.ts`, `cron/weekly-synthesis.ts`, and
   `cron/passes/pass2-bridges.ts` each carry both write-path (Phase 1) and
   read-path (Phase 2) Hindsight surface. Phase 1 must split these files, not
   delete them, or Phase 2's read path breaks early.
