-- Separate artifact integrity incidents from provider delivery ambiguity.
-- Content-free operational metadata only. Expand-only and fully compatible
-- with the currently deployed Worker, which ignores the new column.
-- delivery_unknown remains reserved for genuine provider ambiguity: a
-- provider call may have occurred but its outcome cannot be determined.
-- This migration must NOT be applied remotely in this session.

ALTER TABLE channel_media_jobs ADD COLUMN integrity_status TEXT;
