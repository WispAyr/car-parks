ALTER TABLE parking_events ADD COLUMN status VARCHAR(32) DEFAULT 'pending';
CREATE INDEX idx_parking_events_status ON parking_events(status); 