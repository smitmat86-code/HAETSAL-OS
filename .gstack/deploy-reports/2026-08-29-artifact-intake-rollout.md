# LAND & DEPLOY REPORT

PRs: #2 correction, #3/#4 D1 migration compatibility, #5 activation

- Branches: `codex/artifact-rollout-repair` and rollout follow-ups → `master`
- Final merge SHA: `fce3d0f9b927d7aa876f567457fcdae01e001394`
- Merge path: direct squash
- First run: no, prior deploy configuration confirmed
- CI: no GitHub checks configured; local suite passed 717 with 1 intentional skip
- Reviews: inline pre-landing release checklist passed
- Deploy: Cloudflare Worker `112facd4-4903-464e-986a-7cfe4af2635a` at 100%
- Migrations: D1 1033–1038 applied
- Staging: not configured
- Verification: healthy
- Scope: backend, data migration, configuration, documentation
- Canary: 7/7, artifact probe `artifact_ok` in 5,318 ms
- Admission: open
- Immutable audit: 10/10 finalized managed rows valid, 0 pending repairs
- Approved repair: 9/9 completed under digest `fd8a286120fdec799bea0dfb622f6a4ff84a7fecb62974a1212ee64cc7425314`
- Retention proof: 9/9 original R2 objects matched exact ciphertext length and SHA-256
- Rollback tag: `rollback-artifact-intake-pre-v0.1.0-20260829`
- Previous Worker: `bc5b4e08-6344-4df7-b7ae-a451371486a2`
- Compatibility Worker: `02e7e971-f749-4ac9-ab3a-849a7920bee7`

VERDICT: DEPLOYED AND VERIFIED
