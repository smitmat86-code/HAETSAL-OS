---
description: Run the repo checkout workflow and, when requested, close out the current spec
---

# /checkout

Use this command whenever a session is ready for final verification, closeout,
or commit.

Default behavior:

1. Run `npm run checkout`
2. Report any failures and fix them before claiming the session is complete

If the user is finishing a spec in the same session:

1. Ensure `SESSION_LOG.md` is already updated
2. Run `npm run checkout -- --spec <spec-file>.md --move-spec`
3. Report the result, including whether the spec was moved to `specs/completed/`

Do not invent a second checkout path. This slash command is only a friendly
entrypoint to the repo-enforced `npm run checkout` workflow.
