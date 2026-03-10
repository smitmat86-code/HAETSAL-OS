# Security Reviews

## Workflow

1. **Create** a new review file in `active/` using `TEMPLATE.md`
2. **Name** it: `{type}-{YYYY-MM-DD}.md` (e.g., `pen-test-2026-03-15.md`)
3. **Conduct** the review, documenting findings with severity and exploit paths
4. **Move** to `completed/` when all findings are either fixed or tracked

## Naming Convention

- `pen-test-{date}.md` — Penetration testing
- `{area}-audit-{date}.md` — Focused area audit (e.g., `d1-reliability-audit`)
- `architecture-review-{date}.md` — Architectural review

## Severity Levels

| Level | Meaning |
|-------|---------|
| Critical | Active exploit path, data exposure risk |
| High | Exploitable under specific conditions |
| Medium | Defense-in-depth gap, no direct exploit |
| Low | Best practice deviation, minimal risk |
