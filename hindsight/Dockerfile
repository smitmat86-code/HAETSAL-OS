# Hindsight Container — Distroless build
# Pinned to v0.4.16 (2026-03-09) — latest stable release
# Contains: schema migration threading fix, GIN index on source_memory_ids,
#            Dependabot security fixes, webhook system
# Verify on Neon branch before upgrading — diff Hindsight migrations first

FROM ghcr.io/vectorize-io/hindsight:v0.4.16 AS base
# Distroless — no shell, no package manager, cold start target <500ms
FROM gcr.io/distroless/base-debian12
COPY --from=base /hindsight /hindsight
EXPOSE 8080
ENTRYPOINT ["/hindsight"]
