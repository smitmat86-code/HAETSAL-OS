ALTER TABLE hindsight_operations
  ADD COLUMN slow_at INTEGER;

ALTER TABLE hindsight_operations
  ADD COLUMN stuck_at INTEGER;
