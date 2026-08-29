-- Separate artifact integrity incidents from provider delivery ambiguity.
-- Content-free operational metadata only. Expand-only and fully compatible
-- with the currently deployed Worker, which ignores the new column.
-- delivery_unknown remains reserved for genuine provider ambiguity: a
-- provider call may have occurred but its outcome cannot be determined.
-- This migration must NOT be applied remotely in this session.

-- integrity_recorded_at carries the incident audit timestamp so recording an
-- incident never has to touch updated_at, which delivery-claim ambiguity
-- recovery uses as a boundary, and never clears an active lease.

ALTER TABLE channel_media_jobs ADD COLUMN integrity_status TEXT;
ALTER TABLE channel_media_jobs ADD COLUMN integrity_recorded_at INTEGER;
