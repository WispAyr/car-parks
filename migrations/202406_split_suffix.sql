-- Add splitSuffix column to parking_events
ALTER TABLE parking_events ADD COLUMN splitSuffix VARCHAR(64) DEFAULT NULL;

-- Drop the old unique constraint (adjust the name if needed)
ALTER TABLE parking_events DROP INDEX unique_parking_event;

-- Add a new unique constraint including splitSuffix
ALTER TABLE parking_events ADD UNIQUE unique_parking_event (siteId, VRM, entryTime, splitSuffix); 