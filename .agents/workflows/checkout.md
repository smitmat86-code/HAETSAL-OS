---
description: Run the full checkout protocol before marking any spec or session complete
---

# Checkout Protocol

Run every step in order. Do not skip. Do not mark complete until all pass.

Preferred invocation:

- Slash command: `/checkout`
- General closeout: `npm run checkout`
- Spec closeout: `npm run checkout -- --spec 8.1-graphiti-projection-design.md --move-spec`

Run it before the final commit or hand-off, while `SESSION_LOG.md` is still
dirty with the current session entry.

## Step 1: Automated Verification

// turbo
1. Run checkout command: `npm run checkout`

If you are closing a spec in the same session, use:

// turbo
2. `npm run checkout -- --spec 8.1-graphiti-projection-design.md --move-spec`

The checkout command runs postflight, tests, manifest regeneration, spec
lifecycle checks, and the final postflight pass.

## Step 2: THE Brain Self-Check

Answer each. If any apply and fail, fix before proceeding.

- No memory content written to D1, KV, or Analytics Engine
- No plaintext content in audit records
- All cron implementations check for valid Cron KEK before proceeding
- All SQL uses `.bind()` parameterization (no string interpolation)
- All agent traces include `agent_identity` + `tenant_id` + `trace_id` + `parent_trace_id`
- All action proposals include capability class + payload hash
- All state-mutating operations use atomic D1 batch (operation + audit together)
- No LLM calls bypass AI Gateway

Mark items as N/A if the spec didn't touch that area.

## Step 3: Standard Self-Check

- All new files within line limits (enforced by postflight, but verify)
- No `: any` in production code (test files acceptable for PRAGMA results)
- No `eval()` or `new Function()` anywhere
- Route handlers are thin (parse → service → respond)
- Service functions expose agent-callable API (no Request/Response)

## Step 4: Documentation Updates

4. Update LESSONS.md if new edge cases were discovered during implementation
5. Update CONVENTIONS.md if new patterns were established
6. Complete the spec's As-Built Record section (deviations, discovered constraints, file inventory)
7. Check off the spec's Pre-Finalization Checklist
8. Append a SESSION_LOG.md entry
9. Confirm MANIFEST.md was regenerated in Step 1

## Step 5: Spec Lifecycle

10. Move completed spec from `specs/active/` to `specs/completed/`
11. If spec touches Hindsight: verify pin is a real commit hash in `Dockerfile`, `MANIFEST.md`, and `README.md` (not a placeholder)

## Step 6: Final Verification

// turbo
12. The checkout command runs the final postflight after all doc/spec updates.
