-- Migration: Add minEventDurationMinutes column to carparks table
ALTER TABLE carparks ADD COLUMN minEventDurationMinutes INT DEFAULT 5; 