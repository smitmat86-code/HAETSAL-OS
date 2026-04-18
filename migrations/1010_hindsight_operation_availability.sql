ALTER TABLE hindsight_operations
  ADD COLUMN available_at INTEGER;

ALTER TABLE hindsight_operations
  ADD COLUMN availability_source TEXT;

ALTER TABLE hindsight_operations
  ADD COLUMN availability_last_checked_at INTEGER;

ALTER TABLE hindsight_operations
  ADD COLUMN availability_error_message TEXT;
